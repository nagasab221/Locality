export interface Library {
  id: number;
  name: string;
  type: "movies" | "tv" | "gallery" | "other";
  path: string;
  scanning?: boolean;
  internal?: number;
  /** 1 = reachable by remote/LAN clients (default), 0 = private to this PC. */
  shared?: number;
  /** Additional source folders beyond the primary `path`. */
  folders?: { id: number; path: string }[];
}

export interface Progress {
  filename: string;
  size_bytes: number;
  duration_seconds: number;
  position_seconds: number;
  watched: boolean;
  last_updated: string;
}

export interface MediaFile {
  id: number;
  path: string;
  filename: string;
  size: number;
  fingerprint: string;
  progress?: Progress | null;
}

export interface ListItem {
  id: number;
  library_id: number;
  type: "movie" | "show";
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  genres: string[];
  rating: number | null;
  status: "matched" | "unmatched" | "needs_match";
  provider?: "tmdb" | "tvmaze" | "anilist";
  hidden?: number;
  added_at: string;
  // movies
  watched?: boolean;
  inProgress?: boolean;
  /** Resume position as 1–99; absent on older remote servers. */
  progressPct?: number;
  // shows
  episodeCount?: number;
  watchedCount?: number;
}

export interface EpisodeRow {
  id: number;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  air_date: string | null;
  still: string | null;
  runtime: number | null;
  intro_start?: number | null;
  intro_end?: number | null;
  credits_start?: number | null;
  file: MediaFile | null;
  progress: Progress | null;
}

export interface SeasonBlock {
  season: number;
  name: string;
  poster: string | null;
  overview: string | null;
  episodes: EpisodeRow[];
}

export interface ItemDetail extends ListItem {
  overview: string | null;
  tagline: string | null;
  runtime: number | null;
  cast: { id?: number; name: string; character: string }[];
  crew: { id?: number; name: string; job: string }[];
  tmdb_id: number | null;
  files?: MediaFile[];
  seasons?: SeasonBlock[];
  inWatchlist?: boolean;
}

export interface HomeCard {
  kind: "movie" | "episode";
  fileId: number;
  itemId: number;
  title: string;
  subtitle: string;
  poster: string | null;
  backdrop: string | null;
  position: number;
  duration: number;
}

export interface Subtitle {
  id: number;
  file_id: number;
  path: string;
  lang: string | null;
  source: "local" | "opensubtitles";
  label: string;
  format: string;
}

export interface Profile {
  id: number;
  name: string;
  color: string;
  is_default: number;
  created_at: string;
  /** True when this profile has a local password. */
  locked?: boolean;
}

export interface AppState {
  libraries: Library[];
  settings: Record<string, string>;
  ledgerPath: string;
  /** App version (e.g. "1.0.0"), shown in Settings > General > About. */
  version?: string;
  lan?: {
    enabled: boolean;
    active: boolean;
    port: number;
    activePort: number;
    token: string;
    addresses: string[];
  };
  /** Cloudflare tunnel status. Null for non-local callers. */
  remote?: {
    enabled: boolean;
    state: "off" | "downloading" | "starting" | "online" | "error";
    url: string | null;
    error: string | null;
    downloadPercent: number | null;
  } | null;
  logPath: string | null;
  dataDir: string;
}

export interface NetCheckResult {
  name: string;
  reachable: boolean;
  status?: number;
  ms: number;
  error?: string;
}
