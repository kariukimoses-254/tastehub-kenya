const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.database,
  waitForConnections: true,
  connectionLimit: Number.parseInt(process.env.DATABASE_CONNECTION_LIMIT || '10', 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  // MySQL DATETIME/TIMESTAMP columns have no timezone. The schema writes
  // CURRENT_TIMESTAMP in the database's local time, so read/write with the
  // same local wall clock. Keep the app and database on the same timezone.
  timezone: 'local',
});

module.exports = { pool };
