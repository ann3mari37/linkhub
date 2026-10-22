// The family-facing API. Same contract as the original LinkHub's api/data.asp,
// api/save.asp and api/icon.asp:
//
//   GET  /api/data?profileId=N          -> { ok, profiles, profileId, sections, links }
//   POST /api/save   action=...&...     -> { ok, id? } or { ok:false, error }
//   GET  /api/icon?linkId=N&url=...     -> { ok, icon }
//
// Every function runs as one family (familyId comes from the session in index.js)
// and every query is limited to that family, so one family can never read or
// change another's profiles, sections or links - even by guessing ids.
import { findIcon, httpUrlOf } from './icon.js';

export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
const fail = (msg) => {
  throw bad(msg);
};

const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const color = (v, dflt) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : dflt);
// Id lists travel as '1,2,3' text and are split in SQL with string_to_array, which
// behaves the same in every driver and through Supabase's pooler.
const idList = (v) => [...new Set(String(v || '').split(',').map(int).filter((n) => n > 0))].join(',');
const IDS = (n) => `string_to_array($${n}, ',')::int[]`;

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
// the icon lookup's answer: a URL, or an icon the site embeds in its page as a data URI
const cleanThumbUrl = (v) => {
  const s = String(v || '').trim();
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(s)) return s.length <= 64 * 1024 ? s : '';
  return /^https?:\/\//i.test(s) && s.length <= 1000 ? s : '';
};

const iso = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');

// The profile asked for if it is in this family, otherwise the family's first one by name.
async function resolveProfileId(db, familyId, want) {
  const rows = await db.q(
    'select id from profiles where family_id = $1 order by (id = $2) desc, lower(name), id limit 1',
    [familyId, int(want)]
  );
  return rows[0] ? rows[0].id : 0;
}

async function requireProfile(db, familyId, profileId) {
  const id = int(profileId);
  if (id > 0 && (await db.q('select 1 from profiles where id = $1 and family_id = $2', [id, familyId])).length) return id;
  fail('Choose your profile first (the button at the top of the page).');
}

// profileId has already been checked against the family, so its sections are the family's too
async function requireSection(db, profileId, sectionId) {
  if (!(await db.q('select 1 from sections where id = $1 and profile_id = $2', [sectionId, profileId])).length) {
    fail('That section no longer exists. Reload the page and try again.');
  }
}

function requireConfirm(word, deleteWord) {
  if (String(word || '').trim().toLowerCase() !== deleteWord) fail(`Type ${deleteWord} to confirm the delete.`);
}

// Put a link at the end of a section on one profile's page (no-op if it is already there).
async function fileLink(db, profileId, linkId, sectionId) {
  await db.q(
    `insert into placements (profile_id, link_id, section_id, sort)
     select $1, $2, $3, coalesce(max(sort), -1) + 1 from placements where section_id = $3
     on conflict (profile_id, link_id) do update
       set section_id = excluded.section_id, sort = excluded.sort
       where placements.section_id <> excluded.section_id`,
    [profileId, linkId, sectionId]
  );
}

/* ---------------- data ---------------- */

export async function getData(db, familyId, wantProfile) {
  const profileId = await resolveProfileId(db, familyId, wantProfile);
  const [profiles, sections, links] = await Promise.all([
    db.q('select id, name, color from profiles where family_id = $1 order by lower(name), id', [familyId]),
    db.q('select id, title, accent, sort from sections where profile_id = $1 order by sort, id', [profileId]),
    db.q(
      `select l.*, p.section_id, p.sort, u.last_used, u.use_count
         from links l
         left join placements p on p.link_id = l.id and p.profile_id = $1
         left join link_usage u on u.link_id = l.id and u.profile_id = $1
        where l.family_id = $2
        order by p.sort nulls last, lower(l.title), l.id`,
      [profileId, familyId]
    ),
  ]);

  return {
    ok: true,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    profileId,
    sections: sections.map((s) => ({ id: s.id, title: s.title, accent: s.accent, sort: s.sort })),
    links: links.map((l) => ({
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
  };
}

/* ---------------- save ---------------- */

const actions = {
  /* profiles - the only action allowed without a current profile */
  async 'profile.save'(db, familyId, b) {
    const name = text(b.name, 100);
    if (!name) fail('Give the profile a name.');
    const c = color(b.color, '#4c8dff');
    const id = int(b.id);
    if (id > 0) {
      const rows = await db.q(
        'update profiles set name = $3, color = $4 where id = $1 and family_id = $2 returning id',
        [id, familyId, name, c]
      );
      if (!rows.length) fail('That profile no longer exists.');
      return { id };
    }
    const rows = await db.q('insert into profiles (family_id, name, color) values ($1, $2, $3) returning id', [familyId, name, c]);
    return { id: rows[0].id };
  },

  async 'profile.delete'(db, familyId, b, deleteWord) {
    requireConfirm(b.confirm, deleteWord);
    return db.tx(async (t) => {
      // lock the family so two deletes at once cannot remove its last profile
      await t.q('select 1 from families where id = $1 for update', [familyId]);
      const [{ n }] = await t.q('select count(*)::int as n from profiles where family_id = $1', [familyId]);
      if (n <= 1) fail('This is the only profile. Create another one before deleting it.');
      const rows = await t.q('delete from profiles where id = $1 and family_id = $2 returning id', [int(b.id), familyId]);
      if (!rows.length) fail('That profile no longer exists.');
      return {};
    });
  },

  /* sections - always the current profile's own */
  async 'section.save'(db, familyId, b) {
    const profileId = await requireProfile(db, familyId, b.profileId);
    const title = text(b.title, 100);
    if (!title) fail('Give the section a name.');
    const accent = color(b.accent, '#4c8dff');
    const id = int(b.id);
    if (id > 0) {
      const rows = await db.q(
        'update sections set title = $3, accent = $4 where id = $1 and profile_id = $2 returning id',
        [id, profileId, title, accent]
      );
      if (!rows.length) fail('That section no longer exists. Reload the page and try again.');
      return { id };
    }
    const rows = await db.q(
      `insert into sections (profile_id, title, accent, sort)
       select $1, $2, $3, coalesce(max(sort), -1) + 1 from sections where profile_id = $1
       returning id`,
      [profileId, title, accent]
    );
    return { id: rows[0].id };
  },

  async 'section.delete'(db, familyId, b, deleteWord) {
    requireConfirm(b.confirm, deleteWord);
    const profileId = await requireProfile(db, familyId, b.profileId);
    // its placements cascade away, so its links drop back into Unsorted
    const rows = await db.q('delete from sections where id = $1 and profile_id = $2 returning id', [int(b.id), profileId]);
    if (!rows.length) fail('That section no longer exists.');
    return {};
  },

  async 'reorder.sections'(db, familyId, b) {
    const profileId = await requireProfile(db, familyId, b.profileId);
    await db.q(
      `update sections s set sort = (t.ord - 1)::int
         from unnest(${IDS(2)}) with ordinality as t(id, ord)
        where s.id = t.id and s.profile_id = $1`,
      [profileId, idList(b.ids)]
    );
    return {};
  },

  /* links - one shared catalog per family; placement is per profile */
  async 'link.save'(db, familyId, b) {
    const url = cleanUrl(b.url);
    const title = text(b.title, 150);
    if (!url) fail('Give the link a web address.');
    if (!title) fail('Give the link a name.');
    const desc = text(b.desc, 500);
    const tips = text(b.tips, 4000);
    const newTab = String(b.newTab) !== '0';
    const sectionId = int(b.sectionId);
    const id = int(b.id);

    return db.tx(async (t) => {
      const profileId = sectionId > 0 || int(b.profileId) > 0 ? await requireProfile(t, familyId, b.profileId) : 0;
      if (sectionId > 0) await requireSection(t, profileId, sectionId);

      let linkId = id;
      if (id > 0) {
        const rows = await t.q('select url from links where id = $1 and family_id = $2 for update', [id, familyId]);
        if (!rows[0]) fail('That link no longer exists. Reload the page and try again.');
        // a new address means the old icon no longer applies
        const sameUrl = rows[0].url === url;
        await t.q(
          `update links set title = $2, url = $3, description = $4, tips = $5, new_tab = $6,
                  thumb_data = $7, thumb_url = $8, edited_at = now()
            where id = $1`,
          [id, title, url, desc, tips, newTab,
           sameUrl ? cleanThumbData(b.thumbData) : '', sameUrl ? cleanThumbUrl(b.thumbUrl) : '']
        );
      } else {
        const rows = await t.q(
          `insert into links (family_id, title, url, description, tips, new_tab, thumb_data, thumb_url)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [familyId, title, url, desc, tips, newTab, cleanThumbData(b.thumbData), cleanThumbUrl(b.thumbUrl)]
        );
        linkId = rows[0].id;
      }

      if (profileId) {
        if (sectionId > 0) await fileLink(t, profileId, linkId, sectionId);
        else await t.q('delete from placements where profile_id = $1 and link_id = $2', [profileId, linkId]);
      }
      return { id: linkId };
    });
  },

  async 'link.delete'(db, familyId, b, deleteWord) {
    requireConfirm(b.confirm, deleteWord);
    const rows = await db.q('delete from links where id = $1 and family_id = $2 returning id', [int(b.id), familyId]);
    if (!rows.length) fail('That link no longer exists.');
    return {};
  },

  async 'link.reseticon'(db, familyId, b) {
    await db.q(`update links set thumb_url = '', thumb_data = '' where id = $1 and family_id = $2`, [int(b.id), familyId]);
    return {};
  },

  // Sent with navigator.sendBeacon as a link opens; never worth an error.
  async 'link.used'(db, familyId, b) {
    await db.q(
      `insert into link_usage (profile_id, link_id, last_used, use_count)
       select p.id, l.id, now(), 1 from profiles p, links l
        where p.id = $1 and l.id = $2 and p.family_id = $3 and l.family_id = $3
       on conflict (profile_id, link_id) do update
         set last_used = now(), use_count = link_usage.use_count + 1`,
      [int(b.profileId), int(b.id), familyId]
    );
    return {};
  },

  // The full order of one section after a drop. Links listed are filed there in
  // that order (moving them out of wherever they were); links that were in it
  // and are not listed go back to Unsorted. sectionId 0 means "unfile these".
  async 'reorder.links'(db, familyId, b) {
    const sectionId = int(b.sectionId);
    const ids = idList(b.ids);
    if (sectionId < 0) fail('Links cannot be dropped there.');
    return db.tx(async (t) => {
      const profileId = await requireProfile(t, familyId, b.profileId);
      if (sectionId === 0) {
        await t.q(`delete from placements where profile_id = $1 and link_id = any(${IDS(2)})`, [profileId, ids]);
        return {};
      }
      await requireSection(t, profileId, sectionId);
      await t.q(
        `delete from placements where profile_id = $1 and section_id = $2 and not (link_id = any(${IDS(3)}))`,
        [profileId, sectionId, ids]
      );
      await t.q(
        `insert into placements (profile_id, link_id, section_id, sort)
         select $1, l.id, $2, (t.ord - 1)::int
           from unnest(${IDS(3)}) with ordinality as t(id, ord)
           join links l on l.id = t.id and l.family_id = $4
         on conflict (profile_id, link_id) do update
           set section_id = excluded.section_id, sort = excluded.sort`,
        [profileId, sectionId, ids, familyId]
      );
      return {};
    });
  },
};

export async function save(db, familyId, body, deleteWord) {
  const b = body || {};
  const fn = Object.prototype.hasOwnProperty.call(actions, b.action) ? actions[b.action] : null;
  if (!fn) fail(`Unknown action "${text(b.action, 40)}".`);
  return { ok: true, ...(await fn(db, familyId, b, deleteWord)) };
}

/* ---------------- icon ---------------- */

// Addresses with no icon, so tiles on the same Worker instance do not re-fetch them.
const MISS_TTL = 6 * 60 * 60 * 1000;
const iconMisses = new Map();

export async function icon(db, familyId, linkIdParam, urlParam) {
  const linkId = int(linkIdParam);
  let url = urlParam;
  let stored = null;

  if (linkId > 0) {
    const rows = await db.q('select url, thumb_url from links where id = $1 and family_id = $2', [linkId, familyId]);
    if (!rows[0]) return { ok: false, error: 'No such link.' };
    if (rows[0].thumb_url) return { ok: true, icon: rows[0].thumb_url };
    stored = rows[0].url;
    url = stored;
  }

  const key = httpUrlOf(url);
  if (!key) return { ok: true, icon: '' };
  const miss = iconMisses.get(key);
  if (miss && Date.now() - miss < MISS_TTL) return { ok: true, icon: '' };

  const found = await findIcon(key).catch(() => '');
  if (!found) {
    if (iconMisses.size > 2000) iconMisses.clear();
    iconMisses.set(key, Date.now());
  } else if (stored) {
    // only if the address has not been edited while we were looking
    await db.q(`update links set thumb_url = $2 where id = $1 and url = $3 and thumb_url = ''`, [linkId, found, stored]);
  }
  return { ok: true, icon: found };
}
