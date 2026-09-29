-- Safe to run on every start: everything is IF NOT EXISTS.
--
-- The model: a family signs in with its username and sees only its own links.
-- Within a family, links are ONE shared catalog that every member sees.
-- Sections, and which link sits in which section in what order, belong to a
-- profile (a member). A link with no placement for a profile shows up in that
-- profile's virtual "Unsorted" section - there is no row for Unsorted.

CREATE TABLE IF NOT EXISTS families (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  username    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS families_username_key ON families ((lower(username)));

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

-- Profiles and links belong to a family. Added after the fact, so a database
-- from before families existed is upgraded in place.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS family_id INT REFERENCES families(id) ON DELETE CASCADE;
ALTER TABLE links    ADD COLUMN IF NOT EXISTS family_id INT REFERENCES families(id) ON DELETE CASCADE;

-- Anything created before families existed moves into the first family,
-- which is created (username "family") if there is none yet.
DO $$
DECLARE fid INT;
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE family_id IS NULL)
     OR EXISTS (SELECT 1 FROM links WHERE family_id IS NULL) THEN
    SELECT id INTO fid FROM families ORDER BY id LIMIT 1;
    IF fid IS NULL THEN
      INSERT INTO families (name, username) VALUES ('My family', 'family') RETURNING id INTO fid;
    END IF;
    UPDATE profiles SET family_id = fid WHERE family_id IS NULL;
    UPDATE links    SET family_id = fid WHERE family_id IS NULL;
  END IF;
END $$;

ALTER TABLE profiles ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE links    ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_family_idx ON profiles (family_id);
CREATE INDEX IF NOT EXISTS links_family_idx ON links (family_id);

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
