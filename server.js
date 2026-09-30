const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, migrate } = require('./src/db');
const { router: api, DELETE_WORD } = require('./src/api');
const { router: admin, adminEnabled } = require('./src/admin');
const guard = require('./src/guard');

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const PUBLIC = path.join(__dirname, 'public');

if (!adminEnabled) console.warn('ADMIN_PASSWORD is not set - the admin page (creating families) is switched off.');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main() {
  await migrate();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'Database unreachable: ' + err.message });
    }
  });

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set - everyone will be signed out whenever the server restarts.');
  }

  app.use(express.urlencoded({ extended: false, limit: '512kb' }));
  app.use(express.json({ limit: '512kb' }));
  app.use(
    session({
      store: new PgSession({ pool, tableName: 'sessions', createTableIfMissing: true }),
      name: 'lh.sid',
      secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 180 * 24 * 60 * 60 * 1000 },
    })
  );

  /* ---- family sign in: any one of the family's usernames is the whole sign-in ---- */

  app.post('/login', async (req, res) => {
    if (guard.blocked('family', req.ip)) return res.status(429).json({ ok: false, error: guard.TOO_MANY });
    const username = String((req.body || {}).username || '').trim().toLowerCase();
    const { rows } = username
      ? await pool.query('SELECT id FROM family_usernames WHERE lower(username) = $1', [username])
      : { rows: [] };
    if (!rows[0]) {
      guard.recordFailure('family', req.ip);
      return res.status(401).json({ ok: false, error: 'No family has that username.' });
    }
    const wasAdmin = req.session.admin === true;
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Could not start a session.' });
      // the username, not the family, so removing a username signs out whoever used it
      req.session.usernameId = rows[0].id;
      if (wasAdmin) req.session.admin = true;
      res.json({ ok: true });
    });
  });

  app.post('/logout', (req, res) => {
    delete req.session.usernameId;
    res.json({ ok: true });
  });

  /* ---- admin: creating families ---- */

  app.use('/admin', admin);
  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

  /* ---- everything else belongs to a family ---- */

  // Styles, icons and the sign-in page load before signing in.
  const OPEN = new Set(['/login.html', '/admin.html', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/assets/app.css']);
  app.use(async (req, res, next) => {
    if (OPEN.has(req.path)) return next();
    const usernameId = req.session.usernameId;
    if (usernameId) {
      // the admin may have removed the username, or the family, since this session began
      const { rows } = await pool.query(
        'SELECT f.id, f.name FROM family_usernames u JOIN families f ON f.id = u.family_id WHERE u.id = $1',
        [usernameId]
      );
      if (rows[0]) {
        req.familyId = rows[0].id;
        req.familyName = rows[0].name;
        return next();
      }
      delete req.session.usernameId;
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'You are signed out. Reload the page to sign in again.' });
    }
    res.redirect('/login.html');
  });

  app.use('/api', api);

  // index.html carries the family name and the delete confirmation word, so it is
  // filled in per request. Each deploy stamps a new version on the assets so
  // nobody runs yesterday's app.js.
  const version = Date.now().toString(36);
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/assets\/app\.(css|js)"/g, `assets/app.$1?v=${version}"`)
    .replace('__DELETE_WORD__', JSON.stringify(DELETE_WORD).replace(/</g, '\\u003c'));
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(indexHtml.replace('__FAMILY__', esc(req.familyName)));
  });

  app.use(express.static(PUBLIC, { maxAge: isProd ? '1h' : 0, index: false }));

  app.listen(PORT, () => console.log(`LinkHub listening on port ${PORT}`));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
