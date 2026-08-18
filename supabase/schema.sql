-- Locality — cloud sync schema.
-- Paste this whole file into Supabase → SQL Editor → Run (once, per project).
--
-- Stores ONLY watch progress, keyed by Locality's path-independent media
-- fingerprint (sha1 of filename+size) so the same file matches on any machine.
-- Row Level Security means a user can only ever see/modify their own rows;
-- the anon key in the app is safe to expose because of these policies.

create table if not exists public.watch_progress (
  user_id          uuid        not null references auth.users (id) on delete cascade,
  fingerprint      text        not null,
  filename         text        not null default '',
  size_bytes       bigint      not null default 0,
  duration_seconds double precision not null default 0,
  position_seconds double precision not null default 0,
  watched          boolean     not null default false,
  -- Drives the newest-wins merge between devices.
  last_updated     timestamptz not null default now(),
  primary key (user_id, fingerprint)
);

alter table public.watch_progress enable row level security;

-- One policy covering select/insert/update/delete: you only touch your own rows.
drop policy if exists "own rows" on public.watch_progress;
create policy "own rows" on public.watch_progress
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Continue Watching lookups are per-user and time-ordered.
create index if not exists watch_progress_user_updated_idx
  on public.watch_progress (user_id, last_updated desc);


-- ---------------------------------------------------------------------------
-- Server discovery: each desktop publishes where it can be reached, so the
-- phone finds it after a plain sign-in instead of typing an IP. Rows are
-- per-user (RLS) and are withdrawn when nothing is reachable (LAN off and no
-- tunnel) or you sign out. `addresses` looks like
--   [{"host":"192.168.1.23","kind":"lan"},
--    {"host":"100.101.102.103","kind":"tailscale"},
--    {"host":"https://tan-river-8823.trycloudflare.com","kind":"remote"}]
-- in preference order — the client tries each and stops at the first that
-- answers. `remote` entries are a full URL (Cloudflare's port, not ours) and
-- change every time the tunnel restarts, which is why the phone reads them from
-- here rather than storing one forever.
--
-- NOTE: `token` is the server's access token. It lives here so pairing is one
-- step; RLS means only this account can read it.
create table if not exists public.servers (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  server_id  text        not null,
  name       text        not null default '',
  port       int         not null default 3777,
  addresses  jsonb       not null default '[]'::jsonb,
  token      text        not null default '',
  last_seen  timestamptz not null default now(),
  primary key (user_id, server_id)
);

alter table public.servers enable row level security;

drop policy if exists "own servers" on public.servers;
create policy "own servers" on public.servers
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Account settings sync: one JSON blob per user holding syncable preferences
-- (subtitle/playback defaults, the user's own TMDB/OpenSubtitles keys) and
-- library definitions (name, type, folders). So a fresh install restores the
-- setup after sign-in. Newest `last_updated` wins, like everything else here.
--
-- Deliberately NOT synced (device-specific / security): the LAN access token,
-- the per-install server id, the auth session, and the network/autostart
-- toggles — a new machine must not silently expose itself. `data` looks like
--   {"settings":{"tmdbApiKey":"…","defaultSubLang":"en", …},
--    "libraries":[{"name":"Movies","type":"movies","path":"F:\\Movies",
--                  "folders":["G:\\More Movies"]}]}
create table if not exists public.user_settings (
  user_id      uuid        not null primary key references auth.users (id) on delete cascade,
  data         jsonb       not null default '{}'::jsonb,
  last_updated timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Watch party.
--
-- Two modes, both driven by the same rows:
--   'local'  — everyone plays their OWN copy of the file. Matched by Locality's
--              fingerprint (sha1 of filename+size), so no bytes cross the
--              network and neither side needs remote access turned on.
--   'stream' — only the host has the file; everyone else plays it off the
--              host's server over its tunnel URL. `host_server` carries the
--              address + token for that.
--
-- Playback state is exchanged by polling `party_state` (see party.ts) rather
-- than Realtime, so this schema needs no publication or websocket setup.


-- The only place an account gets a human-readable name. Invites resolve to a
-- row here by exact email OR username.
create table if not exists public.profiles (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  username   text        not null,
  email      text        not null default '',
  updated_at timestamptz not null default now()
);
-- Case-insensitive uniqueness: "Fabri" and "fabri" must not be two people.
create unique index if not exists profiles_username_key on public.profiles (lower(username));
create index if not exists profiles_email_idx on public.profiles (lower(email));

alter table public.profiles enable row level security;

-- Deliberately NO blanket read policy. A readable profiles table would let any
-- signed-in user dump every email and username on the instance. Other people's
-- rows are reachable only through locality_find_user() below, which answers
-- exact matches one at a time and so can't be used to enumerate anyone.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Invite lookup. `security definer` runs it as the owner, bypassing the policy
-- above; it returns only user_id + username (never the email back), and only on
-- an exact match, so it's a "do you know this person's address already?" check
-- rather than a directory.
create or replace function public.locality_find_user(identifier text)
returns table (user_id uuid, username text)
language sql
security definer
stable
set search_path = public
as $$
  select p.user_id, p.username
    from public.profiles p
   where lower(p.username) = lower(trim(identifier))
      or lower(p.email)    = lower(trim(identifier))
   limit 1;
$$;
revoke all on function public.locality_find_user(text) from public, anon;
grant execute on function public.locality_find_user(text) to authenticated;


create table if not exists public.parties (
  id           uuid        primary key default gen_random_uuid(),
  host_id      uuid        not null references auth.users (id) on delete cascade,
  mode         text        not null default 'local',   -- 'local' | 'stream'
  title        text        not null default '',
  -- What everyone is watching. `fingerprint` is how a guest finds its own copy
  -- in 'local' mode; `host_file_id` is the id on the HOST's server, used by
  -- 'stream' mode guests to address the file remotely.
  fingerprint  text        not null default '',
  host_file_id bigint,
  -- 'stream' only: {"url":"https://…","token":"…"} for reaching the host.
  host_server  jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);

create table if not exists public.party_members (
  party_id  uuid        not null references public.parties (id) on delete cascade,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  -- Denormalised so the member list renders without anyone reading anyone
  -- else's profile row.
  username  text        not null default '',
  status    text        not null default 'invited',   -- invited | joined | declined | left
  is_host   boolean     not null default false,
  -- 'local' mode: whether this member found the fingerprint in their library.
  has_file  boolean     not null default false,
  last_seen timestamptz not null default now(),
  primary key (party_id, user_id)
);
-- The invite inbox poll: "anything waiting for me?"
create index if not exists party_members_user_status_idx on public.party_members (user_id, status);
-- Presence: when this member last had the PLAYER open (distinct from last_seen,
-- which just means the app is in the party). Fresh (< ~12s) => the green dot.
alter table public.party_members add column if not exists watching_at timestamptz;

create table if not exists public.party_state (
  party_id         uuid        primary key references public.parties (id) on delete cascade,
  position_seconds double precision not null default 0,
  paused           boolean     not null default false,
  -- Monotonic. Anyone may pause or seek, so two near-simultaneous actions need
  -- a total order every client agrees on — highest seq wins, and a client that
  -- sees its own seq beaten stops arguing instead of oscillating.
  seq              bigint      not null default 0,
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);

-- People you've partied with, so the second party is one click instead of
-- retyping an address. Written on a successful invite and on an accept.
create table if not exists public.party_contacts (
  owner_id  uuid        not null references auth.users (id) on delete cascade,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  username  text        not null default '',
  email     text        not null default '',
  last_used timestamptz not null default now(),
  primary key (owner_id, user_id)
);

alter table public.parties        enable row level security;
alter table public.party_members  enable row level security;
alter table public.party_state    enable row level security;
alter table public.party_contacts enable row level security;

-- Membership tests as `security definer` helpers. Asking "is this user in this
-- party?" inside a policy ON party_members would re-enter that same policy and
-- error out; running the check as the function owner skips RLS and breaks the
-- cycle. Both are `stable`, so the planner calls them once per statement.
create or replace function public.is_party_member(pid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.party_members m
     where m.party_id = pid
       and m.user_id  = auth.uid()
       and m.status in ('invited', 'joined')
  );
$$;

create or replace function public.is_party_host(pid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.parties p where p.id = pid and p.host_id = auth.uid());
$$;

revoke all on function public.is_party_member(uuid) from public, anon;
revoke all on function public.is_party_host(uuid)   from public, anon;
grant execute on function public.is_party_member(uuid) to authenticated;
grant execute on function public.is_party_host(uuid)   to authenticated;

drop policy if exists "party read"   on public.parties;
drop policy if exists "party create" on public.parties;
drop policy if exists "party host edits" on public.parties;
create policy "party read" on public.parties
  for select using (host_id = auth.uid() or is_party_member(id));
create policy "party create" on public.parties
  for insert with check (host_id = auth.uid());
create policy "party host edits" on public.parties
  for update using (host_id = auth.uid()) with check (host_id = auth.uid());

-- The host may add members (that's an invite); everyone else may only write
-- their own row (accept, decline, leave, heartbeat).
drop policy if exists "members read"  on public.party_members;
drop policy if exists "members write" on public.party_members;
drop policy if exists "members edit"  on public.party_members;
create policy "members read" on public.party_members
  for select using (user_id = auth.uid() or is_party_member(party_id) or is_party_host(party_id));
create policy "members write" on public.party_members
  for insert with check (is_party_host(party_id) or user_id = auth.uid());
create policy "members edit" on public.party_members
  for update using (user_id = auth.uid() or is_party_host(party_id))
  with check (user_id = auth.uid() or is_party_host(party_id));

-- Anyone in the party can pause or seek for everyone (the chosen behaviour).
drop policy if exists "state read"  on public.party_state;
drop policy if exists "state write" on public.party_state;
drop policy if exists "state edit"  on public.party_state;
create policy "state read" on public.party_state
  for select using (is_party_member(party_id) or is_party_host(party_id));
create policy "state write" on public.party_state
  for insert with check (is_party_member(party_id) or is_party_host(party_id));
create policy "state edit" on public.party_state
  for update using (is_party_member(party_id) or is_party_host(party_id))
  with check (is_party_member(party_id) or is_party_host(party_id));

drop policy if exists "own contacts" on public.party_contacts;
create policy "own contacts" on public.party_contacts
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
