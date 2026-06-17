// youtube.js — YouTube Data API proxy with 3-layer caching
// Layer 1: Redis (24h)  ← shared across all students/devices
// Layer 2: Extension chrome.storage.local (1h)  ← per-device, handled client-side
// Layer 3: YouTube Data API  ← only called on Redis miss
//
// Quota: videos.list with part=snippet costs 1 unit per call regardless of batch size.
// With batching (up to 50 ids) and Redis caching, the free 10k/day quota supports
// a large school with heavy YouTube use.

const express = require('express');
const router  = express.Router();
const { query }          = require('../db');
const { authenticate }   = require('../middleware/auth');
const redis              = require('../redis');

const CACHE_TTL   = 86400;  // 24 hours
const CACHE_KEY   = id => `classguard:yt:video:${id}`;
const MAX_IDS     = 50;     // YouTube API limit per call

const YT_CATEGORY_NAMES = {
  1:  'Film & Animation',     2:  'Autos & Vehicles',
  10: 'Music',                15: 'Pets & Animals',
  17: 'Sports',               19: 'Travel & Events',
  20: 'Gaming',               22: 'People & Blogs',
  23: 'Comedy',               24: 'Entertainment',
  25: 'News & Politics',      26: 'How-to & Style',
  27: 'Education',            28: 'Science & Technology',
  29: 'Nonprofits & Activism',
};

const YT_CATEGORY_SLUGS = {
  1:  'film_animation',       2:  'autos_vehicles',
  10: 'music',                15: 'pets_animals',
  17: 'sports',               19: 'travel_events',
  20: 'gaming',               22: 'people_blogs',
  23: 'comedy',               24: 'entertainment',
  25: 'news_politics',        26: 'howto_style',
  27: 'education',            28: 'science_technology',
  29: 'nonprofits_activism',
};

// ---------------------------------------------------------------------------
// Get API key from settings table (cached in module scope, refreshed every 5m)
// ---------------------------------------------------------------------------
let _apiKey    = null;
let _keyLoadAt = 0;

async function getApiKey() {
  if (_apiKey && Date.now() - _keyLoadAt < 300_000) return _apiKey;
  const { rows } = await query("SELECT value FROM settings WHERE key = 'youtube_api_key'");
  _apiKey    = rows[0]?.value || null;
  _keyLoadAt = Date.now();
  return _apiKey;
}

// ---------------------------------------------------------------------------
// Fetch video metadata from YouTube Data API (batched, up to 50 ids per call)
// ---------------------------------------------------------------------------
async function fetchFromApi(ids, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/videos?` +
    `id=${ids.join(',')}&part=snippet&` +
    `fields=items(id,snippet(title,channelTitle,categoryId,thumbnails/default/url))&` +
    `key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.items || []).map(item => ({
    id:           item.id,
    title:        item.snippet?.title         || '',
    channelTitle: item.snippet?.channelTitle  || '',
    categoryId:   item.snippet?.categoryId    ? parseInt(item.snippet.categoryId, 10) : null,
    categoryName: item.snippet?.categoryId    ? (YT_CATEGORY_NAMES[parseInt(item.snippet.categoryId, 10)] || null) : null,
    categorySlug: item.snippet?.categoryId    ? (YT_CATEGORY_SLUGS[parseInt(item.snippet.categoryId, 10)] || null) : null,
    thumbnailUrl: item.snippet?.thumbnails?.default?.url || null,
    cachedAt:     new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// GET /api/v1/youtube/video-info?id=ID  or  ?ids=ID1,ID2,...
// ---------------------------------------------------------------------------
router.get('/video-info', authenticate, async (req, res) => {
  const raw  = req.query.id || req.query.ids || '';
  const ids  = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_IDS);
  if (ids.length === 0) return res.status(400).json({ error: 'Provide id or ids query param' });

  const apiKey = await getApiKey();
  if (!apiKey) {
    return res.status(503).json({
      error: 'YouTube Data API key not configured',
      hint:  'Add your API key in Settings → YouTube Data API',
    });
  }

  // Check Redis for each id
  const pipeline   = redis.pipeline();
  for (const id of ids) pipeline.get(CACHE_KEY(id));
  const cached     = await pipeline.exec().catch(() => ids.map(() => [null, null]));

  const results    = [];
  const uncachedIds = [];

  for (let i = 0; i < ids.length; i++) {
    const [err, raw] = cached[i];
    if (!err && raw) {
      try { results.push(JSON.parse(raw)); continue; } catch {}
    }
    uncachedIds.push(ids[i]);
  }

  // Batch-fetch uncached from YouTube API
  if (uncachedIds.length > 0) {
    try {
      const fresh = await fetchFromApi(uncachedIds, apiKey);

      // Cache hits in Redis
      const setPipeline = redis.pipeline();
      for (const video of fresh) {
        setPipeline.set(CACHE_KEY(video.id), JSON.stringify(video), 'EX', CACHE_TTL);
        results.push(video);
      }
      await setPipeline.exec().catch(() => {});

      // Ids that the API returned nothing for (deleted/private)
      const foundIds = new Set(fresh.map(v => v.id));
      for (const id of uncachedIds) {
        if (!foundIds.has(id)) {
          results.push({ id, title: null, error: 'Video not found or private' });
        }
      }
    } catch (err) {
      console.error('[youtube] API fetch error:', err.message);
      // Return partial results + error for uncached
      for (const id of uncachedIds) {
        results.push({ id, title: null, error: err.message });
      }
    }
  }

  // Return in original order
  const ordered = ids.map(id => results.find(r => r.id === id) || { id, title: null, error: 'Not found' });
  res.json(ordered);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/youtube/cache/:id  — admin can bust a single video's cache
// (used when a video is reclassified by YouTube)
// ---------------------------------------------------------------------------
const { requireMinRole } = require('../middleware/roles');
router.delete('/cache/:id', authenticate, requireMinRole('admin'), async (req, res) => {
  await redis.del(CACHE_KEY(req.params.id));
  res.json({ cleared: req.params.id });
});

// ---------------------------------------------------------------------------
// GET /api/v1/youtube/cache-stats  — how many videos are cached
// ---------------------------------------------------------------------------
router.get('/cache-stats', authenticate, requireMinRole('admin'), async (req, res) => {
  const keys  = await redis.keys('classguard:yt:video:*').catch(() => []);
  res.json({ cachedVideos: keys.length, ttlHours: CACHE_TTL / 3600 });
});

module.exports = router;
module.exports.YT_CATEGORY_NAMES = YT_CATEGORY_NAMES;
module.exports.YT_CATEGORY_SLUGS = YT_CATEGORY_SLUGS;
