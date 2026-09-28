# LinkHub

Company links, all in one place. A Node + Postgres rebuild of the ASP LinkHub at
thingzine.com/LinkHub, with the same front end and behaviour.

**Stack:** Node.js 22+, Express 5, PostgreSQL (Railway). No build step; the front end is plain
HTML/CSS/JS in `public/`.

## How it works

- **One shared catalog.** Every link is visible to everyone. Adding, editing or deleting a link
  changes it for the whole team.
- **Profiles.** Each person picks a profile (remembered per device). Sections, which links sit in
  them, and their order are per profile. A link you haven't filed shows in your **Unsorted**.
- **Drag and drop** tiles between sections, reorder sections, or drag from **All links** into a
  section.
- **Icons** are looked up by the server from the site's own `<link rel="icon">` and saved on the
  link; the browser also tries the usual `/favicon.ico` paths, so an icon shows if either works.
- **Recently used** is kept in each browser only. "Used 3d ago" and the open count are per profile.
- **Sign-in tips** per link (never passwords), duplicate-address warnings, grid/list view, search
  (press `/`), and a two-step delete that needs a typed word.
- **Team password.** One shared password (`APP_PASSWORD`) guards the page and the API.

## Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo** → `ann3mari37/linkhub`.
2. Add Postgres to the project (**+ New → Database → PostgreSQL**), or use your existing one.
3. On the app service → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference your Postgres service)
   - `APP_PASSWORD` = the password your team will sign in with
   - `SESSION_SECRET` = any long random string
   - `IMPORT_FROM` = `https://www.thingzine.com/LinkHub` (only for the first deploy; see below)
4. **Settings → Networking → Generate Domain** to get a public URL.
5. Optional: **Settings → Deploy → Healthcheck Path** = `/healthz`.

Tables are created automatically on start.

## Moving the data over from the old LinkHub

With `IMPORT_FROM` set, the server copies everything from the old LinkHub the first time it starts
against an empty database: profiles, all links (with icons and sign-in tips), every profile's
sections and layout, and usage history. The deploy log shows
`Imported N profiles, N links, ...` when it's done.

**Then delete the `IMPORT_FROM` variable.** It only ever imports into an empty database, but if
every link were deleted later, a restart would bring the old data back.

To import from a computer with Node installed instead: `npm run import -- https://www.thingzine.com/LinkHub`.

## Variables

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `APP_PASSWORD` | Team password. If empty, anyone with the URL can view and change everything. |
| `SESSION_SECRET` | Keeps people signed in across restarts |
| `DELETE_WORD` | Word typed to confirm a delete (default `yes`) |
| `IMPORT_FROM` | Old LinkHub URL to import from on first start |
| `PGSSL` | `require` when using Railway's public proxy URL from outside Railway |

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL etc.
npm run dev
```

Open http://localhost:3000.

## API

The front end talks to three endpoints (same contract as the ASP version's `.asp` files):

- `GET /api/data?profileId=N` → profiles, the current profile's sections, and every link with
  this profile's placement and usage
- `POST /api/save` with `action=` one of `profile.save`, `profile.delete`, `section.save`,
  `section.delete`, `reorder.sections`, `link.save`, `link.delete`, `link.reseticon`, `link.used`,
  `reorder.links`
- `GET /api/icon?linkId=N&url=...` → the site's declared icon
