// Finds the icon a site declares for itself. The browser cannot read another
// origin's HTML (CORS), so the server does it: fetch the page, read its
// <link rel="icon">, follow redirects, and confirm the answer really is an
// image. Returns an absolute URL the browser can load, or ''.
const dns = require('dns').promises;
const net = require('net');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Whatever was typed into the address field, as an http(s) URL - or null.
function httpUrlOf(input) {
  let s = String(input || '').trim();
  if (!s || s.startsWith('\\')) return null; // UNC share - nothing to fetch
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return u.toString();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// Refuse to fetch anything on a private network (the server must not be used to probe internals).
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('blocked host');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked host');
    return;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked host');
}

async function readLimited(res, maxBytes, allowTruncate) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      if (!allowTruncate) throw new Error('response too large');
      chunks.push(value.subarray(0, value.length - (total - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function safeFetch(url, { maxBytes, accept, allowTruncate = false }) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    await assertPublicHost(u.hostname);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error('HTTP ' + res.status);
    }
    const buf = await readLimited(res, maxBytes, allowTruncate);
    return { url: current, buf };
  }
  throw new Error('too many redirects');
}

// Identify an image from its bytes; rejects HTML error pages served with status 200.
function isImage(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // png
  if (buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0) return true; // ico
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // jpeg
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return true;
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return true;
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg'));
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"');

// Every icon the page declares, best first.
function parseIconLinks(html, pageUrl) {
  let base = pageUrl;
  const bm = html.match(/<base\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/i);
  if (bm) {
    try {
      base = new URL(decodeEntities(bm[1]), pageUrl).toString();
    } catch {}
  }
  const found = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = {};
    for (const a of m[0].matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4];
    }
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
    const isIcon = rel.includes('icon');
    const isApple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if ((!isIcon && !isApple) || !attrs.href) continue;
    let href = decodeEntities(attrs.href.trim());
    // an icon embedded in the page is used as-is; anything else is made absolute
    if (!/^data:/i.test(href)) {
      try {
        href = new URL(href, base).toString();
      } catch {
        continue;
      }
    }
    const size = parseInt((attrs.sizes || '').split(/[x\s]/i)[0], 10) || 0;
    const type = (attrs.type || '').toLowerCase();
    let score = isIcon ? 100 : 50;
    if (type.includes('svg') || /\.svg(\?|#|$)/i.test(href)) score += 30;
    if (size >= 32 && size <= 192) score += 20;
    else if (size > 192) score += 5;
    found.push({ href, score });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

// Icons embedded in the page as data: URIs. Kept only if the bytes really are an
// image and small enough to store on the link and send with every page load.
const MAX_DATA_ICON = 64 * 1024;
function dataIcon(uri) {
  if (uri.length > MAX_DATA_ICON) return '';
  const m = uri.match(/^data:(image\/[a-z0-9.+-]+)?[^,]*?(;base64)?,(.*)$/is);
  if (!m || !m[1]) return '';
  let buf;
  try {
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch {
    return '';
  }
  return isImage(buf) ? uri : '';
}

async function findIcon(rawUrl) {
  const url = httpUrlOf(rawUrl);
  if (!url) return '';
  const candidates = [];
  try {
    const page = await safeFetch(url, {
      maxBytes: 768 * 1024,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      allowTruncate: true,
    });
    candidates.push(...parseIconLinks(page.buf.toString('utf8'), page.url));
    // after redirects the canonical host is the one whose favicon counts
    candidates.push(new URL('/favicon.ico', page.url).toString());
  } catch {
    // Sign-in pages and bot walls often refuse; the generic location may still work.
  }
  candidates.push(new URL('/favicon.ico', url).toString());

  for (const href of [...new Set(candidates)]) {
    if (/^data:/i.test(href)) {
      const icon = dataIcon(href);
      if (icon) return icon;
      continue;
    }
    try {
      const r = await safeFetch(href, { maxBytes: 300 * 1024, accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8' });
      if (isImage(r.buf)) return r.url;
    } catch {}
  }
  return '';
}

module.exports = { findIcon, httpUrlOf };
