// Shared backend types for the local server layer.
// This layer is deliberately independent of Electron: main.ts injects paths/config
// so a future remote-access layer could host the same server outside Electron.

export interface ServerConfig {
  /** Where SQLite DB + image/subtitle caches live (Electron userData). */
  dataDir: string;
  /** User's Documents folder — locality.json lives in Documents/Locality/. */
  documentsDir: string;
  /** App version string for User-Agent headers. */
  appVersion: string;
  /** Path of the app log file (surfaced in Settings). */
  logPath?: string;
}

export type LibraryType = "movies" | "tv" | "gallery" | "other";

export interface Library {
  id: number;
  name: string;
  type: LibraryType;
  path: string;
  created_at: string;
  /** 1 for the hidden Downloads library; excluded from scans + normal listings. */
  internal?: number;
  /** 1 = reachable by remote/LAN clients (default), 0 = private to this PC. */
  shared?: number;
}

export type MatchStatus = "matched" | "unmatched" | "needs_match";

export interface MediaItem {
  id: number;
  library_id: number;
  type: "movie" | "show";
  title: string;
  sort_title: string;
  year: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  overview: string | null;
  tagline: string | null;
  poster: string | null; // cache-relative image path
  backdrop: string | null;
  genres: string; // JSON string[]
  cast_json: string; // JSON {name, character}[]
  crew_json: string; // JSON {name, job}[]
  rating: number | null;
  runtime: number | null; // minutes
  status: MatchStatus;
  added_at: string;
  // Added by later migrations (see db.ts) — present on every row.
  provider: "tmdb" | "tvmaze" | "anilist";
  provider_id: number | null;
  /** "Removed from library": kept so rescans can't resurrect it. */
  hidden: number;
  collection_id: number | null;
  collection_name: string | null;
  /** JSON number[] of cached recommendation ids. */
  recs_json: string | null;
}

export interface Episode {
  id: number;
  show_id: number;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  air_date: string | null;
  still: string | null;
  runtime: number | null;
  tmdb_id: number | null;
  // Intro/credits markers from audio-fingerprint detection (later migration).
  intro_start: number | null;
  intro_end: number | null;
  credits_start: number | null;
  /** 1 once detection has been attempted, found or not. */
  markers_done: number;
}

export interface Season {
  id: number;
  show_id: number;
  season: number;
  name: string | null;
  poster: string | null;
  overview: string | null;
}

export interface MediaFile {
  id: number;
  library_id: number;
  media_item_id: number | null;
  episode_id: number | null;
  path: string;
  filename: string;
  size: number;
  mtime: number;
  fingerprint: string;
  parsed_json: string;
  missing: number;
  added_at: string;
}

/** A `watch_progress` row. Note `watched` is SQLite's 0/1, unlike the
 *  ledger-facing [ProgressEntry] which uses a real boolean. */
export interface WatchProgressRow {
  fingerprint: string;
  filename: string;
  size_bytes: number;
  duration_seconds: number;
  position_seconds: number;
  watched: number;
  last_updated: string;
}

export interface ProgressEntry {
  filename: string;
  size_bytes: number;
  duration_seconds: number;
  position_seconds: number;
  watched: boolean;
  last_updated: string; // ISO
}

export type ProgressLedgerData = Record<string, ProgressEntry>;

export interface ParsedName {
  kind: "movie" | "episode" | "unknown";
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** 0..1 — below ~0.5 the item is surfaced for manual matching. */
  confidence: number;
}

export interface SubtitleRecord {
  id: number;
  file_id: number;
  path: string;
  lang: string | null;
  /** 'embedded' = extracted from the container by ffmpeg. */
  source: "local" | "embedded" | "opensubtitles";
  label: string;
}

/** Remembered audio/subtitle language per show or movie. */
export interface ShowPrefs {
  item_id: number;
  audio_lang: string | null;
  /** Language code, or the sentinel 'off'. */
  sub_lang: string | null;
}

export interface WatchlistRow {
  item_id: number;
  added_at: string;
}

export interface Profile {
  id: number;
  name: string;
  /** #rrggbb avatar colour. */
  color: string;
  is_default: number;
  created_at: string;
  /** True when a local password is set. The hash itself is never sent. */
  locked?: boolean;
}

export interface Collection {
  id: number;
  name: string;
}

export interface CollectionItem {
  collection_id: number;
  item_id: number;
}

/** Cached TMDB person payload. */
export interface PersonRow {
  tmdb_id: number;
  data: string;
  photo: string | null;
  fetched_at: string;
}

export interface ScanEvent {
  libraryId: number;
  phase: "walking" | "parsing" | "metadata" | "done" | "error";
  detail?: string;
  found?: number;
  processed?: number;
}
