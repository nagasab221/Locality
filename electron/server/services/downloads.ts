// Pull a movie or a show's episodes from ANOTHER Locality server onto this
// machine, so they play locally and offline.
//
// The downloaded media is registered as ordinary rows in a hidden "internal"
// library, which means playback, transcoding, subtitles, resume and markers all
// go through the exact same pipeline as scanned files — nothing in the player or
// stream routes needs to know a file was downloaded. These tables track only the
// transfer itself. Everything is fetched over the same authed endpoints the
// Android app uses: /api/export (manifest), /api/stream (bytes), /api/images and
// /api/subtitles.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import type { DB } from "../db";
import { appFetch } from "./http";
import { cacheImageFromUrl } from "./images";
import { events } from "./events";

interface EnqueueOpts {
  serverUrl: string; // origin of the remote server, e.g. http://192.168.1.20:3777
  token: string;
  itemId: number; // the item id ON THE REMOTE server
  season?: number | null; // a single season, or null for movie / whole show
  sourceName?: string;
}

const PROGRESS_EMIT_MS = 500;

/** Windows-safe file/dir name. */
function safe(name: string): string {
  return (name || "file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.+$/, "").slice(0, 150) || "file";
}

export class DownloadManager {
  private running = false;

  constructor(
    private db: DB,
    private imagesDir: string,
    private downloadsDir: string,
    private subsCacheDir: string
  ) {}

  // ---- internal library ------------------------------------------------------

  private internalLibraryId(): number {
    const row = this.db.prepare("SELECT id FROM libraries WHERE internal = 1 LIMIT 1").get() as { id: number } | undefined;
    if (row) return row.id;
    const info = this.db
      .prepare("INSERT INTO libraries (name, type, path, internal) VALUES ('Downloads', 'tv', ?, 1)")
      .run(this.downloadsDir);
    return Number(info.lastInsertRowid);
  }

  // ---- remote helpers --------------------------------------------------------

  private withToken(url: string, token: string): string {
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  private async getJson(url: string, token: string): Promise<any> {
    const res = await appFetch(this.withToken(url, token), { headers: { "X-Locality-Token": token } });
    if (!res.ok) throw new Error(`Remote server responded ${res.status}`);
    return res.json();
  }

  // ---- enqueue ---------------------------------------------------------------

  /**
   * Read the remote manifest, mirror its items/episodes into the internal
   * library as `missing` rows, and start transferring. Returns the local job id.
   */
  async enqueue(opts: EnqueueOpts): Promise<{ downloadId: number; mediaItemId: number }> {
    const base = opts.serverUrl.replace(/\/+$/, "");
    const manifestUrl =
      `${base}/api/export/items/${opts.itemId}` + (opts.season != null ? `?season=${opts.season}` : "");
    const m = await this.getJson(manifestUrl, opts.token);
    const item = m.item;
    if (!item) throw new Error("The remote server returned no item");

    // Artwork first (async), so the internal rows can point at local copies that
    // survive going offline. Keyed by source+path so re-downloads dedupe.
    const key = (rel: string) => `dl:${opts.sourceName ?? base}:${rel}`;
    const img = async (rel: string | null | undefined, kind: "poster" | "backdrop" | "still") =>
      rel ? cacheImageFromUrl(this.imagesDir, this.withToken(`${base}/api/images/${rel}`, opts.token), kind, key(rel)) : null;

    const poster = await img(item.poster, "poster");
    const backdrop = await img(item.backdrop, "backdrop");

    const libId = this.internalLibraryId();
    const dlDir = path.join(this.downloadsDir, String(Date.now()) + "-" + safe(item.title));
    fs.mkdirSync(dlDir, { recursive: true });

    // Gather the episode stills up front (async) before the sync insert.
    const stills = new Map<number, string | null>();
    if (item.type === "show") {
      for (const ep of m.episodes ?? []) stills.set(ep.id, await img(ep.still, "still"));
    }

    type Planned = { fileId: number; streamUrl: string; subs: any[]; absPath: string; size: number };
    const planned: Planned[] = [];
    let mediaItemId = 0;
    let downloadId = 0;

    const tx = this.db.transaction(() => {
      const mi = this.db
        .prepare(
          `INSERT INTO media_items (library_id, type, title, sort_title, year, overview, poster, backdrop, genres, status, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', 'download')`
        )
        .run(libId, item.type, item.title, (item.title || "").toLowerCase(), item.year ?? null, item.overview ?? null, poster, backdrop, JSON.stringify(item.genres ?? []));
      mediaItemId = Number(mi.lastInsertRowid);

      const addFile = (f: any, epId: number | null, relName: string): Planned => {
        const absPath = path.join(dlDir, safe(relName));
        const info = this.db
          .prepare(
            `INSERT INTO files (library_id, media_item_id, episode_id, path, filename, size, mtime, fingerprint, missing)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`
          )
          .run(libId, epId ? null : mediaItemId, epId, absPath, f.filename, f.size ?? 0, f.fingerprint ?? "");
        return { fileId: Number(info.lastInsertRowid), streamUrl: `${base}${f.streamPath}`, subs: f.subtitles ?? [], absPath, size: f.size ?? 0 };
      };

      if (item.type === "movie") {
        for (const f of m.files ?? []) planned.push(addFile(f, null, f.filename));
      } else {
        for (const ep of m.episodes ?? []) {
          this.db
            .prepare("INSERT OR IGNORE INTO seasons (show_id, season) VALUES (?, ?)")
            .run(mediaItemId, ep.season);
          const epInfo = this.db
            .prepare(
              `INSERT INTO episodes (show_id, season, episode, title, overview, air_date, still, runtime, intro_start, intro_end, credits_start, markers_done)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
            )
            .run(
              mediaItemId, ep.season, ep.episode, ep.title ?? null, ep.overview ?? null, ep.airDate ?? null,
              stills.get(ep.id) ?? null, ep.runtime ?? null,
              ep.markers?.introStart ?? null, ep.markers?.introEnd ?? null, ep.markers?.creditsStart ?? null
            );
          if (ep.file) {
            const label = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} - ${safe(ep.title || ep.file.filename)}`;
            planned.push(addFile(ep.file, Number(epInfo.lastInsertRowid), label + path.extname(ep.file.filename)));
          }
        }
      }

      const total = planned.reduce((n, p) => n + (p.size || 0), 0);
      const job = this.db
        .prepare("INSERT INTO downloads (media_item_id, source_name, status, total_bytes, created_at) VALUES (?, ?, 'downloading', ?, ?)")
        .run(mediaItemId, opts.sourceName ?? base, total, new Date().toISOString());
      downloadId = Number(job.lastInsertRowid);

      for (const p of planned) {
        this.db
          .prepare(
            "INSERT INTO download_files (download_id, file_id, remote_stream_url, subs_json, abs_path, size) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(downloadId, p.fileId, this.withToken(p.streamUrl, opts.token), JSON.stringify(p.subs.map((s: any) => ({ ...s, url: this.withToken(`${base}${s.vttPath}`, opts.token) }))), p.absPath, p.size);
      }
    });
    tx();

    this.emit(downloadId);
    void this.run();
    return { downloadId, mediaItemId };
  }

  // ---- worker ----------------------------------------------------------------

  /** Sequential transfer of every pending file across all unfinished jobs. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const row = this.db
          .prepare("SELECT * FROM download_files WHERE status = 'pending' ORDER BY id LIMIT 1")
          .get() as any;
        if (!row) break;
        await this.transfer(row);
      }
    } finally {
      this.running = false;
    }
  }

  private async transfer(row: any): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(row.abs_path), { recursive: true });
      const res = await appFetch(row.remote_stream_url);
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const total = Number(res.headers.get("content-length")) || row.size || 0;

      const tmp = row.abs_path + ".part";
      const out = fs.createWriteStream(tmp);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let got = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once("drain", () => r()));
        got += value.length;
        if (Date.now() - lastEmit > PROGRESS_EMIT_MS) {
          lastEmit = Date.now();
          this.db.prepare("UPDATE download_files SET bytes = ? WHERE id = ?").run(got, row.id);
          this.recomputeJob(row.download_id);
          this.emit(row.download_id);
        }
      }
      await new Promise<void>((resolve) => out.end(() => resolve()));
      fs.renameSync(tmp, row.abs_path);

      // The bytes are down: flip the catalog file live and pull its subtitles.
      const stat = fs.statSync(row.abs_path);
      this.db
        .prepare("UPDATE files SET missing = 0, size = ?, mtime = ? WHERE id = ?")
        .run(stat.size, Math.floor(stat.mtimeMs), row.file_id);
      await this.fetchSubs(row);
      this.db.prepare("UPDATE download_files SET status = 'done', bytes = ?, size = ? WHERE id = ?").run(stat.size, stat.size, row.id);
    } catch (e: any) {
      console.error("download transfer failed:", e?.message ?? e);
      this.db.prepare("UPDATE download_files SET status = 'error' WHERE id = ?").run(row.id);
      this.db.prepare("UPDATE downloads SET error = ? WHERE id = ?").run(String(e?.message ?? e), row.download_id);
    }
    this.recomputeJob(row.download_id);
    this.emit(row.download_id);
  }

  private async fetchSubs(row: any): Promise<void> {
    const subs = JSON.parse(row.subs_json || "[]") as any[];
    for (const s of subs) {
      try {
        const res = await appFetch(s.url);
        if (!res.ok) continue;
        const text = await res.text();
        if (/^\s*<(?:!doctype|html)/i.test(text)) continue; // an error page, not a cue file
        const name = `dl_${row.file_id}_${safe(s.lang || s.label || "sub")}_${crypto.randomBytes(3).toString("hex")}.vtt`;
        const abs = path.join(this.subsCacheDir, name);
        fs.writeFileSync(abs, text, "utf-8");
        this.db
          .prepare("INSERT OR IGNORE INTO subtitles (file_id, path, lang, source, label) VALUES (?, ?, ?, 'local', ?)")
          .run(row.file_id, abs, s.lang ?? null, s.label ?? "Subtitle");
      } catch {
        /* a missing subtitle shouldn't fail the whole download */
      }
    }
  }

  private recomputeJob(jobId: number) {
    const files = this.db.prepare("SELECT status, bytes, size FROM download_files WHERE download_id = ?").all(jobId) as any[];
    if (files.length === 0) return;
    const done = files.every((f) => f.status === "done");
    const errored = files.some((f) => f.status === "error");
    const doneBytes = files.reduce((n, f) => n + (f.status === "done" ? f.size : f.bytes), 0);
    const status = done ? "complete" : errored && files.every((f) => f.status !== "pending") ? "error" : "downloading";
    this.db.prepare("UPDATE downloads SET status = ?, done_bytes = ? WHERE id = ?").run(status, doneBytes, jobId);
  }

  private emit(jobId: number) {
    const job = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(jobId);
    if (job) events.broadcast("download", job);
  }

  // ---- listing / removal -----------------------------------------------------

  list(): any[] {
    return this.db
      .prepare(
        `SELECT d.*, mi.title, mi.type, mi.year, mi.poster
           FROM downloads d LEFT JOIN media_items mi ON mi.id = d.media_item_id
          ORDER BY d.created_at DESC`
      )
      .all()
      .map((d: any) => ({
        id: d.id,
        title: d.title ?? "Download",
        type: d.type ?? "movie",
        year: d.year,
        poster: d.poster,
        mediaItemId: d.media_item_id,
        sourceName: d.source_name,
        status: d.status,
        totalBytes: d.total_bytes,
        doneBytes: d.done_bytes,
        error: d.error,
        percent: d.total_bytes > 0 ? Math.min(100, Math.round((d.done_bytes / d.total_bytes) * 100)) : d.status === "complete" ? 100 : 0,
      }));
  }

  /** Delete a download: its files on disk, and its catalog + tracking rows. */
  remove(id: number) {
    const job = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as any;
    if (!job) return;
    const files = this.db.prepare("SELECT abs_path FROM download_files WHERE download_id = ?").all(id) as any[];
    const dirs = new Set<string>();
    for (const f of files) {
      try {
        fs.rmSync(f.abs_path, { force: true });
        fs.rmSync(f.abs_path + ".part", { force: true });
        dirs.add(path.dirname(f.abs_path));
      } catch {
        /* best effort */
      }
    }
    for (const d of dirs) {
      try {
        fs.rmdirSync(d);
      } catch {
        /* non-empty or gone */
      }
    }
    // media_items cascade removes files/episodes/seasons; downloads cascade removes download_files.
    if (job.media_item_id) this.db.prepare("DELETE FROM media_items WHERE id = ?").run(job.media_item_id);
    this.db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
  }

  /** On startup, resume any transfer interrupted by a quit. */
  resume() {
    const pending = this.db.prepare("SELECT COUNT(*) c FROM download_files WHERE status = 'pending'").get() as { c: number };
    if (pending.c > 0) void this.run();
  }
}
