module.exports = {
  apps: [
    {
      name: 'applify-api',
      script: './dist/api/index.js',
      instances: 'max', // Use all CPU cores
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_memory_restart: '1G',
      restart_delay: 3000,
      max_restarts: 5,
      min_uptime: '10s',
      // Health monitoring
      listen_timeout: 8000,
      kill_timeout: 5000,
      // Auto restart on failure
      autorestart: true,
      // Graceful shutdown
      wait_ready: true,
      // Environment file
      env_file: '.env',
    },
    {
      name: 'applify-worker',
      script: './dist/services/queue.service.js',
      instances: 2,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      log_file: './logs/worker-combined.log',
      out_file: './logs/worker-out.log',
      error_file: './logs/worker-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      env_file: '.env',
    },
  ],

  deploy: {
    production: {
      user: 'deploy',
      host: ['your-aws-ip'],
      ref: 'origin/main',
      repo: 'https://github.com/Shenhan01-sys/applify-smart-job-applications.git',
      path: '/var/www/applify/backend',
      'post-deploy': `
        npm install &&
        npm run build &&
        pm2 reload ecosystem.config.cjs --env production &&
        pm2 save
      `,
      env: {
        NODE_ENV: 'production',
      },
    },
  },
}
