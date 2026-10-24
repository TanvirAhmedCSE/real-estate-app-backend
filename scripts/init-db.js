require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  console.log('Schema ready.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });