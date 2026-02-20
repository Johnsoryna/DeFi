module.exports = {
  apps: [
    {
      name: "defi-bot",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      cwd: "/home/john/defi-bot",
      node_args: "--experimental-vm-modules",
      env: {
        NODE_ENV: "production",
      },
      // Restart policy
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/home/john/defi-bot/logs/error.log",
      out_file: "/home/john/defi-bot/logs/out.log",
      merge_logs: true,
      // Memory limit (restart if exceeds 512MB)
      max_memory_restart: "512M",
      // Watch (disabled in production — use pm2 restart for deploys)
      watch: false,
    },
  ],
};
