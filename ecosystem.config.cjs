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
      // Lebih besar daripada batas penutupan rapi (services/graceful-shutdown.ts, 25 detik): PM2 menunggu permintaan
      // AI yang sedang jalan selesai sebelum SIGKILL.
      kill_timeout: 30000,
      // Auto restart on failure
      autorestart: true,
      // wait_ready sengaja tidak dipakai: api/ tidak memanggil process.send('ready'), jadi PM2 akan menunggu listen_timeout lalu menganggapnya gagal.
      // Environment file
      env_file: '.env',
    },
  ],

  // Pemroses antrean (worker) bukan bagian dari backend: ia ada di ../worker (`node dist/worker.js`, Dockerfile sendiri).
  // Blok `deploy` PM2 dihapus karena hanya berisi placeholder. Deploy memakai Docker (Railway) atau skrip aws-*.sh.
}
