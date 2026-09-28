-- Safe to run on every start: everything is IF NOT EXISTS.
--
-- The model: links are ONE shared catalog that everybody sees. Sections, and
-- which link sits in which section in what order, belong to a profile. A link
-- with no placement for a profile shows up in that profile's virtual
-- "Unsorted" section - there is no row for Unsorted.

CREATE TABLE IF NOT EXISTS profiles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#4c8dff',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumb_data  TEXT NOT NULL DEFAULT '',
  thumb_url   TEXT NOT NULL DEFAULT '',
  tips        TEXT NOT NULL DEFAULT '',
  new_tab     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sections (
  id          SERIAL PRIMARY KEY,
  profile_id  INT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  accent      TEXT NOT NULL DEFAULT '#4c8dff',
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sections_profile_idx ON sections (profile_id, sort);

-- Where a link sits on one profile's page. One row per (profile, link).
CREATE TABLE IF NOT EXISTS placements (
  profile_id  INT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  link_id     INT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  section_id  INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  sort        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, link_id)
);
CREATE INDEX IF NOT EXISTS placements_section_idx ON placements (section_id, sort);

-- When a profile last opened a link, and how often.
CREATE TABLE IF NOT EXISTS link_usage (
  profile_id  INT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  link_id     INT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now(),
  use_count   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, link_id)
);
