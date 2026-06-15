const Redis  = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  enableOfflineQueue:   true,
  lazyConnect:          false,
});

redis.on('error',   (err) => console.error('[redis] error:', err.message));
redis.on('connect', ()    => console.log('[redis] connected'));

module.exports = redis;
