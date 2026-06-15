// ClassGuard Service Worker — MV3
// Handles: authentication, policy sync, declarativeNetRequest enforcement,
// tab activity reporting, and real-time WebSocket connection.

import { getGoogleToken, getStoredJWT, getStoredUser, storeAuth, clearAuth } from '../lib/auth.js';
import { apiFetch }       from '../lib/api.js';
import { enforcePolicy }  from '../lib/rules.js';
import { connectSocket, isConnected } from '../lib/socket.js';

const POLICY_CACHE_KEY  = 'cg_policy';
const ALARM_POLICY_SYNC = 'cg-policy-sync';
const ALARM_HEARTBEAT   = 'cg-heartbeat';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.clear();
  }
  init();
});

chrome.runtime.onStartup.addListener(init);

// Message bridge for popup and content scripts
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handleMessage(msg).then(respond).catch((err) => respond({ error: err.message }));
  return true; // keep channel open for async response
});

// ---------------------------------------------------------------------------
// Init — called on install and every browser startup
// ---------------------------------------------------------------------------
async function init() {
  // Re-register alarms (alarms persist but re-register idempotently)
  await chrome.alarms.create(ALARM_POLICY_SYNC, { periodInMinutes: 1 });
  await chrome.alarms.create(ALARM_HEARTBEAT,   { periodInMinutes: 0.5 });

  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  const jwt = await getStoredJWT();
  if (jwt) {
    await syncPolicy(jwt);
    connectSocket({ jwt, onPolicyUpdated: () => syncPolicy() });
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
      jwt:    null, // no JWT yet
      body:   { access_token: googleToken },
    });

    await storeAuth(token, user);
    await syncPolicy(token);
    connectSocket({ jwt: token, onPolicyUpdated: () => syncPolicy() });

    // Register this device so the DNS engine can map IP → student
    await apiFetch('/extension/register', {
      method: 'POST',
      jwt:    token,
      body:   { user_id: user.id },
    }).catch(() => {}); // non-fatal

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

    // Notify popup if it's open
    chrome.runtime.sendMessage({ type: 'CG_POLICY_UPDATED', policy }).catch(() => {});
  } catch (err) {
    console.error('[ClassGuard] Policy sync failed:', err.message);

    // Restore from local cache so enforcement doesn't lapse
    const cached = await getCachedPolicy();
    if (cached) await enforcePolicy(cached);
  }
}

async function getCachedPolicy() {
  const data = await chrome.storage.local.get(POLICY_CACHE_KEY);
  return data[POLICY_CACHE_KEY] || null;
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
        connectSocket({ jwt, onPolicyUpdated: () => syncPolicy() });
      }
    }
  } else if (alarm.name === ALARM_HEARTBEAT) {
    await sendHeartbeat();
  }
}

// ---------------------------------------------------------------------------
// Tab monitoring — sends active URL to backend for teacher dashboard
// ---------------------------------------------------------------------------
async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('http')) return;

  const jwt = await getStoredJWT();
  if (!jwt) return;

  apiFetch('/extension/tab-event', {
    method: 'POST',
    jwt,
    body: {
      url:   tab.url,
      title: tab.title || '',
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Heartbeat — periodic liveness signal with current active tab
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
// Message handler (popup ↔ service worker)
// ---------------------------------------------------------------------------
async function handleMessage(msg) {
  switch (msg.type) {
    case 'CG_GET_STATUS': {
      const [jwt, user, policy] = await Promise.all([
        getStoredJWT(),
        getStoredUser(),
        getCachedPolicy(),
      ]);
      return {
        authenticated: !!jwt,
        user,
        policy,
        socketConnected: isConnected(),
      };
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

    default:
      return { error: 'Unknown message type' };
  }
}
