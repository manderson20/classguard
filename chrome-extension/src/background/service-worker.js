// ClassGuard Service Worker — MV3
// Handles: authentication, policy sync, declarativeNetRequest enforcement,
// tab activity reporting, keyword sync, screenshot capture, and real-time WebSocket.

import { getGoogleToken, getStoredJWT, getStoredUser, storeAuth, clearAuth } from '../lib/auth.js';
import { apiFetch, getServerUrl }  from '../lib/api.js';
import { enforcePolicy }           from '../lib/rules.js';
import { connectSocket, isConnected } from '../lib/socket.js';

const POLICY_CACHE_KEY   = 'cg_policy';
const KEYWORDS_CACHE_KEY = 'cg_keywords';
const ALARM_POLICY_SYNC  = 'cg-policy-sync';
const ALARM_HEARTBEAT    = 'cg-heartbeat';
const ALARM_KEYWORD_SYNC = 'cg-keyword-sync';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.storage.local.clear();
  init();
});

chrome.runtime.onStartup.addListener(init);

// Message bridge for popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  handleMessage(msg, sender).then(respond).catch((err) => respond({ error: err.message }));
  return true; // keep channel open for async response
});

// ---------------------------------------------------------------------------
// Init — called on install and every browser startup
// ---------------------------------------------------------------------------
async function init() {
  await chrome.alarms.create(ALARM_POLICY_SYNC,  { periodInMinutes: 1 });
  await chrome.alarms.create(ALARM_HEARTBEAT,    { periodInMinutes: 0.5 });
  await chrome.alarms.create(ALARM_KEYWORD_SYNC, { periodInMinutes: 360 }); // every 6 hours

  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  const jwt = await getStoredJWT();
  if (jwt) {
    await syncPolicy(jwt);
    await syncKeywords(jwt);
    await connectSocket({
      jwt,
      onPolicyUpdated:   () => syncPolicy(),
      onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
    });
  } else {
    await authenticate();
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
async function authenticate() {
  let googleToken;
  try {
    googleToken = await getGoogleToken(true);
  } catch (err) {
    console.warn('[ClassGuard] Google sign-in unavailable:', err.message);
    return;
  }

  try {
    const { token, user } = await apiFetch('/extension/auth', {
      method: 'POST',
      jwt:    null,
      body:   { access_token: googleToken },
    });

    await storeAuth(token, user);
    await syncPolicy(token);
    await syncKeywords(token);
    await connectSocket({
      jwt: token,
      onPolicyUpdated:   () => syncPolicy(),
      onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
    });

    await apiFetch('/extension/register', {
      method: 'POST',
      jwt:    token,
      body:   { user_id: user.id },
    }).catch(() => {});

  } catch (err) {
    console.error('[ClassGuard] Auth failed:', err.message);
    await clearAuth();
  }
}

// ---------------------------------------------------------------------------
// Policy sync
// ---------------------------------------------------------------------------
async function syncPolicy(jwtOverride) {
  const jwt = jwtOverride || await getStoredJWT();
  if (!jwt) return;

  try {
    const policy = await apiFetch('/users/me/effective-policy', { jwt });
    await chrome.storage.local.set({ [POLICY_CACHE_KEY]: policy });
    await enforcePolicy(policy);
    chrome.runtime.sendMessage({ type: 'CG_POLICY_UPDATED', policy }).catch(() => {});
  } catch (err) {
    console.error('[ClassGuard] Policy sync failed:', err.message);
    const cached = await getCachedPolicy();
    if (cached) await enforcePolicy(cached);
  }
}

async function getCachedPolicy() {
  const data = await chrome.storage.local.get(POLICY_CACHE_KEY);
  return data[POLICY_CACHE_KEY] || null;
}

// ---------------------------------------------------------------------------
// Keyword sync — downloads blocked keyword list from server every 6 hours
// Content scripts read from chrome.storage.local to avoid needing a JWT.
// ---------------------------------------------------------------------------
async function syncKeywords(jwtOverride) {
  const jwt = jwtOverride || await getStoredJWT();
  if (!jwt) return;

  try {
    const keywords = await apiFetch('/extension/keywords', { jwt });
    await chrome.storage.local.set({ [KEYWORDS_CACHE_KEY]: keywords });
    // Notify all content scripts that keywords updated
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'CG_KEYWORDS_UPDATED', keywords }).catch(() => {});
    }
  } catch (err) {
    console.warn('[ClassGuard] Keyword sync failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture — called for teacher requests or content violations
// ---------------------------------------------------------------------------
async function captureAndUpload({ trigger = 'manual', triggerDetail = null, tabId } = {}) {
  const jwt = await getStoredJWT();
  if (!jwt) return;

  try {
    // Get the active tab if no specific tabId
    let targetTab;
    if (tabId) {
      targetTab = await chrome.tabs.get(tabId).catch(() => null);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTab = tab;
    }

    if (!targetTab || !targetTab.url?.startsWith('http')) return;

    // captureVisibleTab requires the window context
    const windowId = targetTab.windowId;
    const dataUrl  = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });

    await apiFetch('/extension/screenshot', {
      method: 'POST',
      jwt,
      body: {
        data_url:       dataUrl,
        url:            targetTab.url,
        title:          targetTab.title || '',
        trigger,
        trigger_detail: triggerDetail,
      },
    });
  } catch (err) {
    console.error('[ClassGuard] Screenshot capture failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
async function onAlarm(alarm) {
  if (alarm.name === ALARM_POLICY_SYNC) {
    const jwt = await getStoredJWT();
    if (!jwt) {
      await authenticate();
    } else {
      await syncPolicy(jwt);
      if (!isConnected()) {
        await connectSocket({
          jwt,
          onPolicyUpdated:   () => syncPolicy(),
          onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
        });
      }
    }
  } else if (alarm.name === ALARM_HEARTBEAT) {
    await sendHeartbeat();
  } else if (alarm.name === ALARM_KEYWORD_SYNC) {
    await syncKeywords();
  }
}

// ---------------------------------------------------------------------------
// Tab monitoring
// ---------------------------------------------------------------------------
async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('http')) return;

  const jwt = await getStoredJWT();
  if (!jwt) return;

  apiFetch('/extension/tab-event', {
    method: 'POST',
    jwt,
    body: { url: tab.url, title: tab.title || '' },
  }).catch(() => {});

  // Push current keywords to the newly loaded tab
  const data = await chrome.storage.local.get(KEYWORDS_CACHE_KEY);
  if (data[KEYWORDS_CACHE_KEY]) {
    chrome.tabs.sendMessage(tabId, {
      type:     'CG_KEYWORDS_UPDATED',
      keywords: data[KEYWORDS_CACHE_KEY],
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
async function sendHeartbeat() {
  const jwt = await getStoredJWT();
  if (!jwt) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await apiFetch('/extension/heartbeat', {
      method: 'POST',
      jwt,
      body: {
        url:    tab?.url   || null,
        title:  tab?.title || null,
        socket: isConnected(),
      },
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Message handler (popup / content scripts ↔ service worker)
// ---------------------------------------------------------------------------
async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'CG_GET_STATUS': {
      const [jwt, user, policy] = await Promise.all([
        getStoredJWT(),
        getStoredUser(),
        getCachedPolicy(),
      ]);
      return { authenticated: !!jwt, user, policy, socketConnected: isConnected() };
    }

    case 'CG_SIGN_OUT': {
      await clearAuth();
      await enforcePolicy(null);
      const { disconnectSocket } = await import('../lib/socket.js');
      disconnectSocket();
      return { ok: true };
    }

    case 'CG_FORCE_SYNC': {
      await syncPolicy();
      return { ok: true };
    }

    // Content script detected a keyword match — capture screenshot
    case 'CG_KEYWORD_VIOLATION': {
      const { keyword, category, url, title, tabId } = msg;
      const detail = `keyword:${keyword} (${category})`;
      captureAndUpload({
        trigger:       'content_violation',
        triggerDetail: detail,
        tabId:         sender?.tab?.id || tabId,
      }).catch(() => {});

      // Send a notice back to the content script
      if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type:  'CG_SHOW_NOTICE',
          text:  'This content has been flagged and a screenshot has been captured.',
          level: 'warning',
        }).catch(() => {});
      }
      return { ok: true };
    }

    // Content script requesting keyword list
    case 'CG_GET_KEYWORDS': {
      const data = await chrome.storage.local.get(KEYWORDS_CACHE_KEY);
      return { keywords: data[KEYWORDS_CACHE_KEY] || [] };
    }

    // YouTube filter content script requesting video category
    // Proxied through service worker so the JWT stays in the background context
    case 'CG_YT_GET_CATEGORY': {
      const { videoId } = msg;
      if (!videoId) return { categoryId: null };
      const jwt = await getStoredJWT();
      if (!jwt) return { categoryId: null };
      try {
        const data = await apiFetch(`/youtube/video-info?id=${encodeURIComponent(videoId)}`, { jwt });
        const video = Array.isArray(data) ? data[0] : data;
        return { categoryId: video?.categoryId ?? null };
      } catch {
        return { categoryId: null };
      }
    }

    default:
      return { error: 'Unknown message type' };
  }
}
