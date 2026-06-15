// Manages Google OAuth token acquisition and ClassGuard JWT storage.
// All state lives in chrome.storage.local so it survives service worker suspension.

const JWT_KEY  = 'cg_jwt';
const USER_KEY = 'cg_user';

// ---------------------------------------------------------------------------
// Google OAuth — get an access token for the signed-in Chrome profile account
// ---------------------------------------------------------------------------
export function getGoogleToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No token returned from chrome.identity'));
      } else {
        resolve(token);
      }
    });
  });
}

export function revokeGoogleToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

// ---------------------------------------------------------------------------
// ClassGuard JWT
// ---------------------------------------------------------------------------
export async function getStoredJWT() {
  const data = await chrome.storage.local.get(JWT_KEY);
  const jwt  = data[JWT_KEY];
  if (!jwt) return null;

  try {
    // Decode payload (base64url) and check expiry without a crypto library
    const parts   = jwt.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp * 1000 < Date.now() + 60_000) { // 60s buffer
      await clearAuth();
      return null;
    }
    return jwt;
  } catch {
    await clearAuth();
    return null;
  }
}

export async function storeAuth(jwt, user) {
  await chrome.storage.local.set({ [JWT_KEY]: jwt, [USER_KEY]: user });
}

export async function getStoredUser() {
  const data = await chrome.storage.local.get(USER_KEY);
  return data[USER_KEY] || null;
}

export async function clearAuth() {
  await chrome.storage.local.remove([JWT_KEY, USER_KEY]);
}
