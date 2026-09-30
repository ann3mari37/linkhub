// The admin page's API: families and their usernames. Only the person holding
// ADMIN_PASSWORD can use it; without that variable it is switched off.
//
//   POST /admin/login                          { password }
//   POST /admin/logout
//   GET  /admin/api/families                   -> { ok, families: [{ ..., usernames: [{ id, username }] }] }
//   POST /admin/api/families                   { name, username }  -> { ok, id }   (a family starts with one username)
//   POST /admin/api/families/:id               { name }            rename
//   POST /admin/api/families/:id/delete        { confirm: <the family's name> }
//   POST /admin/api/families/:id/usernames     { username }        add a username
//   POST /admin/api/usernames/:id/delete                           remove a username
const crypto = require('crypto');
const express = require('express');
const { pool, tx } = require('./db');
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
const idParam = (req) => parseInt(req.params.id, 10) || 0;

function cleanName(v) {
  const name = text(v, 100);
  if (!name) fail('Give the family a name.');
  return name;
}

function cleanUsername(v) {
  const username = text(v, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    fail('A username needs 3 to 40 characters: letters, numbers, dots, dashes or underscores.');
  }
  return username;
}

// A clash on the unique username index becomes a readable message.
async function addUsername(db, familyId, username) {
  try {
    await db.query('INSERT INTO family_usernames (family_id, username) VALUES ($1, $2)', [familyId, username]);
  } catch (err) {
    if (err.code === '23505') fail(`"${username}" is already in use. Usernames must be unique across all families.`);
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
    `SELECT f.id, f.name, f.created_at,
            (SELECT count(*)::int FROM profiles p WHERE p.family_id = f.id) AS profiles,
            (SELECT count(*)::int FROM links l WHERE l.family_id = f.id) AS links,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'username', u.username) ORDER BY lower(u.username))
                        FROM family_usernames u WHERE u.family_id = f.id), '[]') AS usernames
       FROM families f
      ORDER BY lower(f.name), f.id`
  );
  res.json({ ok: true, families: rows });
});

router.post('/api/families', async (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.name);
  const username = cleanUsername(b.username);
  const id = await tx(async (db) => {
    const { rows } = await db.query('INSERT INTO families (name) VALUES ($1) RETURNING id', [name]);
    await addUsername(db, rows[0].id, username);
    return rows[0].id;
  });
  res.json({ ok: true, id });
});

router.post('/api/families/:id', async (req, res) => {
  const name = cleanName((req.body || {}).name);
  const { rowCount } = await pool.query('UPDATE families SET name = $2 WHERE id = $1', [idParam(req), name]);
  if (!rowCount) fail('That family no longer exists.');
  res.json({ ok: true });
});

// Deleting a family deletes everything in it: its usernames, profiles, links,
// sections and layout all cascade. Confirmed by typing the family's name.
router.post('/api/families/:id/delete', async (req, res) => {
  const id = idParam(req);
  const { rows } = await pool.query('SELECT name FROM families WHERE id = $1', [id]);
  if (!rows[0]) fail('That family no longer exists.');
  if (text((req.body || {}).confirm, 100).toLowerCase() !== rows[0].name.trim().toLowerCase()) {
    fail(`Type the family name, ${rows[0].name}, to confirm.`);
  }
  await pool.query('DELETE FROM families WHERE id = $1', [id]);
  res.json({ ok: true });
});

router.post('/api/families/:id/usernames', async (req, res) => {
  const familyId = idParam(req);
  const username = cleanUsername((req.body || {}).username);
  const { rowCount } = await pool.query('SELECT 1 FROM families WHERE id = $1', [familyId]);
  if (!rowCount) fail('That family no longer exists.');
  await addUsername(pool, familyId, username);
  res.json({ ok: true });
});

// Anyone signed in with this username is signed out on their next request.
// A family must keep at least one, or nobody could ever sign in to it.
router.post('/api/usernames/:id/delete', async (req, res) => {
  await tx(async (db) => {
    const { rows } = await db.query('SELECT family_id FROM family_usernames WHERE id = $1', [idParam(req)]);
    if (!rows[0]) fail('That username no longer exists.');
    // lock the family so two removals at once cannot leave it with none
    await db.query('SELECT 1 FROM families WHERE id = $1 FOR UPDATE', [rows[0].family_id]);
    const { rows: c } = await db.query('SELECT count(*)::int AS n FROM family_usernames WHERE family_id = $1', [rows[0].family_id]);
    if (c[0].n <= 1) fail('This is the family\'s only username. Add another one before removing it.');
    await db.query('DELETE FROM family_usernames WHERE id = $1', [idParam(req)]);
  });
  res.json({ ok: true });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(400).json({ ok: false, error: err.message });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Something went wrong on the server. Check the Railway logs.' });
});

module.exports = { router, adminEnabled: Boolean(ADMIN_PASSWORD) };
