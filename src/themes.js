// Per-address look. A family locked to a domain (families.domain) usually wants that
// domain to wear its own brand; the theme is picked by the address in the browser.
// Addresses not listed here get the standard LinkHub look.
//
//   css       extra stylesheet loaded after assets/app.css
//   fonts     a Google Fonts stylesheet (the CSP is widened for that address only)
//   title     replaces "LinkHub" in the page title and header
//   tagline   replaces the line under the title
//   light     true for a light theme (sets color-scheme so form controls match)
export const THEMES = {
  'admin.malindaperryconsulting.com': {
    css: '/assets/themes/malinda.css',
    fonts: 'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap',
    title: 'Link Library',
    tagline: 'MaLinda Perry Consulting',
    light: true,
  },
};

// For trying a theme locally: http://malinda.localhost:5181 uses the MaLinda theme.
const LOCAL = { 'malinda.localhost': 'admin.malindaperryconsulting.com' };

// The address a request counts as: real hostnames as-is, local stand-ins mapped to theirs.
export function canonicalHost(host) {
  const h = String(host || '').toLowerCase();
  return LOCAL[h] || h;
}

export function themeFor(host) {
  return THEMES[canonicalHost(host)] || null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Rewrites one of the HTML pages (/, /login, /admin) for a themed address.
export function applyTheme(html, theme) {
  if (!theme) return html;
  let out = html;
  if (theme.light) out = out.replace('<meta name="color-scheme" content="dark">', '<meta name="color-scheme" content="light">');
  if (theme.title) {
    out = out.replace(/<title>([^<]*)LinkHub([^<]*)<\/title>/, (_, a, b) => `<title>${a}${esc(theme.title)}${b}</title>`)
      .replace(/(<div class="brand-name">)LinkHub/, `$1${esc(theme.title)}`);
  }
  if (theme.tagline) {
    out = out.replace(/(<div class="brand-tag">)[^<]*(<\/div>)/, `$1${esc(theme.tagline)}$2`);
  }
  const links = (theme.fonts
    ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${esc(theme.fonts)}">\n`
    : '') + `<link rel="stylesheet" href="${esc(theme.css)}">\n`;
  return out.replace('</head>', `${links}</head>`);
}

// The CSP for a themed address: the same policy, plus Google Fonts when the theme uses them.
export function cspFor(base, theme) {
  if (!theme || !theme.fonts) return base;
  return base
    .replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")
    .replace("default-src 'self';", "default-src 'self'; font-src 'self' https://fonts.gstatic.com;");
}
