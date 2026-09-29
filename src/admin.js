// The admin page's API: create, rename and delete families. Only the person
// holding ADMIN_PASSWORD can use it; without that variable it is switched off.
//
//   POST /admin/login                 { password }
//   POST /admin/logout
//   GET  /admin/api/families          -> { ok, families }
//   POST /admin/api/families          { name, username }      -> { ok, id }
//   POST /admin/api/families/:id      { name, username }
//   POST /admin/api/families/:id/delete  { confirm: <the family's username> }
const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const guard = require('./guard');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const router = express.Router();

class UserError extends Error {}
const fail = (msg) => {
  throw new UserError(msg);
};

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function cleanFamily(body) {
  const name = text(body.name, 100);
  const username = text(body.username, 40).toLowerCase();
  if (!name) fail('Give the family a name.');
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    fail('The username needs 3 to 40 characters: letters, numbers, dots, dashes or underscores.');
  }
  return { name, username };
}

// A clash on the unique username index becomes a readable message.
async function write(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    if (err.code === '23505') fail('Another family already uses that username.');
    throw err;
  }
}

router.post('/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Admin is switched off. Set ADMIN_PASSWORD on Railway to use it.' });
  if (guard.blocked('admin', req.ip)) return res.status(429).json({ ok: false, error: guard.TOO_MANY });
  if (!passwordMatches((req.body || {}).password)) {
    guard.recordFailure('admin', req.ip);
    return res.status(401).json({ ok: false, error: 'That password is not right.' });
  }
  req.session.admin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.admin = false;
  res.json({ ok: true });
});

// Everything below needs a signed-in admin.
router.use('/api', (req, res, next) => {
  if (ADMIN_PASSWORD && req.session.admin === true) return next();
  res.status(401).json({ ok: false, error: 'Sign in as admin first.' });
});

router.get('/api/families', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.username, f.created_at,
            (SELECT count(*)::int FROM profiles p WHERE p.family_id = f.id) AS profiles,
            (SELECT count(*)::int FROM links l WHERE l.family_id = f.id) AS links
       FROM families f
      ORDER BY lower(f.name), f.id`
  );
  res.json({ ok: true, families: rows });
});

router.post('/api/families', async (req, res) => {
  const { name, username } = cleanFamily(req.body || {});
  const { rows } = await write('INSERT INTO families (name, username) VALUES ($1, $2) RETURNING id', [name, username]);
  res.json({ ok: true, id: rows[0].id });
});

router.post('/api/families/:id', async (req, res) => {
  const { name, username } = cleanFamily(req.body || {});
  const { rowCount } = await write('UPDATE families SET name = $2, username = $3 WHERE id = $1', [
    parseInt(req.params.id, 10) || 0, name, username,
  ]);
  if (!rowCount) fail('That family no longer exists.');
  res.json({ ok: true });
});

// Deleting a family deletes everything in it: its profiles, links, sections and
// layout all cascade. Confirmed by typing the family's username.
router.post('/api/families/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const { rows } = await pool.query('SELECT username FROM families WHERE id = $1', [id]);
  if (!rows[0]) fail('That family no longer exists.');
  if (text((req.body || {}).confirm, 40).toLowerCase() !== rows[0].username.toLowerCase()) {
    fail(`Type ${rows[0].username} to confirm.`);
  }
  await pool.query('DELETE FROM families WHERE id = $1', [id]);
  res.json({ ok: true });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(400).json({ ok: false, error: err.message });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Something went wrong on the server. Check the Railway logs.' });
});

module.exports = { router, adminEnabled: Boolean(ADMIN_PASSWORD) };
