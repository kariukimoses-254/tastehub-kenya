const config = require('./config');
const { pool } = require('./db');
const { createApp } = require('./app');

const app = createApp({ pool, settings: config });

const server = app.listen(config.port, () => {
  console.log(`TasteHub Kenya listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received - shutting down gracefully...`);
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
