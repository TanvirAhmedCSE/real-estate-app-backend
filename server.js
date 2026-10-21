require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool, types } = require('pg');

types.setTypeParser(1700, parseFloat); // NUMERIC -> number

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const guard = (header, envName) => (req, res, next) => {
  const expected = process.env[envName];
  if (!expected || req.get(header) !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
};
const appAuth = guard('x-app-key', 'APP_KEY');       // Flutter
const syncAuth = guard('x-sync-secret', 'SYNC_SECRET'); // Odoo

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNIT_STATES = ['available', 'booked', 'sold'];
const REQUEST_STATUSES = ['pending', 'converted', 'cancelled'];

app.get('/health', (_req, res) => res.json({ ok: true })); // also wakes Render

// ------------------------------------------------------------------ //
// Flutter endpoints (x-app-key)
// ------------------------------------------------------------------ //
app.get('/units', appAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM units WHERE active ORDER BY project, building, name');
  res.json(rows);
}));

app.get('/units/:id', appAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM units WHERE odoo_id = $1 AND active', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'unit not found' });
  res.json(rows[0]);
}));

app.post('/units/:id/requests', appAuth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid name and email required' });

  const unit = await pool.query('SELECT state FROM units WHERE odoo_id = $1 AND active', [req.params.id]);
  if (!unit.rows.length) return res.status(404).json({ error: 'unit not found' });
  if (unit.rows[0].state !== 'available') return res.status(409).json({ error: 'unit is not available' });

  const dup = await pool.query(
    `SELECT * FROM booking_requests
     WHERE unit_odoo_id = $1 AND customer_email = $2 AND status = 'pending'`,
    [req.params.id, email]);
  if (dup.rows.length) return res.json(dup.rows[0]);

  const { rows } = await pool.query(
    `INSERT INTO booking_requests (unit_odoo_id, customer_name, customer_email)
     VALUES ($1, $2, $3) RETURNING *`,
    [req.params.id, name, email]);
  res.status(201).json(rows[0]);
}));

app.get('/requests/:id', appAuth, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query('SELECT * FROM booking_requests WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'request not found' });
  res.json(rows[0]);
}));

app.post('/requests/:id/cancel', appAuth, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query(
    `UPDATE booking_requests SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id]);
  if (rows.length) return res.json(rows[0]);
  const current = await pool.query('SELECT * FROM booking_requests WHERE id = $1', [req.params.id]);
  if (!current.rows.length) return res.status(404).json({ error: 'request not found' });
  if (current.rows[0].status === 'cancelled') return res.json(current.rows[0]);
  res.status(409).json({ error: 'request is already being processed' });
}));

// ------------------------------------------------------------------ //
// Odoo endpoints (x-sync-secret)
// ------------------------------------------------------------------ //
// Body: { units: [{ odoo_id, name, project, building, unit_type, floor, size, size_unit, price, state, active }] }
app.post('/sync/units', syncAuth, wrap(async (req, res) => {
  const units = Array.isArray(req.body.units) ? req.body.units : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of units) {
      if (!Number.isInteger(u.odoo_id) || !u.name || !UNIT_STATES.includes(u.state)) {
        throw Object.assign(new Error('invalid unit payload'), { status: 400 });
      }
      await client.query(
        `INSERT INTO units (odoo_id, name, project, building, unit_type, floor, size, size_unit, price, state, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (odoo_id) DO UPDATE SET
           name = EXCLUDED.name, project = EXCLUDED.project, building = EXCLUDED.building,
           unit_type = EXCLUDED.unit_type, floor = EXCLUDED.floor, size = EXCLUDED.size,
           size_unit = EXCLUDED.size_unit, price = EXCLUDED.price, state = EXCLUDED.state,
           active = EXCLUDED.active, updated_at = now()`,
        [u.odoo_id, u.name, u.project || null, u.building || null, u.unit_type || null,
         u.floor || null, u.size ?? null, u.size_unit || null, u.price ?? null,
         u.state, u.active !== false]);
    }
    await client.query('COMMIT');
    res.json({ synced: units.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Odoo pulls requests (optionally only those changed after ?since=ISO-8601)
app.get('/sync/requests', syncAuth, wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.since) {
    params.push(req.query.since);
    where = 'WHERE updated_at > $1';
  }
  const { rows } = await pool.query(
    `SELECT * FROM booking_requests ${where} ORDER BY updated_at`, params);
  res.json(rows);
}));

// Odoo reports conversion / cancellation back: { status: 'converted' | 'cancelled' }
app.patch('/sync/requests/:id', syncAuth, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  if (!REQUEST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'invalid status' });
  const { rows } = await pool.query(
    `UPDATE booking_requests SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, req.body.status]);
  if (!rows.length) return res.status(404).json({ error: 'request not found' });
  res.json(rows[0]);
}));

// ------------------------------------------------------------------ //
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
