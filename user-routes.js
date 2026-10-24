const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail } = require('./email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const TOKEN_TTL = '30d';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const newOtp = () => String(crypto.randomInt(100000, 1000000));
const normEmail = (v) => String(v || '').trim().toLowerCase();

async function mail(email, code) {
  try {
    await sendVerificationEmail(email, code);
  } catch (e) {
    console.error('Brevo error:', (e.response && e.response.body) || e.message);
    throw httpError(502, 'Could not send the verification email. Please try again.');
  }
}

// The code was sent at (expiry - TTL); used to throttle resends.
const recentlySent = (u) =>
  u.verify_otp_expiry &&
  Date.now() - (new Date(u.verify_otp_expiry).getTime() - OTP_TTL_MS) < RESEND_COOLDOWN_MS;

module.exports = function createUserRoutes({ pool, wrap }) {
  const authRouter = express.Router();
  const favoritesRouter = express.Router();

  async function issueCode(user) {
    const code = newOtp();
    await pool.query(
      `UPDATE users SET verify_otp = $2, verify_otp_expiry = $3, otp_attempts = 0 WHERE id = $1`,
      [user.id, code, new Date(Date.now() + OTP_TTL_MS)]);
    await mail(user.email, code);
  }

  function userAuth(req, res, next) {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Please log in.', code: 'invalid_token' });
    }
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET); // { id }
      next();
    } catch (_) {
      res.status(401).json({ error: 'Session expired. Please log in again.', code: 'invalid_token' });
    }
  }

  // ---------------------------------------------------------------- auth
  authRouter.post('/register', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = normEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!name) throw httpError(400, 'Name is required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email.');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters.');

    const code = newOtp();
    const hash = await bcrypt.hash(password, 10);
    // New account, or re-register of an account that never got verified.
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, verify_otp, verify_otp_expiry, otp_attempts)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
         verify_otp = EXCLUDED.verify_otp, verify_otp_expiry = EXCLUDED.verify_otp_expiry,
         otp_attempts = 0
       WHERE users.is_verified = FALSE
       RETURNING id`,
      [name, email, hash, code, new Date(Date.now() + OTP_TTL_MS)]);
    if (!rows.length) throw httpError(409, 'This email is already registered. Please log in.');

    await mail(email, code);
    res.status(201).json({ message: 'Account created. Check your email for the verification code.' });
  }));

  authRouter.post('/verify-email', wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const bad = httpError(400, 'Invalid or expired code.');

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (!u) throw bad;
    if (u.is_verified) throw httpError(400, 'Email is already verified. Please log in.');
    if (!u.verify_otp || !u.verify_otp_expiry || new Date(u.verify_otp_expiry) < new Date()) throw bad;

    if (u.verify_otp !== code) {
      await pool.query(
        `UPDATE users SET otp_attempts = otp_attempts + 1,
           verify_otp = CASE WHEN otp_attempts + 1 >= $2 THEN NULL ELSE verify_otp END
         WHERE id = $1`, [u.id, MAX_OTP_ATTEMPTS]);
      throw bad;
    }
    await pool.query(
      `UPDATE users SET is_verified = TRUE, verify_otp = NULL, verify_otp_expiry = NULL, otp_attempts = 0
       WHERE id = $1`, [u.id]);
    res.json({ message: 'Email verified. You can log in now.' });
  }));

  authRouter.post('/resend-code', wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (u && !u.is_verified) {
      if (recentlySent(u)) throw httpError(429, 'Please wait a few seconds before requesting another code.');
      await issueCode(u);
    }
    res.json({ message: 'If the account exists, a new code has been sent.' });
  }));

  authRouter.post('/login', wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      throw httpError(401, 'Incorrect email or password.');
    }
    if (!u.is_verified) {
      if (!recentlySent(u)) await issueCode(u); // send a fresh code so the app can go straight to verify
      return res.status(403).json({ error: 'Please verify your email first.', code: 'not_verified' });
    }
    const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email } });
  }));

  // ----------------------------------------------------------- favourites
  favoritesRouter.use(userAuth);

  favoritesRouter.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT unit_odoo_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows.map((r) => r.unit_odoo_id));
  }));

  favoritesRouter.put('/:unitId', wrap(async (req, res) => {
    const unitId = Number(req.params.unitId);
    if (!Number.isInteger(unitId)) throw httpError(400, 'invalid unit id');
    const unit = await pool.query('SELECT 1 FROM units WHERE odoo_id = $1 AND active', [unitId]);
    if (!unit.rows.length) throw httpError(404, 'unit not found');
    await pool.query(
      `INSERT INTO favorites (user_id, unit_odoo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, unitId]);
    res.json({ ok: true });
  }));

  favoritesRouter.delete('/:unitId', wrap(async (req, res) => {
    const unitId = Number(req.params.unitId);
    if (!Number.isInteger(unitId)) throw httpError(400, 'invalid unit id');
    await pool.query('DELETE FROM favorites WHERE user_id = $1 AND unit_odoo_id = $2', [req.user.id, unitId]);
    res.json({ ok: true });
  }));

  return { authRouter, favoritesRouter };
};
