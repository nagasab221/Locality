import path from "path";
import type { DB } from "./db";
import type { ServerConfig } from "./types";
import { Tmdb } from "./services/tmdb";
import { TvMaze } from "./services/tvmaze";
import { AniList } from "./services/anilist";
import { Scanner } from "./services/scanner";
import { ProgressLedger } from "./services/progressLedger";
import { OpenSubtitles } from "./services/subtitles";
import { LibraryWatcher } from "./services/watcher";
import { MarkerDetector } from "./services/introDetect";
import { CloudSync } from "./services/cloudSync";
import { Tunnel } from "./services/tunnel";
import { Profiles } from "./services/profiles";
import { DownloadManager } from "./services/downloads";
import { Party } from "./services/party";

/** Everything the route handlers need, built once at startup. */
export interface Ctx {
  db: DB;
  config: ServerConfig;
  tmdb: Tmdb;
  tvmaze: TvMaze;
  anilist: AniList;
  scanner: Scanner;
  ledger: ProgressLedger;
  osubs: OpenSubtitles;
  watcher: LibraryWatcher;
  detector: MarkerDetector;
  cloud: CloudSync;
  /** Cloudflare tunnel for access from outside the home network. */
  tunnel: Tunnel;
  /** Household profiles + per-profile watch state. */
  profiles: Profiles;
  /** Watch party: invites, membership, and synchronised playback state. */
  party: Party;
  /** Downloads pulled from other Locality servers. */
  downloads: DownloadManager;
  imagesDir: string;
  subsCacheDir: string;
  /** Cached single-frame seek previews (one jpg per file + time bucket). */
  thumbsDir: string;
  /** Media downloaded from other servers, for offline/local playback. */
  downloadsDir: string;
  /** Filled in by startServer once the listener is up. */
  runtime: { lanActive: boolean; port: number };
}

export function buildContext(db: DB, config: ServerConfig): Ctx {
  // NOT under "<dataDir>/cache" — that folder is Chromium's own disk cache
  // (userData/cache/Cache_Data) and Chromium prunes/wipes it at will, which
  // silently deleted our downloaded artwork between sessions.
  const imagesDir = path.join(config.dataDir, "media-cache", "images");
  const tmdb = new Tmdb(db, imagesDir);
  const tvmaze = new TvMaze();
  const anilist = new AniList();
  const scanner = new Scanner(db, tmdb, tvmaze, anilist, imagesDir);
  const ledger = new ProgressLedger(db, config.documentsDir);
  const tunnel = new Tunnel(config.dataDir);
  const subsCacheDir = path.join(config.dataDir, "media-cache", "subtitles");
  const downloadsDir = path.join(config.dataDir, "downloads");
  // The getter (rather than the Tunnel itself) keeps cloudSync unaware of how
  // remote access is implemented — it just publishes whatever URL is live. The
  // rescan callback lets it scan libraries restored from the account. Built
  // before the returned object so the party can borrow its session.
  const cloud = new CloudSync(db, ledger, () => tunnel.publicUrl(), (libraryId) => {
    const lib = db.prepare("SELECT * FROM libraries WHERE id = ?").get(libraryId) as any;
    if (lib) void scanner.scanLibrary(lib);
  });
  return {
    db,
    config,
    tmdb,
    tvmaze,
    anilist,
    scanner,
    ledger,
    osubs: new OpenSubtitles(db, config.appVersion),
    watcher: new LibraryWatcher(db, scanner),
    detector: new MarkerDetector(db),
    cloud,
    tunnel,
    profiles: new Profiles(db, ledger),
    // Same getter again: a "stream" party publishes this URL as the address
    // guests fetch the video from.
    party: new Party(db, cloud, () => tunnel.publicUrl()),
    downloads: new DownloadManager(db, imagesDir, downloadsDir, subsCacheDir),
    imagesDir,
    subsCacheDir,
    thumbsDir: path.join(config.dataDir, "media-cache", "thumbs"),
    downloadsDir,
    runtime: { lanActive: false, port: 0 },
  };
}
