// Library scanner: recursive walk, incremental diff against the files table,
// filename parsing, show/episode grouping, then metadata for new items.
//
// Metadata sources: TMDB (primary, needs user API key), with automatic
// fallback to TVmaze (TV/anime, keyless) and AniList (anime, keyless).
// The Match dialog can also force a specific provider/id.
import fs from "fs";
import path from "path";
import { getSetting, type DB } from "../db";
import type { Library, ParsedName } from "../types";
import { parseMediaPath, normalizeTitle } from "./parser";
import { fingerprintFile } from "./fingerprint";
import { Tmdb, TmdbError } from "./tmdb";
import { TvMaze } from "./tvmaze";
import { AniList, anilistTitle } from "./anilist";
import { cacheImageFromUrl, resetImageFailureBreaker, stripHtml, yearOfDate } from "./images";
import { extractFrame } from "./ffthumb";
import { readTakenDate } from "./exif";
import { events } from "./events";

export const VIDEO_EXTS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".flv", ".webm", ".mpg", ".mpeg", ".ts", ".m2ts",
]);
export const SUB_EXTS = new Set([".srt", ".ass", ".ssa", ".vtt"]);
/** Still images a Gallery library collects. */
export const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tif", ".tiff", ".avif",
]);
/** Short clips that live alongside photos (phone videos etc.). */
export const GALLERY_VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v", ".gif", ".3gp", ".mkv", ".avi"]);

const MATCH_CONFIDENCE_FLOOR = 0.5;

export type MetaProvider = "tmdb" | "tvmaze" | "anilist";

export class Scanner {
  private scanning = new Set<number>();
  /** Libraries asked to rescan while a scan was already running. */
  private pendingRescan = new Set<number>();
  /** Set when TMDB rejects the key mid-scan so we stop hammering it. */
  private tmdbAuthFailed = false;

  constructor(
    private db: DB,
    private tmdb: Tmdb,
    private tvmaze: TvMaze,
    private anilist: AniList,
    private imagesDir: string
  ) {}

  isScanning(libraryId: number) {
    return this.scanning.has(libraryId);
  }

  /**
   * Incremental scan. Concurrent scans of one library are coalesced — but a
   * request that arrives WHILE a scan runs (e.g. a folder was just added) is
   * remembered and re-run afterwards, re-reading the library so the new folder
   * is covered rather than silently dropped.
   */
  async scanLibrary(library: Library): Promise<void> {
    if (this.scanning.has(library.id)) {
      this.pendingRescan.add(library.id);
      return;
    }
    this.scanning.add(library.id);
    try {
      await this.doScan(library);
    } catch (e: any) {
      events.broadcast("scan", { libraryId: library.id, phase: "error", detail: String(e?.message ?? e) });
      console.error(`scan of library ${library.id} failed:`, e);
    } finally {
      this.scanning.delete(library.id);
      if (this.pendingRescan.has(library.id)) {
        this.pendingRescan.delete(library.id);
        const fresh = this.db.prepare("SELECT * FROM libraries WHERE id = ?").get(library.id) as Library | undefined;
        if (fresh) void this.scanLibrary(fresh);
      }
    }
  }

  // ---- gallery + other (matcher-free) ---------------------------------------

  /** Photo/clip library: reconcile gallery_items against the folder. */
  private async doScanGallery(library: Library) {
    console.log(`scan start (gallery): library ${library.id} "${library.name}" at ${library.path}`);
    events.broadcast("scan", { libraryId: library.id, phase: "walking" });
    const roots = libraryRoots(this.db, library);
    const found = roots.flatMap((r) => walkFiles(r, (ext) => IMAGE_EXTS.has(ext) || GALLERY_VIDEO_EXTS.has(ext)));
    events.broadcast("scan", { libraryId: library.id, phase: "parsing", found: found.length });

    const known = this.db
      .prepare("SELECT id, path, mtime, taken_at FROM gallery_items WHERE library_id = ?")
      .all(library.id) as { id: number; path: string; mtime: number; taken_at: string | null }[];
    const knownByPath = new Map(known.map((k) => [k.path, k]));
    const seen = new Set<string>();

    // EXIF pass (before the write transaction, so it can await): JPEGs get their
    // real taken-date — file dates lie the moment photos are copied around.
    // Only new/changed files and ones still carrying the mtime-derived default
    // are read, so rescans of an untouched library do no file I/O here.
    const takenAt = new Map<string, string>();
    for (const f of found) {
      const ext = path.extname(f.path).toLowerCase();
      const k = knownByPath.get(f.path);
      const mtimeIso = new Date(f.mtime).toISOString();
      const isJpeg = ext === ".jpg" || ext === ".jpeg";
      if (isJpeg && (!k || k.mtime !== f.mtime || !k.taken_at || k.taken_at === mtimeIso)) {
        takenAt.set(f.path, (await readTakenDate(f.path)) ?? mtimeIso);
      } else {
        takenAt.set(f.path, (k && k.mtime === f.mtime && k.taken_at) || mtimeIso);
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO gallery_items (library_id, path, filename, kind, folder, size, mtime, taken_at, missing)
       VALUES (@library_id, @path, @filename, @kind, @folder, @size, @mtime, @taken_at, 0)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, taken_at = excluded.taken_at, missing = 0`
    );
    const tx = this.db.transaction(() => {
      for (const f of found) {
        seen.add(f.path);
        const ext = path.extname(f.path).toLowerCase();
        upsert.run({
          library_id: library.id,
          path: f.path,
          filename: path.basename(f.path),
          kind: IMAGE_EXTS.has(ext) ? "photo" : "video",
          folder: path.dirname(path.relative(rootFor(roots, f.path), f.path)).replace(/\\/g, "/").replace(/^\.$/, ""),
          size: f.size,
          mtime: f.mtime,
          taken_at: takenAt.get(f.path),
        });
      }
      for (const k of known) if (!seen.has(k.path)) this.db.prepare("DELETE FROM gallery_items WHERE id = ?").run(k.id);
    });
    tx();

    events.broadcast("scan", { libraryId: library.id, phase: "done", count: found.length });
    events.broadcast("library-changed", { libraryId: library.id });
    console.log(`scan done (gallery): library ${library.id} — ${found.length} items`);
  }

  /** "Other" video library: one movie-shaped item per file, no matching. A frame
   *  is grabbed for the poster since there's no artwork to fetch. */
  private async doScanOther(library: Library) {
    console.log(`scan start (other): library ${library.id} "${library.name}" at ${library.path}`);
    events.broadcast("scan", { libraryId: library.id, phase: "walking" });
    const found = libraryRoots(this.db, library).flatMap((r) => walkFiles(r, (ext) => VIDEO_EXTS.has(ext)));
    events.broadcast("scan", { libraryId: library.id, phase: "parsing", found: found.length });

    const known = this.db.prepare("SELECT id, path, size, mtime FROM files WHERE library_id = ?").all(library.id) as { id: number; path: string; size: number; mtime: number }[];
    const knownByPath = new Map(known.map((k) => [k.path, k]));
    const seen = new Set<string>();
    const newPosters: { path: string; itemId: number }[] = [];

    for (const f of found) {
      seen.add(f.path);
      const existing = knownByPath.get(f.path);
      if (existing) {
        if (existing.size !== f.size || existing.mtime !== f.mtime) {
          this.db.prepare("UPDATE files SET size = ?, mtime = ?, fingerprint = ?, missing = 0 WHERE id = ?")
            .run(f.size, f.mtime, fingerprintFile(f.path, f.size), existing.id);
        } else {
          this.db.prepare("UPDATE files SET missing = 0 WHERE id = ? AND missing = 1").run(existing.id);
        }
        continue;
      }
      const title = cleanFileTitle(path.basename(f.path));
      const mi = this.db
        .prepare("INSERT INTO media_items (library_id, type, title, sort_title, status, provider) VALUES (?, 'movie', ?, ?, 'matched', 'local')")
        .run(library.id, title, sortTitle(title));
      const itemId = Number(mi.lastInsertRowid);
      this.db
        .prepare("INSERT INTO files (library_id, media_item_id, path, filename, size, mtime, fingerprint, missing) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
        .run(library.id, itemId, f.path, path.basename(f.path), f.size, f.mtime, fingerprintFile(f.path, f.size));
      newPosters.push({ path: f.path, itemId });
    }

    for (const k of known) if (!seen.has(k.path)) this.db.prepare("UPDATE files SET missing = 1 WHERE id = ?").run(k.id);
    this.pruneOrphans(library.id);

    events.broadcast("scan", { libraryId: library.id, phase: "done", count: found.length });
    events.broadcast("library-changed", { libraryId: library.id });
    console.log(`scan done (other): library ${library.id} — ${found.length} files, ${newPosters.length} new`);

    // Posters after the scan is reported done, so the grid appears immediately.
    for (const p of newPosters) await this.makeVideoPoster(p.path, p.itemId);
  }

  /** Grab a frame ~10% in as the poster for an "Other" item. */
  private async makeVideoPoster(filePath: string, itemId: number) {
    try {
      const dir = path.join(this.imagesDir, "poster");
      fs.mkdirSync(dir, { recursive: true });
      const name = fingerprintFile(filePath, 0).replace(/^fp_/, "") + ".jpg";
      const abs = path.join(dir, name);
      if (!fs.existsSync(abs)) {
        const ok = await extractFrame(filePath, abs, { at: 8, width: 400 });
        if (!ok) return;
      }
      this.db.prepare("UPDATE media_items SET poster = ? WHERE id = ?").run(path.posix.join("poster", name), itemId);
      events.broadcast("item-changed", { itemId });
    } catch {
      /* poster is best-effort */
    }
  }

  private async doScan(library: Library) {
    // Photos and misc video use their own, matcher-free pipelines.
    if (library.type === "gallery") return this.doScanGallery(library);
    if (library.type === "other") return this.doScanOther(library);

    this.tmdbAuthFailed = false;
    resetImageFailureBreaker();
    console.log(`scan start: library ${library.id} "${library.name}" (${library.type}) at ${library.path}`);
    events.broadcast("scan", { libraryId: library.id, phase: "walking" });
    // Movie libraries skip files under the size floor (release-bundled bonus
    // clips); TV keeps everything — small anime episodes are legitimate.
    const rawMin = getSetting(this.db, "minMovieSizeMB");
    const minMB = rawMin === undefined || rawMin === null || rawMin === "" ? 200 : Math.max(0, Number(rawMin) || 0);
    const roots = libraryRoots(this.db, library);
    const found = roots.flatMap((r) => walkVideos(r, library.type === "movies" ? minMB * 1024 * 1024 : 0));
    events.broadcast("scan", { libraryId: library.id, phase: "parsing", found: found.length });

    const known = this.db
      .prepare("SELECT id, path, size, mtime FROM files WHERE library_id = ?")
      .all(library.id) as { id: number; path: string; size: number; mtime: number }[];
    const knownByPath = new Map(known.map((k) => [k.path, k]));
    const seen = new Set<string>();

    const newFiles: { path: string; size: number; mtime: number }[] = [];
    for (const f of found) {
      seen.add(f.path);
      const existing = knownByPath.get(f.path);
      if (!existing) {
        newFiles.push(f);
      } else if (existing.size !== f.size || existing.mtime !== f.mtime) {
        // Changed in place (e.g. re-encoded): refingerprint.
        this.db
          .prepare("UPDATE files SET size = ?, mtime = ?, fingerprint = ?, missing = 0 WHERE id = ?")
          .run(f.size, f.mtime, fingerprintFile(f.path, f.size), existing.id);
      } else {
        this.db.prepare("UPDATE files SET missing = 0 WHERE id = ? AND missing = 1").run(existing.id);
      }
    }

    // Files that disappeared (deleted or renamed — a rename shows up as remove+add).
    for (const k of known) {
      if (!seen.has(k.path)) {
        this.db.prepare("UPDATE files SET missing = 1 WHERE id = ?").run(k.id);
      }
    }
    this.pruneOrphans(library.id);

    // Register new files + attach to items/episodes.
    let processed = 0;
    const pendingMetadata = new Set<number>(); // media_item ids needing metadata
    for (const f of newFiles) {
      const rel = path.relative(rootFor(roots, f.path), f.path);
      const parsed = parseMediaPath(rel, library.type);
      const itemId = this.attachFile(library, f, parsed);
      if (itemId) pendingMetadata.add(itemId);
      processed++;
      if (processed % 25 === 0) {
        events.broadcast("scan", { libraryId: library.id, phase: "parsing", found: found.length, processed });
      }
    }

    // Re-parse files stuck on low-confidence items (never manually matched):
    // parser improvements or a library-type fix can regroup them on rescan
    // instead of leaving one broken "show" per file forever.
    const stuck = this.db
      .prepare(
        `SELECT f.path, f.size, f.mtime, f.parsed_json FROM files f
         JOIN media_items mi ON mi.id = f.media_item_id
         WHERE f.library_id = ? AND f.missing = 0
           AND mi.status = 'needs_match' AND mi.provider_id IS NULL AND mi.tmdb_id IS NULL`
      )
      .all(library.id) as { path: string; size: number; mtime: number; parsed_json: string }[];
    let regrouped = 0;
    for (const f of stuck) {
      const rel = path.relative(rootFor(roots, f.path), f.path);
      const parsed = parseMediaPath(rel, library.type);
      if (JSON.stringify(parsed) === f.parsed_json) continue; // parser sees it the same way
      const itemId = this.attachFile(library, { path: f.path, size: f.size, mtime: f.mtime }, parsed);
      if (itemId) pendingMetadata.add(itemId);
      regrouped++;
    }
    if (regrouped > 0) this.pruneOrphans(library.id); // drop the emptied husk items

    // Items still bare from scans that ran before metadata sources were reachable.
    // (needs_match items are excluded — those wait for the manual Match dialog.)
    const bare = this.db
      .prepare("SELECT id FROM media_items WHERE library_id = ? AND status = 'unmatched'")
      .all(library.id) as { id: number }[];
    for (const b of bare) pendingMetadata.add(b.id);

    // Self-heal: matched items whose cached artwork files have vanished from
    // disk get their metadata (and images) re-fetched from the stored provider.
    for (const id of this.itemsWithMissingArtwork(library.id)) pendingMetadata.add(id);

    if (pendingMetadata.size > 0) {
      let done = 0;
      for (const itemId of pendingMetadata) {
        events.broadcast("scan", {
          libraryId: library.id, phase: "metadata", found: pendingMetadata.size, processed: done,
        });
        await this.fetchMetadataForItem(itemId).catch((e) => {
          console.error(`metadata for item ${itemId} failed:`, e);
        });
        done++;
      }
    }

    console.log(
      `scan done: library ${library.id} — ${found.length} files, ${newFiles.length} new, ` +
        `${regrouped} regrouped, ${pendingMetadata.size} metadata fetches`
    );
    events.broadcast("scan", { libraryId: library.id, phase: "done", found: found.length });
    events.broadcast("library-changed", { libraryId: library.id });
  }

  /** Delete media items whose files have all gone missing/removed. */
  private pruneOrphans(libraryId: number) {
    this.db
      .prepare(
        `DELETE FROM files WHERE library_id = ? AND missing = 1
         AND fingerprint NOT IN (SELECT fingerprint FROM watch_progress)`
      )
      .run(libraryId);
    this.db
      .prepare(
        `DELETE FROM media_items WHERE library_id = ? AND type = 'movie'
         AND id NOT IN (SELECT media_item_id FROM files WHERE media_item_id IS NOT NULL AND missing = 0)`
      )
      .run(libraryId);
    this.db
      .prepare(
        `DELETE FROM episodes WHERE show_id IN (SELECT id FROM media_items WHERE library_id = ?)
         AND id NOT IN (SELECT episode_id FROM files WHERE episode_id IS NOT NULL AND missing = 0)`
      )
      .run(libraryId);
    this.db
      .prepare(
        `DELETE FROM media_items WHERE library_id = ? AND type = 'show'
         AND id NOT IN (SELECT DISTINCT show_id FROM episodes)`
      )
      .run(libraryId);
  }

  /** Create/find the media item (and episode row for TV) for a new file. Returns item id if it needs metadata. */
  private attachFile(
    library: Library,
    f: { path: string; size: number; mtime: number },
    parsed: ParsedName
  ): number | null {
    const fingerprint = fingerprintFile(f.path, f.size);
    const filename = path.basename(f.path);
    const insertFile = this.db.prepare(`
      INSERT INTO files (library_id, media_item_id, episode_id, path, filename, size, mtime, fingerprint, parsed_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
        fingerprint=excluded.fingerprint, missing=0, media_item_id=excluded.media_item_id,
        episode_id=excluded.episode_id, parsed_json=excluded.parsed_json
    `);

    const title = parsed.title || filename.replace(/\.[^.]+$/, "");
    const status = parsed.confidence >= MATCH_CONFIDENCE_FLOOR ? "unmatched" : "needs_match";

    if (library.type === "tv" && parsed.kind !== "movie") {
      const show = this.findOrCreateItem(library.id, "show", title, parsed.year, status);
      const season = parsed.season ?? 1;
      const episode = parsed.episode ?? 0;
      const epInsert = this.db
        .prepare(
          `INSERT INTO episodes (show_id, season, episode) VALUES (?, ?, ?)
           ON CONFLICT(show_id, season, episode) DO NOTHING`
        )
        .run(show.id, season, episode);
      const epRow = this.db
        .prepare("SELECT id, title FROM episodes WHERE show_id = ? AND season = ? AND episode = ?")
        .get(show.id, season, episode) as { id: number; title: string | null };
      insertFile.run(library.id, show.id, epRow.id, f.path, filename, f.size, f.mtime, fingerprint, JSON.stringify(parsed));
      // Unmatched show → needs a full match. Matched show → still (re)fetch when
      // THIS episode is bare: a brand-new row (just inserted) or one that never
      // got its per-episode metadata. That's what makes a newly added episode
      // fill in automatically instead of waiting for a manual Refresh, while
      // already-populated episodes are skipped on ordinary rescans.
      if (show.status !== "matched") return show.id;
      return epInsert.changes > 0 || !epRow.title ? show.id : null;
    }

    const item = this.findOrCreateItem(library.id, "movie", title, parsed.year, status);
    insertFile.run(library.id, item.id, null, f.path, filename, f.size, f.mtime, fingerprint, JSON.stringify(parsed));
    return item.status === "matched" ? null : item.id;
  }

  private findOrCreateItem(
    libraryId: number,
    type: "movie" | "show",
    title: string,
    year: number | null,
    status: string
  ): { id: number; status: string } {
    const norm = normalizeTitle(title);
    const candidates = this.db
      .prepare("SELECT id, title, year, status FROM media_items WHERE library_id = ? AND type = ?")
      .all(libraryId, type) as { id: number; title: string; year: number | null; status: string }[];
    for (const c of candidates) {
      if (normalizeTitle(c.title) === norm && (type === "show" || c.year === year || !year || !c.year)) {
        return { id: c.id, status: c.status };
      }
    }
    const info = this.db
      .prepare(
        "INSERT INTO media_items (library_id, type, title, sort_title, year, status) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(libraryId, type, title, sortTitle(title), year, status);
    return { id: Number(info.lastInsertRowid), status };
  }

  // ------------------------------------------------------------------ metadata

  /**
   * Fetch + cache metadata for one item. Without `force`, uses the stored
   * provider/id (refresh) or auto-matches across providers (first fetch).
   */
  async fetchMetadataForItem(
    itemId: number,
    force?: { provider: MetaProvider; providerId: number }
  ): Promise<void> {
    const item = this.db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId) as any;
    if (!item) return;

    let provider = (force?.provider ?? item.provider ?? "tmdb") as MetaProvider;
    let providerId: number | null = force?.providerId ?? item.provider_id ?? item.tmdb_id;
    if (!providerId) {
      const match = await this.autoMatch(item);
      if (!match) {
        this.db.prepare("UPDATE media_items SET status = 'needs_match' WHERE id = ?").run(itemId);
        events.broadcast("item-changed", { itemId });
        return;
      }
      provider = match.provider;
      providerId = match.providerId;
    }

    if (provider === "tvmaze" && item.type === "movie") {
      throw new Error("TVmaze only covers TV shows — pick TMDB or AniList for movies");
    }
    if (provider === "tmdb") {
      if (item.type === "movie") await this.applyTmdbMovie(itemId, providerId);
      else await this.applyTmdbShow(itemId, providerId);
    } else if (provider === "tvmaze") {
      await this.applyTvmazeShow(itemId, providerId);
    } else {
      await this.applyAnilist(itemId, providerId, item.type);
    }
    await this.fillMissingArtwork(itemId).catch(() => {});
    events.broadcast("item-changed", { itemId });
  }

  /**
   * Artwork fallback: metadata can succeed while the provider's image CDN is
   * unreachable (regional blocking / flaky VPN routing — image.tmdb.org is the
   * usual victim). Pull the poster from TVmaze or AniList instead, whose CDNs
   * are independently hosted.
   */
  private async fillMissingArtwork(itemId: number) {
    const item = this.db
      .prepare("SELECT id, type, title, year, imdb_id, poster, backdrop, status FROM media_items WHERE id = ?")
      .get(itemId) as any;
    if (!item || item.status !== "matched" || item.poster) return;

    let poster: string | null = null;
    let backdrop: string | null = null;
    if (item.type === "show") {
      try {
        // Prefer an exact IMDb lookup when TMDB gave us the id.
        const show = item.imdb_id
          ? await this.tvmaze.lookupByImdb(item.imdb_id)
          : await this.tvmaze.findBestMatch(item.title, item.year).then((m) => (m ? this.tvmaze.showDetails(m.providerId) : null));
        if (show) {
          poster = await cacheImageFromUrl(this.imagesDir, show.image?.original ?? show.image?.medium, "poster");
        }
      } catch {
        /* fall through to AniList */
      }
    }
    if (!poster) {
      try {
        const anime = await this.anilist.findBestMatch(item.title, item.year, item.type === "movie");
        if (anime) {
          const d = await this.anilist.details(anime.providerId);
          poster = await cacheImageFromUrl(this.imagesDir, d.coverImage?.extraLarge ?? d.coverImage?.large, "poster");
          if (!item.backdrop) backdrop = await cacheImageFromUrl(this.imagesDir, d.bannerImage, "backdrop");
        }
      } catch {
        /* no fallback available */
      }
    }
    if (poster) {
      this.db
        .prepare("UPDATE media_items SET poster = ?, backdrop = COALESCE(?, backdrop) WHERE id = ?")
        .run(poster, backdrop, itemId);
      console.log(`artwork fallback used for "${item.title}"`);
    }
  }

  /** Provider chain: TMDB (if key works) -> TVmaze (shows) -> AniList (anime). */
  private async autoMatch(item: any): Promise<{ provider: MetaProvider; providerId: number } | null> {
    const searchType = item.type === "movie" ? "movie" : "tv";
    if (this.tmdb.hasKey() && !this.tmdbAuthFailed) {
      try {
        const best = await this.tmdb.findBestMatch(item.title, searchType, item.year);
        if (best) return { provider: "tmdb", providerId: best.tmdbId };
      } catch (e) {
        if (e instanceof TmdbError && e.status === 401) {
          this.tmdbAuthFailed = true;
          console.error("TMDB rejected the API key (401) — using TVmaze/AniList fallbacks for this scan");
        } else {
          console.error("TMDB match failed:", e);
        }
      }
    }
    if (item.type === "show") {
      const tm = await this.tvmaze.findBestMatch(item.title, item.year).catch(() => null);
      if (tm) return { provider: "tvmaze", providerId: tm.providerId };
    }
    const al = await this.anilist
      .findBestMatch(item.title, item.year, item.type === "movie")
      .catch(() => null);
    if (al) return { provider: "anilist", providerId: al.providerId };
    return null;
  }

  /** One UPDATE shared by every provider so column order can't drift. */
  private writeItemMeta(itemId: number, m: {
    title: string; year: number | null; provider: MetaProvider; providerId: number;
    tmdbId: number | null; imdbId: string | null; overview: string | null; tagline: string | null;
    poster: string | null; backdrop: string | null; genres: string[];
    cast: { name: string; character: string }[]; crew: { name: string; job: string }[];
    rating: number | null; runtime: number | null;
  }) {
    this.db
      .prepare(
        `UPDATE media_items SET title=?, sort_title=?, year=?, provider=?, provider_id=?, tmdb_id=?, imdb_id=?,
         overview=?, tagline=?, poster=?, backdrop=?, genres=?, cast_json=?, crew_json=?, rating=?, runtime=?,
         status='matched' WHERE id=?`
      )
      .run(
        m.title, sortTitle(m.title), m.year, m.provider, m.providerId, m.tmdbId, m.imdbId,
        m.overview, m.tagline, m.poster, m.backdrop, JSON.stringify(m.genres),
        JSON.stringify(m.cast), JSON.stringify(m.crew), m.rating, m.runtime, itemId
      );
  }

  /** Matched items referencing image files that no longer exist on disk. */
  private itemsWithMissingArtwork(libraryId: number): number[] {
    const exists = (rel: string | null) => !rel || fs.existsSync(path.join(this.imagesDir, rel));
    const out: number[] = [];
    const items = this.db
      .prepare("SELECT id, poster, backdrop FROM media_items WHERE library_id = ? AND status = 'matched'")
      .all(libraryId) as { id: number; poster: string | null; backdrop: string | null }[];
    for (const it of items) {
      // A matched item with no poster at all usually means the image download
      // failed at match time — retry it too, not just deleted files.
      if (!it.poster || !exists(it.poster) || !exists(it.backdrop)) {
        out.push(it.id);
        continue;
      }
      const brokenExtra = this.db
        .prepare(
          `SELECT (SELECT count(*) FROM episodes e WHERE e.show_id = ? AND e.still IS NOT NULL) AS stills,
                  (SELECT count(*) FROM seasons s WHERE s.show_id = ? AND s.poster IS NOT NULL) AS posters`
        )
        .get(it.id, it.id) as { stills: number; posters: number };
      if (brokenExtra.stills + brokenExtra.posters === 0) continue;
      const eps = this.db
        .prepare("SELECT still FROM episodes WHERE show_id = ? AND still IS NOT NULL")
        .all(it.id) as { still: string }[];
      const seasons = this.db
        .prepare("SELECT poster FROM seasons WHERE show_id = ? AND poster IS NOT NULL")
        .all(it.id) as { poster: string }[];
      if (eps.some((e) => !exists(e.still)) || seasons.some((s) => !exists(s.poster))) out.push(it.id);
    }
    return out;
  }

  private ourSeasons(showId: number): number[] {
    return (this.db
      .prepare("SELECT DISTINCT season FROM episodes WHERE show_id = ? ORDER BY season")
      .all(showId) as { season: number }[]).map((s) => s.season);
  }

  private ourEpisodes(showId: number): { id: number; season: number; episode: number }[] {
    return this.db
      .prepare("SELECT id, season, episode FROM episodes WHERE show_id = ?")
      .all(showId) as any[];
  }

  private upsertSeason(showId: number, season: number, name: string | null, poster: string | null, overview: string | null) {
    this.db
      .prepare(
        `INSERT INTO seasons (show_id, season, name, poster, overview) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(show_id, season) DO UPDATE SET name=excluded.name, poster=excluded.poster, overview=excluded.overview`
      )
      .run(showId, season, name, poster, overview);
  }

  private updateEpisodeMeta(
    epId: number,
    m: { title: string | null; overview: string | null; airDate: string | null; still: string | null; runtime: number | null; providerEpisodeId: number | null }
  ) {
    this.db
      .prepare("UPDATE episodes SET title=?, overview=?, air_date=?, still=?, runtime=?, tmdb_id=? WHERE id=?")
      .run(m.title, m.overview, m.airDate, m.still, m.runtime, m.providerEpisodeId, epId);
  }

  // ---- TMDB ------------------------------------------------------------------

  private async applyTmdbMovie(itemId: number, tmdbId: number) {
    const d = await this.tmdb.movieDetails(tmdbId);
    this.writeItemMeta(itemId, {
      title: d.title, year: yearOfDate(d.release_date), provider: "tmdb", providerId: d.id,
      tmdbId: d.id, imdbId: d.external_ids?.imdb_id ?? d.imdb_id ?? null,
      overview: d.overview ?? null, tagline: d.tagline || null,
      poster: await this.tmdb.cacheImage(d.poster_path, "poster"),
      backdrop: await this.tmdb.cacheImage(d.backdrop_path, "backdrop"),
      genres: (d.genres ?? []).map((g: any) => g.name),
      cast: (d.credits?.cast ?? []).slice(0, 15).map((c: any) => ({ id: c.id, name: c.name, character: c.character ?? "" })),
      crew: pickCrew(d.credits?.crew),
      rating: d.vote_average ?? null, runtime: d.runtime ?? null,
    });
    this.db
      .prepare("UPDATE media_items SET collection_id = ?, collection_name = ? WHERE id = ?")
      .run(d.belongs_to_collection?.id ?? null, d.belongs_to_collection?.name ?? null, itemId);
    await this.cacheRecommendations(itemId, "movie", d.id);
  }

  /** Fetch + store TMDB recommendation ids ("More Like This" is filtered to owned titles at read time). */
  private async cacheRecommendations(itemId: number, type: "movie" | "tv", tmdbId: number) {
    try {
      const ids = await this.tmdb.recommendationIds(type, tmdbId);
      this.db.prepare("UPDATE media_items SET recs_json = ? WHERE id = ?").run(JSON.stringify(ids), itemId);
    } catch {
      /* non-fatal — row simply stays empty */
    }
  }

  private async applyTmdbShow(itemId: number, tmdbId: number) {
    const d = await this.tmdb.tvDetails(tmdbId);
    this.writeItemMeta(itemId, {
      title: d.name, year: yearOfDate(d.first_air_date), provider: "tmdb", providerId: d.id,
      tmdbId: d.id, imdbId: d.external_ids?.imdb_id ?? null,
      overview: d.overview ?? null, tagline: d.tagline || null,
      poster: await this.tmdb.cacheImage(d.poster_path, "poster"),
      backdrop: await this.tmdb.cacheImage(d.backdrop_path, "backdrop"),
      genres: (d.genres ?? []).map((g: any) => g.name),
      cast: (d.credits?.cast ?? []).slice(0, 15).map((c: any) => ({ id: c.id, name: c.name, character: c.character ?? "" })),
      crew: pickCrew(d.credits?.crew),
      rating: d.vote_average ?? null, runtime: d.episode_run_time?.[0] ?? null,
    });
    await this.cacheRecommendations(itemId, "tv", d.id);

    for (const season of this.ourSeasons(itemId)) {
      try {
        const sd = await this.tmdb.tvSeason(tmdbId, season);
        this.upsertSeason(
          itemId, season, sd.name ?? null,
          await this.tmdb.cacheImage(sd.poster_path, "season"),
          sd.overview || null
        );
        const byNum = new Map<number, any>((sd.episodes ?? []).map((e: any) => [e.episode_number, e]));
        for (const ep of this.ourEpisodes(itemId).filter((e) => e.season === season)) {
          const te = byNum.get(ep.episode);
          if (!te) continue;
          this.updateEpisodeMeta(ep.id, {
            title: te.name ?? null, overview: te.overview || null, airDate: te.air_date ?? null,
            still: await this.tmdb.cacheImage(te.still_path, "still"),
            runtime: te.runtime ?? null, providerEpisodeId: te.id ?? null,
          });
        }
      } catch (e) {
        console.error(`TMDB season ${season} for show ${itemId} failed:`, e);
      }
    }
  }

  // ---- TVmaze ------------------------------------------------------------------

  private async applyTvmazeShow(itemId: number, id: number) {
    const d = await this.tvmaze.showDetails(id);
    const gallery = await this.tvmaze.images(id);
    const bg = gallery.find((g: any) => g.type === "background");
    this.writeItemMeta(itemId, {
      title: d.name, year: yearOfDate(d.premiered), provider: "tvmaze", providerId: id,
      tmdbId: null, imdbId: d.externals?.imdb ?? null,
      overview: stripHtml(d.summary), tagline: null,
      poster: await cacheImageFromUrl(this.imagesDir, d.image?.original ?? d.image?.medium, "poster"),
      backdrop: await cacheImageFromUrl(this.imagesDir, bg?.resolutions?.original?.url, "backdrop"),
      genres: d.genres ?? [],
      cast: (d._embedded?.cast ?? []).slice(0, 15).map((c: any) => ({
        name: c.person?.name ?? "?", character: c.character?.name ?? "",
      })),
      crew: [],
      rating: d.rating?.average ?? null, runtime: d.averageRuntime ?? d.runtime ?? null,
    });

    const tvSeasons = await this.tvmaze.seasons(id).catch(() => [] as any[]);
    for (const season of this.ourSeasons(itemId)) {
      const meta = tvSeasons.find((x: any) => x.number === season);
      this.upsertSeason(
        itemId, season,
        meta?.name || (season === 0 ? "Specials" : `Season ${season}`),
        await cacheImageFromUrl(this.imagesDir, meta?.image?.original ?? meta?.image?.medium, "season"),
        stripHtml(meta?.summary)
      );
    }

    const eps = (d._embedded?.episodes ?? []).filter((e: any) => e.number != null);
    const byKey = new Map<string, any>(eps.map((e: any) => [`${e.season}:${e.number}`, e]));
    for (const ep of this.ourEpisodes(itemId)) {
      const te = byKey.get(`${ep.season}:${ep.episode}`);
      if (!te) continue;
      this.updateEpisodeMeta(ep.id, {
        title: te.name ?? null, overview: stripHtml(te.summary), airDate: te.airdate || null,
        still: await cacheImageFromUrl(this.imagesDir, te.image?.medium ?? te.image?.original, "still"),
        runtime: te.runtime ?? null, providerEpisodeId: te.id ?? null,
      });
    }
  }

  // ---- AniList ------------------------------------------------------------------

  private async applyAnilist(itemId: number, id: number, type: "movie" | "show") {
    const d = await this.anilist.details(id);
    const poster = await cacheImageFromUrl(this.imagesDir, d.coverImage?.extraLarge ?? d.coverImage?.large, "poster");
    this.writeItemMeta(itemId, {
      title: anilistTitle(d), year: d.startDate?.year ?? null, provider: "anilist", providerId: id,
      tmdbId: null, imdbId: null,
      overview: stripHtml(d.description), tagline: null,
      poster,
      backdrop: await cacheImageFromUrl(this.imagesDir, d.bannerImage, "backdrop"),
      genres: d.genres ?? [],
      cast: (d.characters?.edges ?? []).map((e: any) => ({
        name: e.node?.name?.full ?? "?", character: e.role === "MAIN" ? "Main" : "Supporting",
      })),
      crew: [],
      rating: d.averageScore != null ? d.averageScore / 10 : null,
      runtime: d.duration ?? null,
    });
    if (type === "show") {
      // AniList has no per-episode/production-season data; give our seasons the
      // cover as poster so the UI isn't bare. Episode rows keep parsed numbers.
      for (const season of this.ourSeasons(itemId)) {
        this.upsertSeason(itemId, season, season === 0 ? "Specials" : `Season ${season}`, poster, null);
      }
    }
  }
}

// Folders that never contain a user's media but often contain thousands of
// decoy files (node_modules is full of TypeScript ".ts"/".d.ts" files).
const IGNORE_DIRS = new Set([
  "node_modules", "$recycle.bin", "system volume information", "__pycache__",
  "venv", "appdata", "windows", "program files", "program files (x86)", "lost+found",
]);

// Release extras conventions (Plex/Radarr-style): whole folders of bonus
// material shipped alongside movies/episodes. Matched on the exact folder name.
const EXTRA_DIRS = new Set([
  "extras", "extra", "featurettes", "behind the scenes", "deleted scenes",
  "deleted scene", "interviews", "scenes", "shorts", "trailers", "trailer",
  "samples", "sample", "bonus", "bonus disc", "other", "making of",
]);

// Extras keywords in the FILE name. Deliberately conservative — word-bounded
// phrases that essentially never appear in real titles ("sample" is handled
// separately below, and bare "extras" is not here because of the TV show).
const EXTRA_FILE_RE =
  /\b(trailer|featurette|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes?|bloopers?|making[ ._-]of|interviews?|nc(?:op|ed)\d*)\b/i;

/** Real MPEG transport streams start with the 0x47 sync byte (repeating every
 *  188 bytes) — TypeScript source files named *.ts obviously don't. */
function isTransportStream(p: string): boolean {
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(189);
    const n = fs.readSync(fd, buf, 0, 189, 0);
    fs.closeSync(fd);
    if (n < 1 || buf[0] !== 0x47) return false;
    return n < 189 || buf[188] === 0x47;
  } catch {
    return false;
  }
}

function walkVideos(root: string, minSizeBytes = 0): { path: string; size: number; mtime: number }[] {
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // also skips .git, .venv, .cache…
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (IGNORE_DIRS.has(lower) || EXTRA_DIRS.has(lower)) continue;
        walk(full);
      } else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        if (/\bsample\b/i.test(e.name) || EXTRA_FILE_RE.test(e.name)) continue;
        if (e.name.toLowerCase().endsWith(".ts") && !isTransportStream(full)) continue;
        try {
          const st = fs.statSync(full);
          // Movie libraries: bonus clips bundled with releases are often
          // unnamed junk ("Hi Sallys.mkv", 5 MB) — a size floor is the only
          // reliable tell. 0 disables.
          if (minSizeBytes > 0 && st.size < minSizeBytes) continue;
          out.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  walk(root);
  return out;
}

function sortTitle(t: string): string {
  return t.replace(/^(the|a|an)\s+/i, "").toLowerCase();
}

/** Every source folder for a library: the primary path plus any extras. */
export function libraryRoots(db: DB, library: { id: number; path: string }): string[] {
  const extra = db.prepare("SELECT path FROM library_folders WHERE library_id = ?").all(library.id) as { path: string }[];
  return [library.path, ...extra.map((e) => e.path)];
}

/** Which root a file lives under (longest matching prefix), for rel-path parsing. */
function rootFor(roots: string[], filePath: string): string {
  const f = path.resolve(filePath).toLowerCase();
  let best = roots[0];
  let bestLen = -1;
  for (const r of roots) {
    const nr = path.resolve(r).replace(/[\\/]+$/, "").toLowerCase();
    if ((f === nr || f.startsWith(nr + path.sep)) && nr.length > bestLen) {
      best = r;
      bestLen = nr.length;
    }
  }
  return best;
}

/** Filename → a readable title (drop extension, tidy separators). */
function cleanFileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || name;
}

/**
 * Generic recursive file walk sharing the video walker's skip rules (dotfiles,
 * ignore/extra dirs). `accept` decides by lowercased extension.
 */
function walkFiles(root: string, accept: (ext: string) => boolean): { path: string; size: number; mtime: number }[] {
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (IGNORE_DIRS.has(lower)) continue;
        walk(full);
      } else if (e.isFile() && accept(path.extname(e.name).toLowerCase())) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0) out.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  walk(root);
  return out;
}

function pickCrew(crew: any[] | undefined): { id?: number; name: string; job: string }[] {
  if (!crew) return [];
  const wanted = new Set(["Director", "Writer", "Screenplay", "Creator", "Executive Producer"]);
  return crew.filter((c) => wanted.has(c.job)).slice(0, 8).map((c) => ({ id: c.id, name: c.name, job: c.job }));
}
