require('dotenv').config();

module.exports = {
  dns: {
    port: parseInt(process.env.DNS_PORT) || 53,
    upstreamPrimary:   process.env.DNS_UPSTREAM_PRIMARY   || '1.1.1.1',
    upstreamSecondary: process.env.DNS_UPSTREAM_SECONDARY || '8.8.8.8',
    blockPageIp:       process.env.DNS_BLOCK_PAGE_IP      || null,
    blockPageIpv6:     process.env.DNS_BLOCK_PAGE_IPV6    || null,
  },
  http: {
    port: parseInt(process.env.DNS_HTTP_PORT) || 3053,
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  backend: {
    url: process.env.BACKEND_URL || 'http://localhost:3001',
    internalSecret: process.env.INTERNAL_SECRET || '',
  },
  cache: {
    ttl: parseInt(process.env.DNS_CACHE_TTL) || 300,
  },
};
