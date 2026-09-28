// One-time copy of everything in the old ASP LinkHub into this database:
// profiles, the shared link catalog, each profile's sections and layout, and
// each profile's usage history. IDs are kept, so nothing needs remapping.
//
// Two ways to run it:
//   - On Railway: set IMPORT_FROM=https://www.thingzine.com/LinkHub and deploy.
//     The server imports on start if the database has no links yet.
//   - Locally:    npm run import -- https://www.thingzine.com/LinkHub
//
// Never runs into a database that already has links in it.
const { pool, migrate, tx } = require('./db');

async function getData(source, profileId) {
  const res = await fetch(`${source}/api/data.asp?profileId=${profileId}`, { signal: AbortSignal.timeout(60000) });
  const txt = await res.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error(`${source} did not return JSON:\n${txt.slice(0, 400)}`);
  }
  if (!j.ok) throw new Error(j.error || 'The old LinkHub reported an error.');
  return j;
}

const orNow = (iso) => (iso ? new Date(iso) : new Date());

async function isEmpty() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM links');
  return rows[0].n === 0;
}

async function importFrom(rawSource) {
  const source = String(rawSource).trim().replace(/\/+$/, '');
  if (!(await isEmpty())) throw new Error('This database already has links in it. Import only runs into an empty LinkHub.');

  console.log(`Importing from ${source} ...`);
  const first = await getData(source, 0);
  const perProfile = [];
  for (const p of first.profiles) {
    const d = p.id === first.profileId ? first : await getData(source, p.id);
    if (d.profileId !== p.id) throw new Error(`Asked for profile ${p.id} but got ${d.profileId}.`);
    perProfile.push({ profile: p, data: d });
  }

  await tx(async (db) => {
    for (const { profile } of perProfile) {
      await db.query('INSERT INTO profiles (id, name, color) VALUES ($1, $2, $3)', [profile.id, profile.name, profile.color || '#4c8dff']);
    }

    // The catalog is shared, so every profile's payload lists the same links.
    for (const l of first.links) {
      await db.query(
        `INSERT INTO links (id, title, url, description, thumb_data, thumb_url, tips, new_tab, created_at, edited_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [l.id, l.title, l.url, l.desc || '', l.thumbData || '', l.thumbUrl || '', l.tips || '',
         l.newTab !== false, orNow(l.created), orNow(l.edited || l.created)]
      );
    }

    for (const { profile, data } of perProfile) {
      for (const s of data.sections) {
        await db.query(
          'INSERT INTO sections (id, profile_id, title, accent, sort) VALUES ($1, $2, $3, $4, $5)',
          [s.id, profile.id, s.title, s.accent || '#4c8dff', s.sort || 0]
        );
      }
      for (const l of data.links) {
        if (l.sectionId) {
          await db.query(
            'INSERT INTO placements (profile_id, link_id, section_id, sort) VALUES ($1, $2, $3, $4)',
            [profile.id, l.id, l.sectionId, l.sort || 0]
          );
        }
        if (l.used) {
          await db.query(
            'INSERT INTO link_usage (profile_id, link_id, last_used, use_count) VALUES ($1, $2, $3, $4)',
            [profile.id, l.id, new Date(l.used), l.useCount || 1]
          );
        }
      }
    }

    // explicit ids were inserted, so move each sequence past them
    for (const t of ['profiles', 'links', 'sections']) {
      await db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT MAX(id) FROM ${t}), 1))`);
    }
  });

  const count = (fn) => perProfile.reduce((n, p) => n + fn(p.data), 0);
  console.log(
    `Imported ${perProfile.length} profiles, ${first.links.length} links, ` +
    `${count((d) => d.sections.length)} sections, ${count((d) => d.links.filter((l) => l.sectionId).length)} placements.`
  );
}

// Called on server start. Only acts when IMPORT_FROM is set and the database is
// still empty. Remove the variable once the import is done: if every link were
// later deleted, a restart would otherwise import the old data again.
// A failure is logged, not fatal - the app still starts, just empty.
async function importOnStart() {
  const source = process.env.IMPORT_FROM;
  if (!source || !(await isEmpty())) return;
  try {
    await importFrom(source);
  } catch (err) {
    console.error('Import failed - nothing was written.\n' + err.message);
  }
}

module.exports = { importFrom, importOnStart };

if (require.main === module) {
  migrate()
    .then(() => importFrom(process.argv[2] || process.env.IMPORT_FROM || 'https://www.thingzine.com/LinkHub'))
    .then(() => pool.end())
    .catch((err) => {
      console.error('Import failed - nothing was written.\n' + err.message);
      pool.end().finally(() => process.exit(1));
    });
}
