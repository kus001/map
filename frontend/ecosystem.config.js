module.exports = {
  apps: [{
    name: 'my-production-app',
    script: './server.js',
    instances: 'max',         // Enables Cluster Mode to utilize all CPU cores
    exec_mode: 'cluster',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
