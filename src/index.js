// LinkHub — Cloudflare Worker.
// Serves the app from static assets, and the JSON API under /api and /admin/api,
// backed by Supabase Postgres.
// Secrets: DATABASE_URL (or a HYPERDRIVE binding) and ADMIN_PASSWORD (the /admin page,
// where families and their usernames are managed; without it /admin is switched off).
// Optional variable: DELETE_WORD, the word typed to confirm a delete (default "yes").
import { openDb } from './db.js';
import * as api from './api.js';
import * as admin from './admin.js';

const SESSION_DAYS = 180;
const DAY = 864e5;
// A request that hasn't finished by now gets a clear error instead of leaving the app on
// "Loading…" (a stalled database connection otherwise never answers).
const REQUEST_TIMEOUT_MS = 20000;
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60 * 1000;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Robots-Tag': 'noindex, nofollow',
  // Link icons come from every site the family adds, so images may load from anywhere.
  'Content-Security-Policy': "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/* ---------------- helpers ---------------- */
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, message, headers) => json(status, { ok: false, error: message }, headers);
const redirect = (to) => new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: to, 'Cache-Control': 'no-store' } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
// Compares digests so the time taken doesn't depend on where the strings differ.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(`cmp:${a}`), sha256(`cmp:${b}`)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parseCookies = (req) => Object.fromEntries(String(req.headers.get('cookie') || '').split(';').map((p) => p.trim().split('='))
  .filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const COOKIE = 'lh_session';
const sessionCookie = (url, token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
const clientIp = (req) => req.headers.get('cf-connecting-ip') || String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
const deleteWordOf = (env) => String(env.DELETE_WORD || 'yes').trim().toLowerCase() || 'yes';

async function readBody(req, limit = 512 * 1024) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > limit) throw api.bad('Request too large.', 413);
  const raw = await req.text();
  if (raw.length > limit) throw api.bad('Request too large.', 413);
  return raw;
}
// The link page posts form-encoded data (and sendBeacon can only send that); the admin
// page posts JSON. Either way the handlers get a plain object.
async function readFields(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  if ((req.headers.get('content-type') || '').includes('application/json')) {
    try { return JSON.parse(raw) || {}; } catch { throw api.bad('Invalid JSON.'); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Forged requests: a change must come from this site. Browsers send Origin with every
// POST (including sendBeacon) and Sec-Fetch-Site on modern versions; the session
// cookie is also SameSite=Lax, so another site's form can't carry it.
function crossSite(req, url) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return true;
  return req.headers.get('sec-fetch-site') === 'cross-site';
}

/* ---------------- sessions ---------------- */
// Only a hash of the token is stored. A session belongs to the username it signed in
// with (removing the username or its family deletes it) and may also be an admin.
async function readSession(db, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const hash = await sha256(token);
  const [row] = await db.q(
    `select s.token_hash, s.username_id, s.admin, f.id as family_id, f.name as family_name
       from sessions s
       left join family_usernames u on u.id = s.username_id
       left join families f on f.id = u.family_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hash]
  );
  return row || null;
}

// Signing in always issues a fresh token (so a token planted before sign-in is useless),
// carrying over whatever the old session already had.
async function startSession(db, url, old, changes) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const usernameId = 'usernameId' in changes ? changes.usernameId : (old ? old.username_id : null);
  const isAdmin = 'admin' in changes ? changes.admin : (old ? old.admin : false);
  await db.q('delete from sessions where expires_at < now()');
  if (old) await db.q('delete from sessions where token_hash = $1', [old.token_hash]);
  await db.q(
    `insert into sessions (token_hash, username_id, admin, expires_at) values ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`,
    [await sha256(token), usernameId, isAdmin]
  );
  return sessionCookie(url, token, SESSION_DAYS * DAY / 1000);
}

// Signing out of one side keeps the other (family vs admin); with neither left, the session goes.
async function endPart(db, url, s, part) {
  if (!s) return {};
  const keepFamily = part !== 'family' && s.username_id;
  const keepAdmin = part !== 'admin' && s.admin;
  if (!keepFamily && !keepAdmin) {
    await db.q('delete from sessions where token_hash = $1', [s.token_hash]);
    return { 'Set-Cookie': sessionCookie(url, '', 0) };
  }
  await db.q('update sessions set username_id = $2, admin = $3 where token_hash = $1', [s.token_hash, keepFamily ? s.username_id : null, !!keepAdmin]);
  return {};
}

/* ---------------- sign-in attempts ---------------- */
async function tooManyAttempts(db, key) {
  const [a] = await db.q('select count, first_at from login_attempts where key = $1', [key]);
  if (!a) return false;
  if (Date.now() - new Date(a.first_at).getTime() > WINDOW_MS) {
    await db.q('delete from login_attempts where key = $1', [key]);
    return false;
  }
  return a.count >= MAX_TRIES;
}
async function noteFailure(db, key) {
  await db.q(`insert into login_attempts (key, count, first_at) values ($1, 1, now())
    on conflict (key) do update set count = login_attempts.count + 1`, [key]);
}
const TOO_MANY = 'Too many wrong tries. Wait 15 minutes and try again.';

/* ---------------- routes ---------------- */
// opts.need: 'family' (signed in to a family), 'admin' (signed in on /admin), or none.
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; })}$`);
  routes.push({ method, re, keys, handler, need: opts.need || null });
};

/* ---- family sign-in: any one of the family's usernames is the whole sign-in ---- */
route('POST', '/login', async ({ req, db, url, session }) => {
  const key = `family:${clientIp(req)}`;
  if (await tooManyAttempts(db, key)) return fail(429, TOO_MANY);
  const username = String((await readFields(req)).username || '').trim().toLowerCase();
  const [row] = username ? await db.q('select id from family_usernames where lower(username) = $1', [username]) : [];
  if (!row) {
    await noteFailure(db, key);
    return fail(401, 'No family has that username.');
  }
  return json(200, { ok: true }, { 'Set-Cookie': await startSession(db, url, session, { usernameId: row.id }) });
});
route('POST', '/logout', async ({ db, url, session }) => json(200, { ok: true }, await endPart(db, url, session, 'family')));

/* ---- the family's links ---- */
route('GET', '/api/data', async ({ db, url, session }) => json(200, await api.getData(db, session.family_id, url.searchParams.get('profileId'))), { need: 'family' });
route('POST', '/api/save', async ({ req, db, env, session }) => json(200, await api.save(db, session.family_id, await readFields(req), deleteWordOf(env))), { need: 'family' });
route('GET', '/api/icon', async ({ db, url, session }) => json(200, await api.icon(db, session.family_id, url.searchParams.get('linkId'), url.searchParams.get('url'))), { need: 'family' });

/* ---- admin: families and usernames ---- */
route('POST', '/admin/login', async ({ req, db, env, url, session }) => {
  if (!env.ADMIN_PASSWORD) return fail(403, 'Admin is switched off. Set the ADMIN_PASSWORD secret on the Worker to use it.');
  const key = `admin:${clientIp(req)}`;
  if (await tooManyAttempts(db, key)) return fail(429, TOO_MANY);
  if (!(await sameSecret(String((await readFields(req)).password || ''), env.ADMIN_PASSWORD))) {
    await noteFailure(db, key);
    return fail(401, 'That password is not right.');
  }
  return json(200, { ok: true }, { 'Set-Cookie': await startSession(db, url, session, { admin: true }) });
});
route('POST', '/admin/logout', async ({ db, url, session }) => json(200, { ok: true }, await endPart(db, url, session, 'admin')));
route('GET', '/admin/api/families', async ({ db }) => json(200, await admin.listFamilies(db)), { need: 'admin' });
route('POST', '/admin/api/families', async ({ req, db }) => json(200, await admin.createFamily(db, await readFields(req))), { need: 'admin' });
route('POST', '/admin/api/families/:id', async ({ req, db, p }) => json(200, await admin.renameFamily(db, Number(p.id), await readFields(req))), { need: 'admin' });
route('POST', '/admin/api/families/:id/delete', async ({ req, db, p }) => json(200, await admin.deleteFamily(db, Number(p.id), await readFields(req))), { need: 'admin' });
route('POST', '/admin/api/families/:id/usernames', async ({ req, db, p }) => json(200, await admin.addFamilyUsername(db, Number(p.id), await readFields(req))), { need: 'admin' });
route('POST', '/admin/api/usernames/:id/delete', async ({ db, p }) => json(200, await admin.removeUsername(db, Number(p.id))), { need: 'admin' });

/* ---- the link page itself: carries the family's name and the delete word ---- */
route('GET', '/', async ({ req, env, url, session }) => {
  if (!session || !session.family_id) return redirect('/login');
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: req.headers }));
  const html = (await res.text())
    .replace('__FAMILY__', escHtml(session.family_name))
    .replace('__DELETE_WORD__', escHtml(deleteWordOf(env)));
  return new Response(html, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
});

/* ---------------- entry ---------------- */
async function handle(req, env, ctx, url, r) {
  if (req.method !== 'GET' && crossSite(req, url)) return fail(403, 'Forbidden.');
  let db = {};
  let timer;
  const run = async () => {
    const session = await readSession(db, req);
    if (r.need === 'family' && !(session && session.family_id)) return fail(401, 'You are signed out. Reload the page to sign in again.');
    if (r.need === 'admin' && !(env.ADMIN_PASSWORD && session && session.admin)) return fail(401, 'Sign in as admin first.');
    const m = url.pathname.match(r.re);
    const p = {};
    r.keys.forEach((k, i) => { p[k] = m[i + 1]; });
    return r.handler({ req, env, ctx, url, db, p, session });
  };
  try {
    // Inside the try, so a missing DATABASE_URL comes back as a readable error, not a crash.
    db = openDb(env, ctx);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(api.bad('The database didn’t answer in time. Please try again in a moment.', 504)), REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([run(), timeout]);
  } catch (err) {
    if (!err.expose || err.status === 504) console.error(err);
    return fail(err.status || 500, err.expose ? err.message : 'Something went wrong on the server.');
  } finally {
    clearTimeout(timer);
    if (db.close) db.close();
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/index.html') return redirect('/');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (r) return handle(req, env, ctx, url, r);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/')) return fail(404, 'Not found.');
    // Everything else is a static file: the sign-in page (/login), the admin page (/admin),
    // styles, scripts and icons. None of them hold any family's data.
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => out.headers.set(k, v));
    if ((out.headers.get('content-type') || '').includes('text/html')) out.headers.set('Cache-Control', 'no-cache');
    return out;
  },
};
