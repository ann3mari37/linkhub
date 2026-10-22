# LinkHub

Your family's links, all in one place, at **links.kittigutierrez.com**. A rebuild of the ASP LinkHub
at thingzine.com/LinkHub, with the same front end, extended to hold many families.

**Stack**

| Layer | What runs it |
|---|---|
| App and API | A Cloudflare Worker. The pages are served from the Worker's static assets. |
| Database | Supabase Postgres, reached through the `postgres` driver. Cloudflare Hyperdrive is recommended. |
| Sign-in | A family username (no password) for families; `ADMIN_PASSWORD` for the `/admin` page. |

## How it works

- **Families.** A family can have several **usernames**; typing any one of them (no password) signs
  in to that family, which sees only its own links and members. Nothing is shared between families.
- **One catalog per family.** Every link a family adds is visible to all its members. Adding,
  editing or deleting a link changes it for the whole family.
- **Profiles (members).** After signing in, each person picks their profile (remembered per
  device). Sections, which links sit in them, and their order are per profile. A link you haven't
  filed shows in your **Unsorted**.
- **Drag and drop** tiles between sections, reorder sections, or drag from **All links** into a
  section.
- **Icons** are looked up by the Worker from the site's own `<link rel="icon">` (including icons
  embedded in the page) and saved on the link; the browser also tries the usual `/favicon.ico`
  paths, so an icon shows if either works.
- **Recently used** is kept in each browser only. "Used 3d ago" and the open count are per profile.
- **Sign-in tips** per link (never passwords), duplicate-address warnings, grid/list view, search
  (press `/`), and a two-step delete that needs a typed word.

## Families and the admin page

Only the admin creates families, at **`/admin`**, signed in with `ADMIN_PASSWORD`. There you can:

- **Add a family** with a display name and its first username.
- **Add usernames** to a family (for example one per person) and **remove** them. Removing a
  username signs out anyone who signed in with it. A family always keeps at least one.
- **Rename** a family, or **delete** it with everything in it (confirmed by typing its name).

Usernames are unique across all families. A username is the only thing standing between one family
and another's links, so make each one hard to guess (`smith-maple-42`, not `smith`). Wrong
usernames are limited to 10 tries per 15 minutes per address.

## Setup

### 1. Supabase
1. Create a project at supabase.com (or use an existing one).
2. Open **SQL Editor**, paste in [`supabase/schema.sql`](supabase/schema.sql), and run it. It creates
   the tables and turns on row-level security.
3. Click **Connect**, choose the **Transaction pooler** (port `6543`), and copy the URI, with your
   database password filled in.

Row-level security is on for every table and no access rules are defined. That means Supabase's
public REST API, and anyone with the project's anon key, can read and write nothing. Only the Worker
can reach the data, through the database connection string.

### 2. Cloudflare Worker
```bash
npm install
npx wrangler login
npx wrangler secret put DATABASE_URL
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```
- `DATABASE_URL` is the Supabase transaction-pooler URI from step 1.
- `ADMIN_PASSWORD` is the password for `/admin`. Without it the admin page is switched off.
- Optional: set `DELETE_WORD` (the word typed to confirm a delete, default `yes`) as a variable.

**Recommended: Hyperdrive.** It keeps database connections warm close to your users, so requests are faster.
```bash
npx wrangler hyperdrive create linkhub-db --connection-string="<the Supabase URI>"
```
Paste the id it prints into the `hyperdrive` block in [`wrangler.jsonc`](wrangler.jsonc) (it's
commented out there), then deploy again. When Hyperdrive is bound, the Worker uses it instead of
`DATABASE_URL`.

### 3. The domain
The Worker is served at `links.kittigutierrez.com`, set in `routes` in [`wrangler.jsonc`](wrangler.jsonc).
`kittigutierrez.com` must be a zone in the same Cloudflare account. Deploying creates the DNS record
and certificate automatically; nothing else on the domain changes.

### 4. Moving the data from Railway (one time)
1. Run `supabase/schema.sql` first (step 1).
2. Create a `.env` file next to `package.json` (git ignores it) with:
   ```
   RAILWAY_DATABASE_URL=postgresql://...    # Railway → Postgres → Variables → DATABASE_PUBLIC_URL
   SUPABASE_DATABASE_URL=postgresql://...   # Supabase → Connect → Session pooler (port 5432)
   ```
3. `npm run copy-from-railway`

It copies every family, username, profile, link, section and usage record, keeping their ids, in one
transaction, and refuses to run if Supabase already has families. Everyone signs in once on the new
site, since sessions aren't copied.

## Security
- **Sessions:** last 180 days, in HttpOnly, Secure, SameSite=Lax cookies. Only hashes of the session
  tokens are stored. A session belongs to the username it signed in with, so removing that username
  (or its family) ends it at once.
- **Families are separate:** every query is limited to the signed-in family, so another family's
  links, profiles and sections can't be read or changed even by guessing their ids.
- **Failed sign-ins:** 10 wrong usernames (or admin passwords) from one address block that sign-in
  for 15 minutes.
- **Forged requests:** a change must come from this site (checked with the browser's `Origin` and
  `Sec-Fetch-Site` headers), on top of SameSite cookies.
- **Headers:** a Content-Security-Policy with no inline scripts, and `noindex` so search engines skip
  the site. Images may load from anywhere, because link icons come from every site a family adds.
- **Link addresses:** only `http`, `https`, `ftp`, `file`, `mailto` and network shares are saved, so
  a link can't run script when clicked.
- **Secrets:** none are committed. Local secrets go in `.dev.vars` (see `.dev.vars.example`) and `.env`.

## Local development
```bash
npm install
npm run dev
```
- Runs the Worker's own code in Node against **PGlite** (Postgres compiled to WebAssembly), using
  the real schema. No Docker or Supabase project is needed.
- Opens at http://localhost:5181. Go to `/admin` first: the local admin password is
  `local-test-password` (override it with `ADMIN_PASSWORD=...`). Add a family, then sign in at `/`
  with its username.
- Data is kept in `.data/pglite`. Delete that folder to start fresh.

To run inside Cloudflare's runtime against your Supabase database instead:
1. Copy `.dev.vars.example` to `.dev.vars` and fill it in.
2. Run `npx wrangler dev`.

## Layout
```
src/index.js       Worker entry: routing, sessions, sign-in, security headers, the link page
src/api.js         the family's links, profiles and sections (data, save, icon)
src/admin.js       families and their usernames
src/icon.js        finding a site's icon
src/db.js          database connection (Supabase / Hyperdrive)
public/            the pages (links, sign-in, admin), styles, scripts and icons
supabase/schema.sql
scripts/dev.mjs                local dev server (PGlite)
scripts/copy-from-railway.mjs  one-time copy of the Railway data into Supabase
```

## API

The link page talks to three endpoints (same contract as the ASP version's `.asp` files), all
limited to the signed-in family:

- `GET /api/data?profileId=N` → the family's profiles, the current profile's sections, and every
  family link with this profile's placement and usage
- `POST /api/save` with `action=` one of `profile.save`, `profile.delete`, `section.save`,
  `section.delete`, `reorder.sections`, `link.save`, `link.delete`, `link.reseticon`, `link.used`,
  `reorder.links`
- `GET /api/icon?linkId=N&url=...` → the site's declared icon

Sign-in: `POST /login` with `username`, `POST /logout`. Admin: `POST /admin/login`,
`POST /admin/logout`, and `/admin/api/...` to list, create, rename and delete families and add or
remove their usernames.
