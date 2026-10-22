-- LinkHub — Supabase (Postgres) schema.
-- Run once in the Supabase SQL Editor. Safe to re-run: everything is "if not exists".
--
-- The model: a family signs in with any one of its usernames and sees only its own
-- links. Within a family, links are ONE shared catalog that every member sees.
-- Sections, and which link sits in which section in what order, belong to a profile
-- (a member). A link with no placement for a profile shows up in that profile's
-- virtual "Unsorted" section - there is no row for Unsorted.

create table if not exists families (
  id          serial primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Each family can have several usernames; any of them signs in to it.
create table if not exists family_usernames (
  id          serial primary key,
  family_id   int not null references families(id) on delete cascade,
  username    text not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists family_usernames_username_key on family_usernames ((lower(username)));
create index if not exists family_usernames_family_idx on family_usernames (family_id);

create table if not exists profiles (
  id          serial primary key,
  family_id   int not null references families(id) on delete cascade,
  name        text not null,
  color       text not null default '#4c8dff',
  created_at  timestamptz not null default now()
);
create index if not exists profiles_family_idx on profiles (family_id);

create table if not exists links (
  id          serial primary key,
  family_id   int not null references families(id) on delete cascade,
  title       text not null,
  url         text not null,
  description text not null default '',
  thumb_data  text not null default '',
  thumb_url   text not null default '',
  tips        text not null default '',
  new_tab     boolean not null default true,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz not null default now()
);
create index if not exists links_family_idx on links (family_id);

create table if not exists sections (
  id          serial primary key,
  profile_id  int not null references profiles(id) on delete cascade,
  title       text not null,
  accent      text not null default '#4c8dff',
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists sections_profile_idx on sections (profile_id, sort);

-- Where a link sits on one profile's page. One row per (profile, link).
create table if not exists placements (
  profile_id  int not null references profiles(id) on delete cascade,
  link_id     int not null references links(id) on delete cascade,
  section_id  int not null references sections(id) on delete cascade,
  sort        int not null default 0,
  primary key (profile_id, link_id)
);
create index if not exists placements_section_idx on placements (section_id, sort);

-- When a profile last opened a link, and how often.
create table if not exists link_usage (
  profile_id  int not null references profiles(id) on delete cascade,
  link_id     int not null references links(id) on delete cascade,
  last_used   timestamptz not null default now(),
  use_count   int not null default 0,
  primary key (profile_id, link_id)
);

-- Sign-ins. Only a hash of each session token is stored. A session belongs to the
-- username it signed in with, so removing that username (or its family) ends it.
-- admin marks a session that has also entered ADMIN_PASSWORD on /admin.
create table if not exists sessions (
  token_hash  text primary key,
  username_id int references family_usernames(id) on delete cascade,
  admin       boolean not null default false,
  expires_at  timestamptz not null
);
create index if not exists sessions_expires_idx on sessions (expires_at);

-- Wrong usernames and admin passwords, per kind and address, to slow down guessing.
create table if not exists login_attempts (
  key         text primary key,
  count       int not null,
  first_at    timestamptz not null default now()
);

-- Row-level security is on for every table and no access rules are defined, so
-- Supabase's public REST API (and anyone holding the project's anon key) can read and
-- write nothing. Only the Worker reaches the data, through the database connection.
alter table families         enable row level security;
alter table family_usernames enable row level security;
alter table profiles         enable row level security;
alter table links            enable row level security;
alter table sections         enable row level security;
alter table placements       enable row level security;
alter table link_usage       enable row level security;
alter table sessions         enable row level security;
alter table login_attempts   enable row level security;
