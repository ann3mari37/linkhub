// Local development without Docker or a Supabase project: runs the Worker's own code in
// Node against PGlite (Postgres compiled to WebAssembly) with the real schema.
//   npm run dev            → http://localhost:5181
//   /admin                 → sign in with local-test-password, add a family and a username
//   /                      → sign in with that username
// Data lives in .data/pglite (delete the folder to start over).
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import worker from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5181;
const dataDir = process.env.PGLITE_DIR || path.join(root, '.data', 'pglite');
if (dataDir !== 'memory://') await mkdir(dataDir, { recursive: true });

const pg = new PGlite(dataDir);
await pg.exec(await readFile(path.join(root, 'supabase', 'schema.sql'), 'utf8'));
const wrap = (conn) => ({ q: async (text, params = []) => (await conn.query(text, params)).rows });
const db = { ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) };

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// Stand-in for the Workers static-assets binding, including its html_handling:
// /login serves login.html, /admin serves admin.html, / serves index.html.
const ASSETS = {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const pub = path.join(root, 'public');
    let file = path.normalize(path.join(pub, decodeURIComponent(pathname)));
    if (!file.startsWith(pub)) return new Response('Not found', { status: 404 });
    if (pathname === '/') file = path.join(pub, 'index.html');
    else if (!path.extname(file)) file += '.html';
    try { return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  },
};
const env = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'local-test-password', ASSETS, __db: db };

http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const headers = {}; response.headers.forEach((v, k) => { headers[k] = v; });
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (setCookie.length) headers['set-cookie'] = setCookie;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end('Dev server error'); }
}).listen(PORT, () => console.log(`LinkHub (Worker code, local Postgres) on http://localhost:${PORT}`));
