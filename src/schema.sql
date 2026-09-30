-- Safe to run on every start: everything is IF NOT EXISTS.
--
-- The model: a family signs in with any one of its usernames and sees only
-- its own links. Within a family, links are ONE shared catalog that every
-- member sees. Sections, and which link sits in which section in what order,
-- belong to a profile (a member). A link with no placement for a profile shows
-- up in that profile's virtual "Unsorted" section - there is no row for Unsorted.

CREATE TABLE IF NOT EXISTS families (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each family can have several usernames; any of them signs in to it.
CREATE TABLE IF NOT EXISTS family_usernames (
  id          SERIAL PRIMARY KEY,
  family_id   INT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS family_usernames_username_key ON family_usernames ((lower(username)));
CREATE INDEX IF NOT EXISTS family_usernames_family_idx ON family_usernames (family_id);

-- Families used to have exactly one username, kept on the family row. Move it
-- into family_usernames, then drop the old column (and its index with it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'families' AND column_name = 'username') THEN
    INSERT INTO family_usernames (family_id, username)
    SELECT f.id, f.username FROM families f
     WHERE NOT EXISTS (SELECT 1 FROM family_usernames u WHERE lower(u.username) = lower(f.username));
    ALTER TABLE families DROP COLUMN username;
  END IF;
END $$;

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
      INSERT INTO families (name) VALUES ('My family') RETURNING id INTO fid;
      INSERT INTO family_usernames (family_id, username) VALUES (fid, 'family') ON CONFLICT DO NOTHING;
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
