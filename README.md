# LinkHub

Your family's links, all in one place. A Node + Postgres rebuild of the ASP LinkHub at
thingzine.com/LinkHub, with the same front end, extended to hold many families.

**Stack:** Node.js 22+, Express 5, PostgreSQL (Railway). No build step; the front end is plain
HTML/CSS/JS in `public/`.

## How it works

- **Families.** Each family signs in with its **family username** (no password) and sees only its
  own links and members. Nothing is shared between families.
- **One catalog per family.** Every link a family adds is visible to all its members. Adding,
  editing or deleting a link changes it for the whole family.
- **Profiles (members).** After signing in, each person picks their profile (remembered per
  device). Sections, which links sit in them, and their order are per profile. A link you haven't
  filed shows in your **Unsorted**.
- **Drag and drop** tiles between sections, reorder sections, or drag from **All links** into a
  section.
- **Icons** are looked up by the server from the site's own `<link rel="icon">` (including icons
  embedded in the page) and saved on the link; the browser also tries the usual `/favicon.ico`
  paths, so an icon shows if either works.
- **Recently used** is kept in each browser only. "Used 3d ago" and the open count are per profile.
- **Sign-in tips** per link (never passwords), duplicate-address warnings, grid/list view, search
  (press `/`), and a two-step delete that needs a typed word.

## Families and the admin page

Only the admin creates families, at **`/admin`**, signed in with `ADMIN_PASSWORD`. There you can
add a family (a display name plus the username they sign in with), rename it, change its
username, or delete it with everything in it.

The family username is the only thing standing between one family and another's links, so make
each one hard to guess (`smith-maple-42`, not `smith`). Wrong usernames are limited to 10 tries per
15 minutes per device.

Links and profiles created before families existed are moved into a first family with the
username **`family`** on the first start. Rename it in `/admin`.

## Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo** → `ann3mari37/linkhub`.
2. Add Postgres to the project (**+ New → Database → PostgreSQL**), or use your existing one.
3. On the app service → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference your Postgres service)
   - `SESSION_SECRET` = any long random string
   - `ADMIN_PASSWORD` = the password for `/admin`
4. **Settings → Networking → Generate Domain** to get a public URL.
5. Optional: **Settings → Deploy → Healthcheck Path** = `/healthz`.

Tables are created (and older databases upgraded) automatically on start.

## Variables

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `SESSION_SECRET` | Keeps people signed in across restarts |
| `ADMIN_PASSWORD` | Password for `/admin`. If empty, the admin page is switched off. |
| `DELETE_WORD` | Word typed to confirm a delete (default `yes`) |
| `PGSSL` | `require` when using Railway's public proxy URL from outside Railway |

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL etc.
npm run dev
```

Open http://localhost:3000/admin to create a family, then http://localhost:3000 to sign in.

## API

The front end talks to three endpoints (same contract as the ASP version's `.asp` files), all
limited to the signed-in family:

- `GET /api/data?profileId=N` → the family's profiles, the current profile's sections, and every
  family link with this profile's placement and usage
- `POST /api/save` with `action=` one of `profile.save`, `profile.delete`, `section.save`,
  `section.delete`, `reorder.sections`, `link.save`, `link.delete`, `link.reseticon`, `link.used`,
  `reorder.links`
- `GET /api/icon?linkId=N&url=...` → the site's declared icon

Sign-in: `POST /login` with `username`, `POST /logout`. Admin: `POST /admin/login`, and
`/admin/api/families` to list, create, update and delete families.
