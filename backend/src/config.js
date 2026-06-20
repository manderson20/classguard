require('dotenv').config();

const required = (key) => {
  const val = process.env[key];
  if (!val && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
};

// process.env.npm_package_version is only set by npm scripts (npm start),
// not when the container runs `node src/index.js` directly — every call
// site that used it was silently always undefined. Read package.json
// itself instead, so this actually tracks real releases.
const { version } = require('../package.json');

module.exports = {
  version,
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  db: {
    url: required('DATABASE_URL'),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    workspaceDomain: process.env.GOOGLE_WORKSPACE_DOMAIN,
    classroomEnabled: process.env.GOOGLE_CLASSROOM_ENABLED === 'true',
  },

  superadminEmail: process.env.SUPERADMIN_EMAIL,

  dns: {
    upstreamPrimary: process.env.DNS_UPSTREAM_PRIMARY || '1.1.1.1',
    upstreamSecondary: process.env.DNS_UPSTREAM_SECONDARY || '8.8.8.8',
    blockPageIp: process.env.DNS_BLOCK_PAGE_IP || '0.0.0.0',
    logRetentionDays: parseInt(process.env.DNS_LOG_RETENTION_DAYS) || 30,
  },

  kea: {
    controlAgentUrl: process.env.KEA_CONTROL_AGENT_URL || 'http://localhost:8000',
    nodeUrls: (process.env.DHCP_NODE_URLS || '').split(',').filter(Boolean),
  },

  screenshot: {
    storage: process.env.SCREENSHOT_STORAGE || 'none',
    retentionMinutes: parseInt(process.env.SCREENSHOT_RETENTION_MINUTES) || 0,
  },

  blocklist: {
    syncCron: process.env.BLOCKLIST_SYNC_CRON || '0 2 * * *',
  },

  node: {
    id: process.env.NODE_ID || 'node1',
    role: process.env.NODE_ROLE || 'primary',
    runCronJobs: process.env.RUN_CRON_JOBS !== 'false',
  },
};
