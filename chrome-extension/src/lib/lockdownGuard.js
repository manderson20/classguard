// Lockdown Browser for tests — tab/window enforcement layer.
//
// declarativeNetRequest (rules.js) only filters network requests; it has no
// concept of tabs or windows. This module is the other half: while a
// lockdown session is active, it collapses the student to one tab pinned
// to the test URL, and reacts to new tabs/windows, tab switches, the lock
// tab being closed, and Chrome losing OS focus — correcting what it can
// and logging everything to the backend for the teacher to see.
//
// This is deliberately a SOFT lock. A Chrome extension cannot block
// OS-level app switching (alt-tab to another program) — only the OS can do
// that — so focus_loss is detected and reported, never prevented.

import { apiFetch } from './api.js';
import { getStoredJWT } from './auth.js';

const STATE_KEY = 'cg_lockdown';
const MIN_LOG_INTERVAL_MS = 3000;

let listenersAttached = false;
let suppressNextTabCreated = false;
let lastLoggedAt = {};

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || null;
}

async function setState(state) {
  if (state) await chrome.storage.local.set({ [STATE_KEY]: state });
  else await chrome.storage.local.remove(STATE_KEY);
}

function shouldLog(eventType) {
  const now = Date.now();
  if (lastLoggedAt[eventType] && now - lastLoggedAt[eventType] < MIN_LOG_INTERVAL_MS) return false;
  lastLoggedAt[eventType] = now;
  return true;
}

async function logEvent(eventType, detail) {
  const state = await getState();
  if (!state) return;
  const jwt = await getStoredJWT();
  if (!jwt) return;
  apiFetch(`/extension/lockdown/${state.sessionId}/event`, {
    method: 'POST',
    jwt,
    body: { event_type: eventType, detail: detail || null },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Called from syncPolicy() after every policy fetch — decides whether to
// engage, re-target, or disengage based on the resolved policy's mode.
// ---------------------------------------------------------------------------
export async function applyLockdownState(policy) {
  const state = await getState();
  const wantsLockdown = policy?.mode === 'lockdown' && !!policy.lockdownSessionId;

  if (wantsLockdown && (!state || state.sessionId !== policy.lockdownSessionId)) {
    await engageLockdown(policy.lockdownSessionId, policy.lockdownTargetUrl);
  } else if (!wantsLockdown && state) {
    await disengageLockdown();
  }
}

async function engageLockdown(sessionId, targetUrl) {
  let [lockTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  suppressNextTabCreated = !lockTab;
  if (lockTab) {
    await chrome.tabs.update(lockTab.id, { url: targetUrl }).catch(() => {});
  } else {
    lockTab = await chrome.tabs.create({ url: targetUrl });
  }

  await setState({ sessionId, targetUrl, tabId: lockTab.id, windowId: lockTab.windowId });

  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (tab.id !== lockTab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }

  await chrome.tabs.update(lockTab.id, { active: true }).catch(() => {});
  await chrome.windows.update(lockTab.windowId, { focused: true }).catch(() => {});

  attachListeners();
}

async function disengageLockdown() {
  detachListeners();
  await setState(null);
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  chrome.tabs.onCreated.addListener(handleTabCreated);
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.tabs.onRemoved.addListener(handleLockTabRemoved);
  chrome.windows.onCreated.addListener(handleWindowCreated);
  chrome.windows.onFocusChanged.addListener(handleFocusChanged);
}

function detachListeners() {
  if (!listenersAttached) return;
  listenersAttached = false;
  chrome.tabs.onCreated.removeListener(handleTabCreated);
  chrome.tabs.onActivated.removeListener(handleTabActivated);
  chrome.tabs.onRemoved.removeListener(handleLockTabRemoved);
  chrome.windows.onCreated.removeListener(handleWindowCreated);
  chrome.windows.onFocusChanged.removeListener(handleFocusChanged);
}

// ---------------------------------------------------------------------------
// Escape attempts — corrected (best-effort) and logged.
// ---------------------------------------------------------------------------
async function handleTabCreated(tab) {
  if (suppressNextTabCreated) {
    suppressNextTabCreated = false;
    const state = await getState();
    if (state) await setState({ ...state, tabId: tab.id, windowId: tab.windowId });
    return;
  }

  const state = await getState();
  if (!state) return;

  await chrome.tabs.remove(tab.id).catch(() => {});
  await chrome.tabs.update(state.tabId, { active: true }).catch(() => {});
  if (shouldLog('new_tab')) logEvent('new_tab', tab.pendingUrl || tab.url || null);
}

async function handleTabActivated({ tabId }) {
  const state = await getState();
  if (!state || tabId === state.tabId) return;

  await chrome.tabs.update(state.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(state.windowId, { focused: true }).catch(() => {});
  if (shouldLog('tab_switch')) logEvent('tab_switch');
}

async function handleWindowCreated(window) {
  const state = await getState();
  if (!state) return;

  await chrome.windows.remove(window.id).catch(() => {});
  if (shouldLog('new_window')) logEvent('new_window');
}

async function handleFocusChanged(windowId) {
  const state = await getState();
  if (!state) return;

  // WINDOW_ID_NONE means Chrome itself lost OS focus (another application
  // came forward) — the one case this extension genuinely cannot correct,
  // only report.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (shouldLog('focus_loss')) logEvent('focus_loss', 'chrome_lost_os_focus');
    return;
  }

  if (windowId !== state.windowId) {
    await chrome.windows.update(state.windowId, { focused: true }).catch(() => {});
    if (shouldLog('focus_loss')) logEvent('focus_loss', 'another_window_focused');
  }
}

async function handleLockTabRemoved(tabId) {
  const state = await getState();
  if (!state || tabId !== state.tabId) return;

  if (shouldLog('tab_closed')) logEvent('tab_closed');

  suppressNextTabCreated = true;
  const newTab = await chrome.tabs.create({ url: state.targetUrl });
  await setState({ ...state, tabId: newTab.id, windowId: newTab.windowId });
}
