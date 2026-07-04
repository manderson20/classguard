// ClassGuard Service Worker — MV3
// Handles: authentication, policy sync, declarativeNetRequest enforcement,
// tab activity reporting, keyword sync, screenshot capture, and real-time WebSocket.

import { getGoogleToken, getStoredJWT, getStoredUser, storeAuth, clearAuth } from '../lib/auth.js';
import { apiFetch, getServerUrl }  from '../lib/api.js';
import { enforcePolicy }           from '../lib/rules.js';
import { applyLockdownState }      from '../lib/lockdownGuard.js';
import { classifyPublicIpLiteral } from '../lib/directIp.js';
import { connectSocket, isConnected } from '../lib/socket.js';

const POLICY_CACHE_KEY   = 'cg_policy';
const POLICY_SYNC_TS_KEY = 'cg_policy_synced_at';
const KEYWORDS_CACHE_KEY = 'cg_keywords';
const BRANDING_CACHE_KEY = 'cg_branding';
const BRANDING_TS_KEY    = 'cg_branding_ts';
const ALARM_POLICY_SYNC  = 'cg-policy-sync';
const ALARM_HEARTBEAT    = 'cg-heartbeat';
const ALARM_KEYWORD_SYNC = 'cg-keyword-sync';
const IDLE_THRESHOLD_SECONDS = 60;

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

  // Screen-time tracking — IDLE_THRESHOLD_SECONDS is both the detection
  // window passed to queryState() below and Chrome's own idle-state
  // granularity; 60s keeps it well above the 30s heartbeat interval so a
  // single missed beat can't flip the state spuriously.
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);

  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);

  const jwt = await getStoredJWT();
  if (jwt) {
    await syncPolicy(jwt);
    await syncKeywords(jwt);
    await syncBranding();
    await connectSocket({
      jwt,
      onPolicyUpdated:   () => syncPolicy(),
      onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
      onLiveViewRequest: () => captureForLiveView(),
      onLockRequest:     (data) => lockScreen(data),
      onUnlockRequest:   () => unlockScreen(),
      onOpenTabRequest:  (data) => openTab(data?.url),
      onCloseTabRequest: () => closeTab(),
      onChatMessage:     (data) => broadcastChatMessage(data),
      onBroadcastFrame:  (data) => broadcastScreenFrame(data),
      onBroadcastEnd:    (data) => broadcastScreenEnd(data),
    });
  } else {
    await authenticate();
  }
}

// ---------------------------------------------------------------------------
// Authentication
//
// Always silent (interactive: false). This extension is force-installed on
// managed devices already signed into the school's Google account, so a
// token should be retrievable with no prompt at all. Using interactive mode
// here would do two things we don't want: chrome.identity's consent UI
// can't actually show from an unattended background call anyway (Chrome
// requires a user gesture), so it would just fail silently the same as
// today — and even if it could show, a student dismissing it would leave
// the device unmonitored with no way for that to get flagged. If silent
// auth fails, retry on the existing 1-minute alarm (see onAlarm) rather
// than ever surfacing a skippable prompt.
// ---------------------------------------------------------------------------
async function authenticate() {
  let googleToken;
  try {
    googleToken = await getGoogleToken(false);
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
    await syncBranding();
    await connectSocket({
      jwt: token,
      onPolicyUpdated:   () => syncPolicy(),
      onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
      onLiveViewRequest: () => captureForLiveView(),
      onLockRequest:     (data) => lockScreen(data),
      onUnlockRequest:   () => unlockScreen(),
      onOpenTabRequest:  (data) => openTab(data?.url),
      onCloseTabRequest: () => closeTab(),
      onChatMessage:     (data) => broadcastChatMessage(data),
      onBroadcastFrame:  (data) => broadcastScreenFrame(data),
      onBroadcastEnd:    (data) => broadcastScreenEnd(data),
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
    await chrome.storage.local.set({
      [POLICY_CACHE_KEY]:   policy,
      [POLICY_SYNC_TS_KEY]: Date.now(),
    });
    await enforcePolicy(policy);
    await applyLockdownState(policy);
    chrome.runtime.sendMessage({ type: 'CG_POLICY_UPDATED', policy }).catch(() => {});
  } catch (err) {
    console.error('[ClassGuard] Policy sync failed:', err.message);
    const cached = await getCachedPolicy();
    if (cached) {
      await enforcePolicy(cached);
      await applyLockdownState(cached);
    }
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
// ---------------------------------------------------------------------------
// Branding sync — fetches school logo/message from public API, cached 1 hour.
// No JWT required since /api/v1/branding is a public endpoint.
// ---------------------------------------------------------------------------
async function syncBranding() {
  const { [BRANDING_TS_KEY]: ts } = await chrome.storage.local.get(BRANDING_TS_KEY);
  if (ts && Date.now() - ts < 3_600_000) return; // 1 hour cache

  const serverUrl = await getServerUrl();
  if (!serverUrl) return;

  try {
    const res = await fetch(`${serverUrl}/api/v1/branding`);
    if (!res.ok) return;
    const branding = await res.json();
    await chrome.storage.local.set({
      [BRANDING_CACHE_KEY]: branding,
      [BRANDING_TS_KEY]:    Date.now(),
    });
  } catch {}
}

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
// Live View capture — same chrome.tabs.captureVisibleTab() mechanism as
// captureAndUpload above, but posts to /extension/liveview-frame instead of
// /extension/screenshot: that endpoint relays the frame straight to whoever's
// watching and never writes it to disk or a database row. Deliberately a
// separate function rather than a flag on captureAndUpload, so the two
// storage paths (permanent + audited vs ephemeral) can never be mixed up by
// a future edit to one of them.
// ---------------------------------------------------------------------------
async function captureForLiveView() {
  const jwt = await getStoredJWT();
  if (!jwt) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url?.startsWith('http')) return;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });

    await apiFetch('/extension/liveview-frame', {
      method: 'POST',
      jwt,
      body: { data_url: dataUrl, url: tab.url, title: tab.title || '' },
    });
  } catch (err) {
    console.error('[ClassGuard] Live View capture failed:', err.message);
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
      await syncBranding();
      if (!isConnected()) {
        await connectSocket({
          jwt,
          onPolicyUpdated:   () => syncPolicy(),
          onScreenshotRequest: (trigger) => captureAndUpload({ trigger }),
      onLiveViewRequest: () => captureForLiveView(),
          onLockRequest:     (data) => lockScreen(data),
          onUnlockRequest:   () => unlockScreen(),
          onOpenTabRequest:  (data) => openTab(data?.url),
          onCloseTabRequest: () => closeTab(),
          onChatMessage:     (data) => broadcastChatMessage(data),
      onBroadcastFrame:  (data) => broadcastScreenFrame(data),
      onBroadcastEnd:    (data) => broadcastScreenEnd(data),
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
// chrome.tabs.onRemoved gives a tabId but no URL — and the service worker can
// be suspended between a tab's last update and its close, wiping any plain
// in-memory map — so the last-known url/title per tab is kept in
// chrome.storage.session, which survives a service worker restart within
// the same browser session (unlike a JS variable) but still clears on
// browser close (unlike chrome.storage.local, which would leak forever).
async function rememberTab(tabId, url, title) {
  await chrome.storage.session.set({ [`cg_tab_${tabId}`]: { url, title } });
}
async function forgetTab(tabId) {
  await chrome.storage.session.remove(`cg_tab_${tabId}`);
}

// dns-engine can never see this — a navigation straight to a literal IP
// never triggers a DNS query. onBeforeNavigate fires with the *original*
// target URL before any DNR redirect/block takes effect, which onTabUpdated
// (above/below) can't guarantee once rules.js's own redirect rule rewrites
// the tab to blocked.html. Reports immediately rather than waiting to see
// what DNR actually does, since the same cached policy that decides this
// here is exactly what rules.js built its DNR rules from — both reach the
// same answer from the same input, deterministically.
async function onBeforeNavigate(details) {
  if (details.frameId !== 0) return; // top-level navigations only

  const ipFamily = classifyPublicIpLiteral(details.url);
  if (!ipFamily) return; // not a public IP literal — nothing to report

  const jwt = await getStoredJWT();
  if (!jwt) return;

  const policy  = await getCachedPolicy();
  const blocked = policy?.block_direct_ip === true;

  apiFetch('/extension/tab-event', {
    method: 'POST',
    jwt,
    body: { url: details.url, title: '', is_direct_ip: true, blocked },
  }).catch(() => {});
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('http')) return;

  const jwt = await getStoredJWT();
  if (!jwt) return;

  // The backend may ask for a screenshot right here — a proactive
  // ("risky_category") check on the domain itself, independent of the
  // in-page keyword scanner, for content that scanner can't see (images,
  // or pages on domains we've never categorized yet).
  apiFetch('/extension/tab-event', {
    method: 'POST',
    jwt,
    body: { url: tab.url, title: tab.title || '' },
  }).then((res) => {
    if (res?.requestScreenshot) {
      captureAndUpload({ trigger: 'risky_category', triggerDetail: res.riskCategory, tabId });
    }
    if (typeof res?.inActiveLesson === 'boolean') {
      updateLessonState(res.inActiveLesson);
    }
  }).catch(() => {});
  rememberTab(tabId, tab.url, tab.title || '').catch(() => {});

  // Push current keywords to the newly loaded tab
  const data = await chrome.storage.local.get(KEYWORDS_CACHE_KEY);
  if (data[KEYWORDS_CACHE_KEY]) {
    chrome.tabs.sendMessage(tabId, {
      type:     'CG_KEYWORDS_UPDATED',
      keywords: data[KEYWORDS_CACHE_KEY],
    }).catch(() => {});
  }
}

async function onTabRemoved(tabId) {
  const jwt = await getStoredJWT();
  if (!jwt) return;

  const data = await chrome.storage.session.get(`cg_tab_${tabId}`);
  const last = data[`cg_tab_${tabId}`];
  forgetTab(tabId).catch(() => {});
  if (!last?.url) return; // never tracked (e.g. a non-http tab) — nothing to report

  apiFetch('/extension/tab-event', {
    method: 'POST',
    jwt,
    body: { url: last.url, title: last.title || '', event: 'closed' },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Remote device commands — lock/unlock screen, open/close tab
// ---------------------------------------------------------------------------
async function lockScreen(data) {
  // Back-compat: pre-focus-lock callers passed a bare message string.
  const { message = null, targetPath = null, allowPulse = false } =
    typeof data === 'string' ? { message: data } : (data || {});

  // ClassPulse focus lock: exemptOrigin lets the content script leave the
  // session page (/pulse/<code>) usable while every other tab gets the
  // overlay — locking that page too would block the questions themselves.
  const serverUrl = allowPulse ? await getServerUrl() : null;
  const exemptOrigin = serverUrl ? new URL(serverUrl).origin : null;

  const lockState = { message, allowPulse, exemptOrigin };
  await chrome.storage.local.set({ cg_locked: lockState });

  // Put the student on the session page before locking: focus an existing
  // tab if one is already there, otherwise open it.
  if (targetPath && serverUrl) {
    const targetUrl = serverUrl.replace(/\/$/, '') + targetPath;
    const existing = await chrome.tabs.query({ url: targetUrl + '*' });
    if (existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true }).catch(() => {});
    } else {
      await chrome.tabs.create({ url: targetUrl }).catch(() => {});
    }
  }

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_LOCK_SCREEN', ...lockState }).catch(() => {});
  }
}

async function unlockScreen() {
  await chrome.storage.local.remove('cg_locked');
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_UNLOCK_SCREEN' }).catch(() => {});
  }
}

async function openTab(url) {
  await chrome.tabs.create(url ? { url } : {});
}

async function closeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
}

// ---------------------------------------------------------------------------
// Chat — the floating widget lives in every tab's content script, so a new
// message needs to reach all of them, same broadcast pattern as lockScreen().
// ---------------------------------------------------------------------------
async function broadcastChatMessage(data) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_CHAT_MESSAGE', ...data }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Screen broadcasting — same broadcast-to-all-tabs pattern as chat/lock.
// ---------------------------------------------------------------------------
async function broadcastScreenFrame(data) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_BROADCAST_FRAME', ...data }).catch(() => {});
  }
}

async function broadcastScreenEnd(data) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_BROADCAST_END', ...data }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Raise hand — piggybacks on /tab-event's response (see onTabUpdated above)
// rather than a separate polling endpoint, since tab-event already fires on
// every navigation. Only broadcasts to tabs when the state actually changes,
// so a routine navigation inside the same active lesson doesn't re-message
// every tab on every page load. chrome.storage.local (not an in-memory
// variable) so a fresh tab's content script can read the current state
// immediately on load, same reasoning as cg_locked.
// ---------------------------------------------------------------------------
async function updateLessonState(inActiveLesson) {
  const { cg_in_lesson: prev } = await chrome.storage.local.get('cg_in_lesson');
  if (prev === inActiveLesson) return;
  await chrome.storage.local.set({ cg_in_lesson: inActiveLesson });
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'CG_LESSON_STATE', inActiveLesson }).catch(() => {});
  }
}

async function raiseHand() {
  const jwt = await getStoredJWT();
  if (!jwt) return { ok: false };
  return apiFetch('/extension/raise-hand', { method: 'POST', jwt }).catch(() => ({ ok: false }));
}

// ---------------------------------------------------------------------------
// Chat attachment download — chrome.downloads.download() only supports
// plain URLs, no request body/response handling, but it DOES support
// custom request headers (since Chrome 91), which is enough to attach the
// same Bearer JWT apiFetch() uses. Simpler and more robust than fetching
// the file into memory in the service worker just to hand it back out
// again as a blob URL.
// ---------------------------------------------------------------------------
async function downloadChatAttachment(messageId, filename) {
  const jwt = await getStoredJWT();
  if (!jwt) return { ok: false };
  const base = await getServerUrl();
  try {
    await chrome.downloads.download({
      url: `${base}/api/v1/chat/messages/${messageId}/attachment`,
      filename: filename || undefined,
      headers: [{ name: 'Authorization', value: `Bearer ${jwt}` }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
function queryIdleState() {
  return new Promise((resolve) => chrome.idle.queryState(IDLE_THRESHOLD_SECONDS, resolve));
}

async function sendHeartbeat() {
  const jwt = await getStoredJWT();
  if (!jwt) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const idleState = await queryIdleState(); // 'active' | 'idle' | 'locked'
    await apiFetch('/extension/heartbeat', {
      method: 'POST',
      jwt,
      body: {
        url:    tab?.url   || null,
        title:  tab?.title || null,
        socket: isConnected(),
        idle_state: idleState,
      },
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Message handler (popup / content scripts ↔ service worker)
// ---------------------------------------------------------------------------
async function handleMessage(msg, sender) {
  switch (msg.type) {
    // ClassPulse auto-join: hands the student's JWT to ClassGuard's own
    // /pulse/<code> join page so a managed device joins a session with zero
    // sign-in friction. Strictly gated on the sender being that exact page
    // on the configured server origin — sender.url is set by Chrome, not the
    // page, so a lookalike page on another host can't request it.
    case 'CG_GET_PULSE_AUTH': {
      const serverUrl = await getServerUrl();
      if (!serverUrl || !sender?.url) return { token: null };
      try {
        const sen = new URL(sender.url);
        const srv = new URL(serverUrl);
        if (sen.origin !== srv.origin || !sen.pathname.startsWith('/pulse/')) {
          return { token: null };
        }
      } catch {
        return { token: null };
      }
      const jwt = await getStoredJWT();
      return { token: jwt || null };
    }

    case 'CG_GET_STATUS': {
      const [jwt, user, policy, tsData] = await Promise.all([
        getStoredJWT(),
        getStoredUser(),
        getCachedPolicy(),
        chrome.storage.local.get(POLICY_SYNC_TS_KEY),
      ]);
      return {
        authenticated:   !!jwt,
        user,
        policy,
        socketConnected: isConnected(),
        policySyncedAt:  tsData[POLICY_SYNC_TS_KEY] || null,
        version:         chrome.runtime.getManifest().version,
      };
    }

    case 'CG_FORCE_SYNC': {
      await syncPolicy();
      return { ok: true };
    }

    // The DNS block page (frontend/public/blocked-dns.html) asks the content
    // script to submit an unblock request on its behalf, via this handler —
    // never the page's own fetch(). apiFetch attaches the real student JWT
    // automatically (default behavior, same as every other call here), so
    // the backend can verify student_id cryptographically instead of trusting
    // a typed name/email. A student editing the page's own JS can't forge
    // this: the JWT itself never leaves the extension's trusted contexts.
    case 'CG_SUBMIT_UNBLOCK_REQUEST': {
      const { domain, reason } = msg;
      try {
        const result = await apiFetch('/unblock-requests', {
          method: 'POST',
          body:   { domain, reason },
        });
        return { ok: true, request: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // Content script detected a keyword match — capture screenshot
    case 'CG_KEYWORD_VIOLATION': {
      const { keyword, category, tabId } = msg;
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

    // Student requests a blocked domain be unblocked
    case 'CG_REQUEST_UNBLOCK': {
      const { domain, reason } = msg;
      const jwt = await getStoredJWT();
      const serverUrl = await getServerUrl();
      if (!serverUrl) return { error: 'Server not configured' };
      try {
        const res = await fetch(`${serverUrl}/api/v1/unblock-requests`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify({ domain, reason }),
        });
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    }

    // Student enters an override code from the block page
    case 'CG_VERIFY_OVERRIDE': {
      const { code, domain } = msg;
      const jwt = await getStoredJWT();
      const serverUrl = await getServerUrl();
      if (!serverUrl) return { valid: false, error: 'Server not configured' };
      try {
        const res = await fetch(`${serverUrl}/api/v1/override-codes/verify`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          },
          body: JSON.stringify({ code, domain }),
        });
        const data = await res.json();
        if (data.valid && data.expires_at) {
          // Store override so next enforcePolicy call includes an allow rule
          const { cg_overrides = [] } = await chrome.storage.local.get('cg_overrides');
          cg_overrides.push({ domain, expires_at: data.expires_at });
          await chrome.storage.local.set({ cg_overrides });
          // Re-enforce policy immediately with new override rule included
          await syncPolicy();
        }
        return data;
      } catch (e) {
        return { valid: false, error: e.message };
      }
    }

    // Chat — content script never calls the backend directly (same rule as
    // every other extension API call), it proxies through here so the JWT
    // stays in the background context.
    case 'CG_CHAT_GET_THREADS': {
      const jwt = await getStoredJWT();
      if (!jwt) return { threads: [] };
      try {
        return { threads: await apiFetch('/chat/threads', { jwt }) };
      } catch (e) {
        return { threads: [], error: e.message };
      }
    }

    case 'CG_CHAT_GET_MESSAGES': {
      const { threadId } = msg;
      const jwt = await getStoredJWT();
      if (!jwt || !threadId) return { messages: [] };
      try {
        return { messages: await apiFetch(`/chat/threads/${threadId}/messages`, { jwt }) };
      } catch (e) {
        return { messages: [], error: e.message };
      }
    }

    case 'CG_CHAT_SEND_MESSAGE': {
      const { threadId, body } = msg;
      const jwt = await getStoredJWT();
      if (!jwt || !threadId || !body) return { error: 'Missing threadId or body' };
      try {
        return await apiFetch(`/chat/threads/${threadId}/messages`, {
          method: 'POST', jwt, body: { body },
        });
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'CG_CHAT_MARK_READ': {
      const { threadId } = msg;
      const jwt = await getStoredJWT();
      if (!jwt || !threadId) return { ok: false };
      try {
        return await apiFetch(`/chat/threads/${threadId}/read`, { method: 'PATCH', jwt });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'CG_RAISE_HAND':
      return await raiseHand();

    case 'CG_CHAT_DOWNLOAD_ATTACHMENT':
      return await downloadChatAttachment(msg.messageId, msg.filename);

    default:
      return { error: 'Unknown message type' };
  }
}
