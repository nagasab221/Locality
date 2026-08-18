import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export type DB = Database.Database;

export function openDatabase(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "locality.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  // Early corruption warning — cheap on our DB sizes, and silent btree damage
  // once went unnoticed until it had eaten most of the catalog.
  try {
    const check = db.pragma("quick_check") as { quick_check: string }[];
    if (!(check.length === 1 && check[0].quick_check === "ok")) {
      console.error("DATABASE INTEGRITY WARNING:", JSON.stringify(check).slice(0, 500));
    }
  } catch (e) {
    console.error("DATABASE INTEGRITY WARNING:", e);
  }
  return db;
}

/**
 * Safety net against a corrupted/mangled database: one consistent snapshot per
 * day into <dataDir>/backups (SQLite online backup, safe while in use), newest
 * three kept. Restoring is "copy one file back".
 */
export async function backupDatabase(db: DB, dataDir: string): Promise<string | null> {
  try {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `locality-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(dest)) await db.backup(dest);
    const old = fs
      .readdirSync(dir)
      .filter((f) => /^locality-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .slice(0, -3);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return dest;
  } catch (e) {
    console.error("db backup failed:", e);
    return null;
  }
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('movies','tv','gallery','other')),
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      internal INTEGER NOT NULL DEFAULT 0,
      position INTEGER
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('movie','show')),
      title TEXT NOT NULL,
      sort_title TEXT NOT NULL,
      year INTEGER,
      tmdb_id INTEGER,
      imdb_id TEXT,
      overview TEXT,
      tagline TEXT,
      poster TEXT,
      backdrop TEXT,
      genres TEXT NOT NULL DEFAULT '[]',
      cast_json TEXT NOT NULL DEFAULT '[]',
      crew_json TEXT NOT NULL DEFAULT '[]',
      rating REAL,
      runtime INTEGER,
      status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('matched','unmatched','needs_match')),
      added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_items_library ON media_items(library_id);
    CREATE INDEX IF NOT EXISTS idx_items_tmdb ON media_items(tmdb_id);

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      name TEXT,
      poster TEXT,
      overview TEXT,
      UNIQUE (show_id, season)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      title TEXT,
      overview TEXT,
      air_date TEXT,
      still TEXT,
      runtime INTEGER,
      tmdb_id INTEGER,
      UNIQUE (show_id, season, episode)
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      media_item_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
      episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
      path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      parsed_json TEXT NOT NULL DEFAULT '{}',
      missing INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_files_item ON files(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_files_episode ON files(episode_id);
    CREATE INDEX IF NOT EXISTS idx_files_fp ON files(fingerprint);

    CREATE TABLE IF NOT EXISTS watch_progress (
      fingerprint TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      position_seconds REAL NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subtitles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      lang TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      label TEXT NOT NULL DEFAULT '',
      UNIQUE (file_id, path)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      tmdb_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      photo TEXT,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      UNIQUE (collection_id, item_id)
    );

    -- Remembered audio + subtitle language per show/movie, so the player can
    -- re-apply the user's last pick on every episode instead of re-asking.
    -- sub_lang can be the sentinel 'off' (user explicitly turned subs off).
    CREATE TABLE IF NOT EXISTS show_prefs (
      item_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      audio_lang TEXT,
      sub_lang TEXT
    );

    -- "Want to watch" list. One row per item; shown as a Home row.
    CREATE TABLE IF NOT EXISTS watchlist (
      item_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL
    );

    -- Household profiles, so each person has their own Continue Watching and
    -- watched history. Deliberately additive: the DEFAULT profile keeps using
    -- the original watch_progress table (which the portable ledger + cloud sync
    -- read), so that whole tested path is untouched. Extra profiles get their
    -- own rows in profile_progress and are server-local.
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#C4A47C',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS profile_progress (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      position_seconds REAL NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      PRIMARY KEY (profile_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_progress ON profile_progress(profile_id, watched, position_seconds);

    -- Downloads pulled from another Locality server. One job per movie/season;
    -- the actual media lands as ordinary rows in the internal library (above),
    -- and these tables only track the transfer progress + source.
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'downloading',
      total_bytes INTEGER NOT NULL DEFAULT 0,
      done_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS download_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      download_id INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
      file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
      remote_stream_url TEXT NOT NULL,
      subs_json TEXT NOT NULL DEFAULT '[]',
      abs_path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_download_files_job ON download_files(download_id, status);

    -- Photo/short-video libraries. Kept separate from media_items: a gallery
    -- item has no seasons, cast, or TMDB match — just a file, a kind, and the
    -- subfolder it lives in (used to group into albums).
    CREATE TABLE IF NOT EXISTS gallery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL,               -- 'photo' | 'video'
      folder TEXT NOT NULL DEFAULT '',  -- relative subfolder = album
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      taken_at TEXT,
      missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_lib ON gallery_items(library_id, missing);

    -- Extra source folders for a library. libraries.path stays the primary
    -- folder (so nothing that reads it breaks); these are additional roots the
    -- scanner and watcher also cover. A folder belongs to at most one library.
    CREATE TABLE IF NOT EXISTS library_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_library_folders ON library_folders(library_id);
  `);

  // Exactly one default profile always exists; the default's progress lives in
  // watch_progress, so this row is the identity the ledger + cloud already sync.
  db.prepare(
    "INSERT INTO profiles (name, color, is_default) SELECT 'Me', '#C4A47C', 1 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE is_default = 1)"
  ).run();

  // Additive migrations for databases created before these columns existed.
  for (const stmt of [
    "ALTER TABLE media_items ADD COLUMN provider TEXT NOT NULL DEFAULT 'tmdb'",
    "ALTER TABLE media_items ADD COLUMN provider_id INTEGER",
    // "Remove from library" without touching files: hidden items stay in the
    // DB (so rescans don't resurrect them) but are filtered from the UI.
    "ALTER TABLE media_items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
    // TMDB box-set membership + cached recommendation ids
    "ALTER TABLE media_items ADD COLUMN collection_id INTEGER",
    "ALTER TABLE media_items ADD COLUMN collection_name TEXT",
    "ALTER TABLE media_items ADD COLUMN recs_json TEXT",
    // Per-episode intro/credits markers from audio-fingerprint detection.
    // markers_done=1 means detection was attempted (found or not).
    "ALTER TABLE episodes ADD COLUMN intro_start REAL",
    "ALTER TABLE episodes ADD COLUMN intro_end REAL",
    "ALTER TABLE episodes ADD COLUMN credits_start REAL",
    "ALTER TABLE episodes ADD COLUMN markers_done INTEGER NOT NULL DEFAULT 0",
    // Optional local per-profile lock. Salt + scrypt hash; both NULL = no lock.
    // Stored on the (local) server, so unlocking never needs the internet.
    "ALTER TABLE profiles ADD COLUMN password_hash TEXT",
    "ALTER TABLE profiles ADD COLUMN password_salt TEXT",
    // Marks the hidden "Downloads" library that holds content pulled from other
    // servers. Excluded from scans, the watcher, and normal listings; surfaced
    // only on the Downloads page. Its items are otherwise ordinary catalog rows,
    // so they play through the exact same pipeline as scanned files.
    "ALTER TABLE libraries ADD COLUMN internal INTEGER NOT NULL DEFAULT 0",
    // Manual sidebar order. NULL sorts last (by name), so untouched libraries
    // keep the old alphabetical order until the user reorders in Settings.
    "ALTER TABLE libraries ADD COLUMN position INTEGER",
    // Content certification (e.g. TV-MA, PG-13), fetched on demand from TMDB and
    // cached here. NULL = not fetched yet or unavailable.
    "ALTER TABLE media_items ADD COLUMN content_rating TEXT",
    // Whether this library is reachable by remote/LAN clients. Default 1 keeps
    // existing behaviour (everything shared); 0 hides it from every non-local
    // request — listings, detail, streams and subtitles alike.
    "ALTER TABLE libraries ADD COLUMN shared INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      /* column already exists */
    }
  }

  // Allow the two new library types on databases created before them. SQLite
  // can't ALTER a CHECK, so the (tiny) libraries table is rebuilt once — ids are
  // preserved, so the many rows that reference it by library_id stay valid. Runs
  // after the ALTER loop so `internal` is guaranteed present to copy. Guarded on
  // the schema text; FKs toggle off around it so DROP fires no cascades. (Fresh
  // databases already ship the new CHECK, so this is skipped there.)
  const libSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='libraries'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (/CHECK/i.test(libSql) && !/gallery/.test(libSql)) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE libraries_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('movies','tv','gallery','other')),
            path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            internal INTEGER NOT NULL DEFAULT 0,
            position INTEGER
          );
          INSERT INTO libraries_new (id, name, type, path, created_at, internal, position)
            SELECT id, name, type, path, created_at, COALESCE(internal, 0), position FROM libraries;
          DROP TABLE libraries;
          ALTER TABLE libraries_new RENAME TO libraries;
        `);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
