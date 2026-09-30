module.exports = {
  apps: [{
    name: 'my-production-app',
    script: 'npm',
    args: 'run dev -- --host',
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
