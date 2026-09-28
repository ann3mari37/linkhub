// The JSON API the front end talks to. Same contract as the original
// LinkHub's api/data.asp, api/save.asp and api/icon.asp:
//
//   GET  /api/data?profileId=N          -> { ok, profiles, profileId, sections, links }
//   POST /api/save   action=...&...     -> { ok, id? } or { ok:false, error }
//   GET  /api/icon?linkId=N&url=...     -> { ok, icon }
//
// Every response is JSON with an `ok` flag; the client shows `error` verbatim.
const express = require('express');
const { pool, tx } = require('./db');
const { findIcon, httpUrlOf } = require('./icon');

const DELETE_WORD = (process.env.DELETE_WORD || 'yes').trim().toLowerCase();
const router = express.Router();

class UserError extends Error {}
const fail = (msg) => {
  throw new UserError(msg);
};

const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const color = (v, dflt) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : dflt);
const idList = (v) => [...new Set(String(v || '').split(',').map(int).filter((n) => n > 0))];

// Addresses are stored as typed, with https:// added when the scheme is left off.
// UNC shares (\\server\share) are kept as-is. Anything that could run script
// when clicked (javascript:, data:, ...) is refused.
function cleanUrl(raw) {
  let u = text(raw, 1000);
  if (!u) return '';
  if (u.startsWith('\\\\')) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u) || /^[^:/]+:\d+(\/|$)/.test(u)) u = 'https://' + u;
  if (!/^(https?|ftp|file|mailto):/i.test(u)) fail('Only web addresses (http or https) and network shares can be saved.');
  return u;
}

// An icon the client already has: an image data URI, or an http(s) image URL.
const cleanThumbData = (v) => {
  const s = String(v || '');
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(s) && s.length <= 200 * 1024 ? s : '';
};
const cleanThumbUrl = (v) => {
  const s = text(v, 1000);
  return /^https?:\/\//i.test(s) ? s : '';
};

const iso = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');

// The profile asked for if it exists, otherwise the first one by name.
async function resolveProfileId(want) {
  const { rows } = await pool.query(
    `SELECT id FROM profiles ORDER BY (id = $1) DESC, lower(name), id LIMIT 1`,
    [int(want)]
  );
  return rows[0] ? rows[0].id : 0;
}

async function requireProfile(db, profileId) {
  const id = int(profileId);
  if (id > 0) {
    const { rowCount } = await db.query('SELECT 1 FROM profiles WHERE id = $1', [id]);
    if (rowCount) return id;
  }
  fail('Choose your profile first (the button at the top of the page).');
}

async function requireSection(db, profileId, sectionId) {
  const { rowCount } = await db.query('SELECT 1 FROM sections WHERE id = $1 AND profile_id = $2', [sectionId, profileId]);
  if (!rowCount) fail('That section no longer exists. Reload the page and try again.');
}

function requireConfirm(word) {
  if (String(word || '').trim().toLowerCase() !== DELETE_WORD) fail(`Type ${DELETE_WORD} to confirm the delete.`);
}

// Put a link at the end of a section on one profile's page (no-op if it is already there).
async function fileLink(db, profileId, linkId, sectionId) {
  await db.query(
    `INSERT INTO placements (profile_id, link_id, section_id, sort)
     SELECT $1, $2, $3, COALESCE(MAX(sort), -1) + 1 FROM placements WHERE section_id = $3
     ON CONFLICT (profile_id, link_id) DO UPDATE
       SET section_id = EXCLUDED.section_id, sort = EXCLUDED.sort
       WHERE placements.section_id <> EXCLUDED.section_id`,
    [profileId, linkId, sectionId]
  );
}

/* ---------------- data ---------------- */

router.get('/data', async (req, res) => {
  const profileId = await resolveProfileId(req.query.profileId);
  const [profiles, sections, links] = await Promise.all([
    pool.query('SELECT id, name, color FROM profiles ORDER BY lower(name), id'),
    pool.query('SELECT id, title, accent, sort FROM sections WHERE profile_id = $1 ORDER BY sort, id', [profileId]),
    pool.query(
      `SELECT l.*, p.section_id, p.sort, u.last_used, u.use_count
         FROM links l
         LEFT JOIN placements p ON p.link_id = l.id AND p.profile_id = $1
         LEFT JOIN link_usage u ON u.link_id = l.id AND u.profile_id = $1
        ORDER BY p.sort NULLS LAST, lower(l.title), l.id`,
      [profileId]
    ),
  ]);

  res.json({
    ok: true,
    profiles: profiles.rows,
    profileId,
    sections: sections.rows,
    links: links.rows.map((l) => ({
      id: l.id,
      sectionId: l.section_id || 0,
      title: l.title,
      url: l.url,
      desc: l.description,
      thumbData: l.thumb_data,
      thumbUrl: l.thumb_url,
      tips: l.tips,
      newTab: l.new_tab,
      created: iso(l.created_at),
      edited: iso(l.edited_at),
      used: iso(l.last_used),
      useCount: l.use_count || 0,
      sort: l.sort || 0,
    })),
  });
});

/* ---------------- save ---------------- */

const actions = {
  /* profiles - the only action allowed without a current profile */
  async 'profile.save'(b) {
    const name = text(b.name, 100);
    if (!name) fail('Give the profile a name.');
    const c = color(b.color, '#4c8dff');
    const id = int(b.id);
    if (id > 0) {
      const { rowCount } = await pool.query('UPDATE profiles SET name = $2, color = $3 WHERE id = $1', [id, name, c]);
      if (!rowCount) fail('That profile no longer exists.');
      return { id };
    }
    const { rows } = await pool.query('INSERT INTO profiles (name, color) VALUES ($1, $2) RETURNING id', [name, c]);
    return { id: rows[0].id };
  },

  async 'profile.delete'(b) {
    requireConfirm(b.confirm);
    return tx(async (db) => {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM profiles');
      if (rows[0].n <= 1) fail('This is the only profile. Create another one before deleting it.');
      const { rowCount } = await db.query('DELETE FROM profiles WHERE id = $1', [int(b.id)]);
      if (!rowCount) fail('That profile no longer exists.');
      return {};
    });
  },

  /* sections - always the current profile's own */
  async 'section.save'(b) {
    const profileId = await requireProfile(pool, b.profileId);
    const title = text(b.title, 100);
    if (!title) fail('Give the section a name.');
    const accent = color(b.accent, '#4c8dff');
    const id = int(b.id);
    if (id > 0) {
      const { rowCount } = await pool.query(
        'UPDATE sections SET title = $3, accent = $4 WHERE id = $1 AND profile_id = $2',
        [id, profileId, title, accent]
      );
      if (!rowCount) fail('That section no longer exists. Reload the page and try again.');
      return { id };
    }
    const { rows } = await pool.query(
      `INSERT INTO sections (profile_id, title, accent, sort)
       SELECT $1, $2, $3, COALESCE(MAX(sort), -1) + 1 FROM sections WHERE profile_id = $1
       RETURNING id`,
      [profileId, title, accent]
    );
    return { id: rows[0].id };
  },

  async 'section.delete'(b) {
    requireConfirm(b.confirm);
    const profileId = await requireProfile(pool, b.profileId);
    // its placements cascade away, so its links drop back into Unsorted
    const { rowCount } = await pool.query('DELETE FROM sections WHERE id = $1 AND profile_id = $2', [int(b.id), profileId]);
    if (!rowCount) fail('That section no longer exists.');
    return {};
  },

  async 'reorder.sections'(b) {
    const profileId = await requireProfile(pool, b.profileId);
    await pool.query(
      `UPDATE sections s SET sort = t.ord - 1
         FROM unnest($2::int[]) WITH ORDINALITY AS t(id, ord)
        WHERE s.id = t.id AND s.profile_id = $1`,
      [profileId, idList(b.ids)]
    );
    return {};
  },

  /* links - one shared catalog; placement is per profile */
  async 'link.save'(b) {
    const url = cleanUrl(b.url);
    const title = text(b.title, 150);
    if (!url) fail('Give the link a web address.');
    if (!title) fail('Give the link a name.');
    const desc = text(b.desc, 500);
    const tips = text(b.tips, 4000);
    const newTab = String(b.newTab) !== '0';
    const sectionId = int(b.sectionId);
    const id = int(b.id);

    return tx(async (db) => {
      const profileId = sectionId > 0 || int(b.profileId) > 0 ? await requireProfile(db, b.profileId) : 0;
      if (sectionId > 0) await requireSection(db, profileId, sectionId);

      let linkId = id;
      if (id > 0) {
        const { rows } = await db.query('SELECT url FROM links WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) fail('That link no longer exists. Reload the page and try again.');
        // a new address means the old icon no longer applies
        const sameUrl = rows[0].url === url;
        await db.query(
          `UPDATE links SET title = $2, url = $3, description = $4, tips = $5, new_tab = $6,
                  thumb_data = $7, thumb_url = $8, edited_at = now()
            WHERE id = $1`,
          [id, title, url, desc, tips, newTab,
           sameUrl ? cleanThumbData(b.thumbData) : '', sameUrl ? cleanThumbUrl(b.thumbUrl) : '']
        );
      } else {
        const { rows } = await db.query(
          `INSERT INTO links (title, url, description, tips, new_tab, thumb_data, thumb_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [title, url, desc, tips, newTab, cleanThumbData(b.thumbData), cleanThumbUrl(b.thumbUrl)]
        );
        linkId = rows[0].id;
      }

      if (profileId) {
        if (sectionId > 0) await fileLink(db, profileId, linkId, sectionId);
        else await db.query('DELETE FROM placements WHERE profile_id = $1 AND link_id = $2', [profileId, linkId]);
      }
      return { id: linkId };
    });
  },

  async 'link.delete'(b) {
    requireConfirm(b.confirm);
    const { rowCount } = await pool.query('DELETE FROM links WHERE id = $1', [int(b.id)]);
    if (!rowCount) fail('That link no longer exists.');
    return {};
  },

  async 'link.reseticon'(b) {
    await pool.query(`UPDATE links SET thumb_url = '', thumb_data = '' WHERE id = $1`, [int(b.id)]);
    iconMisses.clear();
    return {};
  },

  // Sent with navigator.sendBeacon as a link opens; never worth an error.
  async 'link.used'(b) {
    await pool.query(
      `INSERT INTO link_usage (profile_id, link_id, last_used, use_count)
       SELECT p.id, l.id, now(), 1 FROM profiles p, links l WHERE p.id = $1 AND l.id = $2
       ON CONFLICT (profile_id, link_id) DO UPDATE
         SET last_used = now(), use_count = link_usage.use_count + 1`,
      [int(b.profileId), int(b.id)]
    );
    return {};
  },

  // The full order of one section after a drop. Links listed are filed there in
  // that order (moving them out of wherever they were); links that were in it
  // and are not listed go back to Unsorted. sectionId 0 means "unfile these".
  async 'reorder.links'(b) {
    const sectionId = int(b.sectionId);
    const ids = idList(b.ids);
    if (sectionId < 0) fail('Links cannot be dropped there.');
    return tx(async (db) => {
      const profileId = await requireProfile(db, b.profileId);
      if (sectionId === 0) {
        await db.query('DELETE FROM placements WHERE profile_id = $1 AND link_id = ANY($2::int[])', [profileId, ids]);
        return {};
      }
      await requireSection(db, profileId, sectionId);
      await db.query(
        'DELETE FROM placements WHERE profile_id = $1 AND section_id = $2 AND NOT (link_id = ANY($3::int[]))',
        [profileId, sectionId, ids]
      );
      await db.query(
        `INSERT INTO placements (profile_id, link_id, section_id, sort)
         SELECT $1, l.id, $2, (t.ord - 1)::int
           FROM unnest($3::int[]) WITH ORDINALITY AS t(id, ord)
           JOIN links l ON l.id = t.id
         ON CONFLICT (profile_id, link_id) DO UPDATE
           SET section_id = EXCLUDED.section_id, sort = EXCLUDED.sort`,
        [profileId, sectionId, ids]
      );
      return {};
    });
  },
};

router.post('/save', async (req, res) => {
  const b = req.body || {};
  const fn = Object.prototype.hasOwnProperty.call(actions, b.action) ? actions[b.action] : null;
  if (!fn) return res.status(400).json({ ok: false, error: `Unknown action "${text(b.action, 40)}".` });
  const out = await fn(b);
  res.json({ ok: true, ...out });
});

/* ---------------- icon ---------------- */

// Addresses with no icon, so every tile on every screen does not re-fetch them.
const MISS_TTL = 6 * 60 * 60 * 1000;
const iconMisses = new Map();
const inFlight = new Map();

router.get('/icon', async (req, res) => {
  const linkId = int(req.query.linkId);
  let url = req.query.url;
  let stored = null;

  if (linkId > 0) {
    const { rows } = await pool.query('SELECT url, thumb_url FROM links WHERE id = $1', [linkId]);
    if (!rows[0]) return res.json({ ok: false, error: 'No such link.' });
    if (rows[0].thumb_url) return res.json({ ok: true, icon: rows[0].thumb_url });
    stored = rows[0].url;
    url = stored;
  }

  const key = httpUrlOf(url);
  if (!key) return res.json({ ok: true, icon: '' });
  const miss = iconMisses.get(key);
  if (miss && Date.now() - miss < MISS_TTL) return res.json({ ok: true, icon: '' });

  if (!inFlight.has(key)) {
    inFlight.set(key, findIcon(key).catch(() => '').finally(() => inFlight.delete(key)));
  }
  const icon = await inFlight.get(key);

  if (!icon) {
    iconMisses.set(key, Date.now());
  } else if (stored) {
    // only if the address has not been edited while we were looking
    await pool.query(`UPDATE links SET thumb_url = $2 WHERE id = $1 AND url = $3 AND thumb_url = ''`, [linkId, icon, stored]);
  }
  res.json({ ok: true, icon });
});

/* ---------------- errors ---------------- */

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(400).json({ ok: false, error: err.message });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Something went wrong on the server. Check the Railway logs.' });
});

module.exports = { router, DELETE_WORD };
