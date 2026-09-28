const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, migrate } = require('./src/db');
const { router: api, DELETE_WORD } = require('./src/api');
const { importOnStart } = require('./src/import');

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const PUBLIC = path.join(__dirname, 'public');

// One shared team password. Without it the page is open to anyone who finds the URL.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD is not set - anyone with the URL can view and change every link.');
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Slow down password guessing: 10 wrong tries per address per 15 minutes.
const FAIL_WINDOW = 15 * 60 * 1000;
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) return false;
  return f.count >= 10;
}
function recordFailure(ip) {
  if (failures.size > 1000) {
    for (const [k, v] of failures) if (Date.now() - v.first > FAIL_WINDOW) failures.delete(k);
  }
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

async function main() {
  await migrate();
  await importOnStart();

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

  /* ---- sign in ---- */

  const signedIn = (req) => !APP_PASSWORD || req.session.ok === true;

  app.post('/login', (req, res) => {
    if (tooManyFailures(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many wrong tries. Wait 15 minutes and try again.' });
    }
    if (!APP_PASSWORD || passwordMatches((req.body || {}).password)) {
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ ok: false, error: 'Could not start a session.' });
        req.session.ok = true;
        res.json({ ok: true });
      });
      return;
    }
    recordFailure(req.ip);
    res.status(401).json({ ok: false, error: 'That password is not right.' });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // Icons and the sign-in page itself must load before signing in.
  const OPEN = new Set(['/login.html', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/assets/app.css']);
  app.use((req, res, next) => {
    if (signedIn(req) || OPEN.has(req.path)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Your sign-in has expired. Reload the page to sign in again.' });
    }
    res.redirect('/login.html');
  });

  /* ---- app ---- */

  app.use('/api', api);

  // index.html carries the delete confirmation word, so it is filled in here. Each
  // deploy stamps a new version on the assets so nobody runs yesterday's app.js.
  const version = Date.now().toString(36);
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/assets\/app\.(css|js)"/g, `assets/app.$1?v=${version}"`)
    .replace('__DELETE_WORD__', JSON.stringify(DELETE_WORD).replace(/</g, '\\u003c'))
    .replace('__SIGN_OUT__', APP_PASSWORD ? '<a href="#" id="signOut">Sign out</a>' : '');
  const sendIndex = (req, res) => res.set('Cache-Control', 'no-store').type('html').send(indexHtml);
  app.get(['/', '/index.html'], sendIndex);

  app.use(express.static(PUBLIC, { maxAge: isProd ? '1h' : 0, index: false }));

  app.listen(PORT, () => console.log(`LinkHub listening on port ${PORT}`));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
