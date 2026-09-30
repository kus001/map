module.exports = {
  apps: [{
    name: 'my-production-app',
    script: 'npm',
    args: 'run preview -- --host 0.0.0.0 --port 5173',
    env_production: {
      NODE_ENV: 'production',
      PORT: 5173
    }
  }]
};
