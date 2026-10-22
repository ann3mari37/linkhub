// One-time copy of every family, username, profile, link, section, placement and
// usage record from the Railway database into Supabase. Ids are kept, so nothing
// needs remapping. Sessions are not copied: everyone signs in once on the new site.
//
//   1. Run supabase/schema.sql in the Supabase SQL Editor first.
//   2. Put both connection strings in a .env file next to package.json (git ignores it):
//        RAILWAY_DATABASE_URL=postgresql://...   (Railway → Postgres → Variables → DATABASE_PUBLIC_URL)
//        SUPABASE_DATABASE_URL=postgresql://...  (Supabase → Connect → Session pooler, port 5432)
//   3. npm run copy-from-railway
//
// Refuses to run into a Supabase database that already has families in it, and
// writes everything in one transaction: it either all arrives or none of it does.
import postgres from 'postgres';

const from = process.env.RAILWAY_DATABASE_URL;
const to = process.env.SUPABASE_DATABASE_URL;
if (!from || !to) {
  console.error('Set RAILWAY_DATABASE_URL and SUPABASE_DATABASE_URL in .env (see the top of this file).');
  process.exit(1);
}

// Parents before children, so every foreign key already has its target.
const TABLES = [
  ['families', ['id', 'name', 'created_at']],
  ['family_usernames', ['id', 'family_id', 'username', 'created_at']],
  ['profiles', ['id', 'family_id', 'name', 'color', 'created_at']],
  ['links', ['id', 'family_id', 'title', 'url', 'description', 'thumb_data', 'thumb_url', 'tips', 'new_tab', 'created_at', 'edited_at']],
  ['sections', ['id', 'profile_id', 'title', 'accent', 'sort', 'created_at']],
  ['placements', ['profile_id', 'link_id', 'section_id', 'sort']],
  ['link_usage', ['profile_id', 'link_id', 'last_used', 'use_count']],
];
const WITH_IDS = ['families', 'family_usernames', 'profiles', 'links', 'sections'];

const src = postgres(from, { max: 1, ssl: /railway\.internal/.test(from) ? false : { rejectUnauthorized: false } });
const dst = postgres(to, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });

try {
  const [{ n }] = await dst`select count(*)::int as n from families`;
  if (n > 0) throw new Error('Supabase already has families in it. The copy only runs into an empty LinkHub.');

  const data = {};
  for (const [table, cols] of TABLES) {
    data[table] = await src.unsafe(`select ${cols.join(', ')} from ${table}`);
    console.log(`Read ${String(data[table].length).padStart(5)} from ${table}`);
  }

  await dst.begin(async (t) => {
    for (const [table, cols] of TABLES) {
      for (const row of data[table]) {
        await t.unsafe(
          `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => row[c])
        );
      }
    }
    // explicit ids were inserted, so move each sequence past them
    for (const table of WITH_IDS) {
      await t.unsafe(`select setval(pg_get_serial_sequence('${table}', 'id'), greatest((select max(id) from ${table}), 1))`);
    }
  });

  console.log('\nCopied everything into Supabase.');
} catch (err) {
  console.error('\nCopy failed - nothing was written to Supabase.\n' + err.message);
  process.exitCode = 1;
} finally {
  await Promise.all([src.end({ timeout: 5 }), dst.end({ timeout: 5 })]);
}
