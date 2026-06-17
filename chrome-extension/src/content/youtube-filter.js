// ClassGuard YouTube Filter — content script for youtube.com
//
// Enforcement flow per video navigation:
//   1. Individual video allow/block rules (no API call — from cached policy)
//   2. Category rules — category looked up via backend proxy (Redis-cached 24h)
//      Extension also caches category in chrome.storage.local for 1h
//   3. YouTube Restricted Mode — injected via declarativeNetRequest header rule
//      (handled in rules.js, not here)
//
// YouTube is a SPA; we listen for 'yt-navigate-finish' for in-page navigations.

const POLICY_CACHE_KEY = 'cg_policy';
const EXT_CAT_TTL_MS   = 3_600_000;  // 1 hour — extension-side category cache

// YouTube category ID → our policy slug (must match YT_CATEGORIES in PolicyEditor)
const YT_CAT_SLUG = {
  1:  'film_animation',      2:  'autos_vehicles',
  10: 'music',               15: 'pets_animals',
  17: 'sports',              19: 'travel_events',
  20: 'gaming',              22: 'people_blogs',
  23: 'comedy',              24: 'entertainment',
  25: 'news_politics',       26: 'howto_style',
  27: 'education',           28: 'science_technology',
  29: 'nonprofits_activism',
};

const YT_CAT_NAME = {
  1:  'Film & Animation',    2:  'Autos & Vehicles',
  10: 'Music',               15: 'Pets & Animals',
  17: 'Sports',              19: 'Travel & Events',
  20: 'Gaming',              22: 'People & Blogs',
  23: 'Comedy',              24: 'Entertainment',
  25: 'News & Politics',     26: 'How-to & Style',
  27: 'Education',           28: 'Science & Technology',
  29: 'Nonprofits & Activism',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let policy     = null;
let overlayEl  = null;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function init() {
  const data = await chrome.storage.local.get(POLICY_CACHE_KEY).catch(() => ({}));
  policy = data[POLICY_CACHE_KEY] || null;

  // Check on initial load (handles direct navigation to /watch)
  checkPage();

  // YouTube fires this on every SPA navigation (video change, home, search, etc.)
  document.addEventListener('yt-navigate-finish', checkPage);
}

function checkPage() {
  const videoId = getVideoId();
  if (!videoId) { removeOverlay(); return; }
  applyPolicy(videoId);
}

function getVideoId() {
  return new URLSearchParams(window.location.search).get('v') || null;
}

// ---------------------------------------------------------------------------
// Policy application
// ---------------------------------------------------------------------------
async function applyPolicy(videoId) {
  if (!policy) return;

  const ytCats = policy.youtube_categories || {};
  const ytMode = ytCats.mode || 'off';

  // 1. Individual video block rule (highest priority, no API call)
  if ((policy.youtubeBlockVideos || []).includes(videoId)) {
    showOverlay('blocked_video', 'This video has been blocked by your school.');
    return;
  }

  // 2. Individual video allow rule (explicit pass — skip further checks)
  if ((policy.youtubeAllowVideos || []).includes(videoId)) {
    removeOverlay();
    return;
  }

  // 3. Category rules
  if (ytMode === 'blocklist' || ytMode === 'allowlist') {
    const catId = await getCategoryId(videoId);

    if (catId !== null) {
      const slug = YT_CAT_SLUG[catId] || null;
      const name = YT_CAT_NAME[catId] || 'This category';

      if (ytMode === 'blocklist') {
        if (slug && (ytCats.blocked || []).includes(slug)) {
          showOverlay('blocked_category', `${name} videos are blocked by your school.`);
          return;
        }
      } else if (ytMode === 'allowlist') {
        if (!slug || !(ytCats.allowed || []).includes(slug)) {
          showOverlay('blocked_category', 'Only approved YouTube categories are allowed by your school.');
          return;
        }
      }
    }
    // If catId is null (API unavailable / not configured) — fail open (allow)
  }

  removeOverlay();
}

// ---------------------------------------------------------------------------
// Category lookup — extension cache → backend proxy → YouTube API (server-side)
// ---------------------------------------------------------------------------
async function getCategoryId(videoId) {
  const cacheKey = `cg_yt_cat_${videoId}`;

  // Extension-side cache (1h)
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey] !== undefined) {
      const { catId, expiresAt } = cached[cacheKey];
      if (Date.now() < expiresAt) return catId;
    }
  } catch {}

  // Ask the service worker to hit the backend (it has the JWT)
  try {
    const result = await chrome.runtime.sendMessage({
      type:    'CG_YT_GET_CATEGORY',
      videoId,
    });
    const catId = result?.categoryId ?? null;

    // Cache in extension storage
    await chrome.storage.local.set({
      [cacheKey]: { catId, expiresAt: Date.now() + EXT_CAT_TTL_MS },
    }).catch(() => {});

    return catId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Block overlay
// ---------------------------------------------------------------------------
function showOverlay(reason, message) {
  if (overlayEl) {
    // Update message if already showing (different video)
    const msg = overlayEl.querySelector('#cg-yt-msg');
    if (msg) msg.textContent = message;
    return;
  }

  overlayEl = document.createElement('div');
  overlayEl.id = 'cg-yt-block-overlay';
  overlayEl.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:#0f172a', 'display:flex', 'align-items:center',
    'justify-content:center', 'font-family:system-ui,-apple-system,sans-serif',
  ].join(';');

  overlayEl.innerHTML = `
    <div style="text-align:center;color:#fff;max-width:420px;padding:48px 24px;">
      <div style="font-size:52px;margin-bottom:16px">🛡️</div>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 10px">Video Blocked</h1>
      <p id="cg-yt-msg" style="color:#94a3b8;font-size:14px;margin:0 0 28px;line-height:1.5">${message}</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <a href="https://www.youtube.com/"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
                  padding:10px 24px;border-radius:8px;font-size:14px;font-weight:500">
          YouTube Home
        </a>
        <button id="cg-yt-back"
           style="background:transparent;border:1px solid #475569;color:#94a3b8;cursor:pointer;
                  padding:10px 24px;border-radius:8px;font-size:14px">
          Go Back
        </button>
      </div>
    </div>
  `;

  overlayEl.querySelector('#cg-yt-back')?.addEventListener('click', () => history.back());
  document.documentElement.appendChild(overlayEl);
}

function removeOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
}

// ---------------------------------------------------------------------------
// Live policy updates from service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CG_POLICY_UPDATED') {
    policy = msg.policy;
    const videoId = getVideoId();
    if (videoId) applyPolicy(videoId);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
init().catch(() => {});
