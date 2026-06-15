// PM2 ecosystem config — manages ClassGuard's two Node.js processes.
// Usage:
//   pm2 start ecosystem.config.js          # start both
//   pm2 restart ecosystem.config.js        # rolling restart
//   pm2 save && pm2 startup                # persist across reboots
//   pm2 logs classguard-api                # tail API logs
//   pm2 monit                              # live dashboard

module.exports = {
  apps: [
    {
      name:        'classguard-api',
      script:      '/opt/classguard/backend/src/index.js',
      cwd:         '/opt/classguard/backend',
      instances:   1,
      exec_mode:   'fork',

      env_production: {
        NODE_ENV:  'production',
        PORT:      3001,
      },

      // Restart on out-of-memory (512 MB guard)
      max_memory_restart: '512M',

      // Exponential backoff restarts
      exp_backoff_restart_delay: 100,
      max_restarts: 10,

      // Structured log paths
      out_file:  '/var/log/classguard/api-out.log',
      error_file: '/var/log/classguard/api-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    {
      name:   'classguard-dns',
      script: '/opt/classguard/dns-engine/src/index.js',
      cwd:    '/opt/classguard/dns-engine',
      instances: 1,
      exec_mode: 'fork',

      env_production: {
        NODE_ENV: 'production',
      },

      max_memory_restart: '256M',
      exp_backoff_restart_delay: 100,
      max_restarts: 10,

      out_file:   '/var/log/classguard/dns-out.log',
      error_file: '/var/log/classguard/dns-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
