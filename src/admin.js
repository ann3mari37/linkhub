// The admin page's data: families and their usernames. Routing, the admin
// sign-in and the ADMIN_PASSWORD check live in index.js; these run only for a
// signed-in admin.
//
//   GET  /admin/api/families                   -> { ok, families: [{ ..., usernames: [{ id, username }] }] }
//   POST /admin/api/families                   { name, username }  -> { ok, id }   (a family starts with one username)
//   POST /admin/api/families/:id               { name }            rename
//   POST /admin/api/families/:id/delete        { confirm: <the family's name> }
//   POST /admin/api/families/:id/usernames     { username }        add a username
//   POST /admin/api/usernames/:id/delete                           remove a username
import { bad } from './api.js';

const fail = (msg) => {
  throw bad(msg);
};
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function cleanName(v) {
  const name = text(v, 100);
  if (!name) fail('Give the family a name.');
  return name;
}

function cleanUsername(v) {
  const username = text(v, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    fail('A username needs 3 to 40 characters: letters, numbers, dots, dashes or underscores.');
  }
  return username;
}

// Usernames are unique across all families (any of them signs in, so a clash would be ambiguous).
async function addUsername(db, familyId, username) {
  if ((await db.q('select 1 from family_usernames where lower(username) = $1', [username])).length) {
    fail(`"${username}" is already in use. Usernames must be unique across all families.`);
  }
  try {
    await db.q('insert into family_usernames (family_id, username) values ($1, $2)', [familyId, username]);
  } catch (err) {
    // two admins adding the same name at the same moment
    if (err.code === '23505') fail(`"${username}" is already in use. Usernames must be unique across all families.`);
    throw err;
  }
}

export async function listFamilies(db) {
  const families = await db.q(
    `select f.id, f.name,
            (select count(*)::int from profiles p where p.family_id = f.id) as profiles,
            (select count(*)::int from links l where l.family_id = f.id) as links,
            coalesce((select json_agg(json_build_object('id', u.id, 'username', u.username) order by lower(u.username))
                        from family_usernames u where u.family_id = f.id), '[]') as usernames
       from families f
      order by lower(f.name), f.id`
  );
  // json comes back parsed from some drivers and as text from others
  return {
    ok: true,
    families: families.map((f) => ({ ...f, usernames: typeof f.usernames === 'string' ? JSON.parse(f.usernames) : f.usernames })),
  };
}

export async function createFamily(db, body) {
  const name = cleanName(body.name);
  const username = cleanUsername(body.username);
  const id = await db.tx(async (t) => {
    const [row] = await t.q('insert into families (name) values ($1) returning id', [name]);
    await addUsername(t, row.id, username);
    return row.id;
  });
  return { ok: true, id };
}

export async function renameFamily(db, familyId, body) {
  const name = cleanName(body.name);
  const rows = await db.q('update families set name = $2 where id = $1 returning id', [familyId, name]);
  if (!rows.length) fail('That family no longer exists.');
  return { ok: true };
}

// Deleting a family deletes everything in it: its usernames, sessions, profiles,
// links, sections and layout all cascade. Confirmed by typing the family's name.
export async function deleteFamily(db, familyId, body) {
  const [row] = await db.q('select name from families where id = $1', [familyId]);
  if (!row) fail('That family no longer exists.');
  if (text(body.confirm, 100).toLowerCase() !== row.name.trim().toLowerCase()) {
    fail(`Type the family name, ${row.name}, to confirm.`);
  }
  await db.q('delete from families where id = $1', [familyId]);
  return { ok: true };
}

export async function addFamilyUsername(db, familyId, body) {
  const username = cleanUsername(body.username);
  if (!(await db.q('select 1 from families where id = $1', [familyId])).length) fail('That family no longer exists.');
  await addUsername(db, familyId, username);
  return { ok: true };
}

// Anyone signed in with this username is signed out (their session cascades away).
// A family must keep at least one, or nobody could ever sign in to it.
export async function removeUsername(db, usernameId) {
  await db.tx(async (t) => {
    const [row] = await t.q('select family_id from family_usernames where id = $1', [usernameId]);
    if (!row) fail('That username no longer exists.');
    // lock the family so two removals at once cannot leave it with none
    await t.q('select 1 from families where id = $1 for update', [row.family_id]);
    const [{ n }] = await t.q('select count(*)::int as n from family_usernames where family_id = $1', [row.family_id]);
    if (n <= 1) fail('This is the family\'s only username. Add another one before removing it.');
    await t.q('delete from family_usernames where id = $1', [usernameId]);
  });
  return { ok: true };
}
