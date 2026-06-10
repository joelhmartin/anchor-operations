import './loadEnv.js';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Please update your .env file.');
}

const pool = new Pool({
  connectionString,
  // Connection timeout settings to prevent hanging
  connectionTimeoutMillis: 10000, // 10 seconds to establish connection
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  max: 20 // Maximum pool size
});

export function query(text, params) {
  return pool.query(text, params);
}

export function getClient() {
  return pool.connect();
}

export { pool };
