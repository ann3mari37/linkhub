const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add your Railway Postgres connection string.');
  process.exit(1);
}

// Railway's private network (*.railway.internal) needs no SSL; its public proxy accepts SSL
// with a self-signed cert. PGSSL=require forces SSL, PGSSL=disable turns it off.
function sslConfig() {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (/[?&]sslmode=require/i.test(connectionString)) {
    connectionString = connectionString.replace(/([?&])sslmode=require&?/i, '$1').replace(/[?&]$/, '');
    if (mode !== 'disable') return { rejectUnauthorized: false };
  }
  if (mode === 'require' || mode === 'true') return { rejectUnauthorized: false };
  return false;
}

const pool = new Pool({ connectionString, ssl: sslConfig(), max: 10 });
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Run fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, tx };
