// The portable watch-progress ledger: Documents/Locality/locality.json.
//
// SQLite (watch_progress table) is the runtime store; this file is the
// travel copy. Rules:
//  - keyed by media fingerprint (filename+size), never absolute paths
//  - merge entry-by-entry by last_updated (newest wins) — NEVER blind-overwrite
//  - every write first re-reads the file and merges, so an externally pasted
//    copy can never be clobbered even in a race
//  - chokidar watches the file so pasting a copy mid-session is picked up live
import fs from "fs";
import path from "path";
import chokidar, { FSWatcher } from "chokidar";
import type { DB } from "../db";
import type { ProgressEntry, ProgressLedgerData } from "../types";
import { events } from "./events";

const WATCHED_THRESHOLD = 0.9;

export class ProgressLedger {
  private filePath: string;
  private watcher: FSWatcher | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  /** Content hash of what we last wrote, to tell our writes from external ones. */
  private lastWrittenContent = "";
  private upsertStmt;

  constructor(private db: DB, documentsDir: string) {
    const dir = path.join(documentsDir, "Locality");
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "locality.json");
    this.upsertStmt = db.prepare(`
      INSERT INTO watch_progress (fingerprint, filename, size_bytes, duration_seconds, position_seconds, watched, last_updated)
      VALUES (@fingerprint, @filename, @size_bytes, @duration_seconds, @position_seconds, @watched, @last_updated)
      ON CONFLICT(fingerprint) DO UPDATE SET
        filename = excluded.filename,
        size_bytes = excluded.size_bytes,
        duration_seconds = excluded.duration_seconds,
        position_seconds = excluded.position_seconds,
        watched = excluded.watched,
        last_updated = excluded.last_updated
    `);
  }

  get ledgerPath() {
    return this.filePath;
  }

  /** Fired after any local progress change — drives the cloud push (if signed in). */
  onLocalChange: (() => void) | null = null;

  /** Every entry keyed by fingerprint (the cloud push reads this). */
  allEntries(): ProgressLedgerData {
    const rows = this.db.prepare("SELECT * FROM watch_progress ORDER BY fingerprint").all() as any[];
    const out: ProgressLedgerData = {};
    for (const r of rows) {
      out[r.fingerprint] = {
        filename: r.filename,
        size_bytes: r.size_bytes,
        duration_seconds: r.duration_seconds,
        position_seconds: r.position_seconds,
        watched: !!r.watched,
        last_updated: r.last_updated,
      };
    }
    return out;
  }

  /** Startup: merge any on-disk changes (e.g. file copied in while app was closed), then start watching. */
  start() {
    this.mergeFromDisk("startup");
    // Write once so a fresh install materializes the file immediately.
    if (!fs.existsSync(this.filePath)) this.flush();
    this.watcher = chokidar.watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    this.watcher.on("change", () => this.onExternalChange());
    this.watcher.on("add", () => this.onExternalChange());
  }

  stop() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.flush();
    }
    this.watcher?.close();
  }

  private onExternalChange() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return;
    }
    if (raw === this.lastWrittenContent) return; // our own write echoing back
    const changed = this.mergeFromDisk("external");
    if (changed > 0) {
      events.broadcast("ledger-merged", { changed });
    }
    // Re-write the union so the on-disk file also gains our newer entries.
    this.scheduleWrite();
  }

  /** Read locality.json and fold newer entries into SQLite. Returns #changed. */
  private mergeFromDisk(reason: string): number {
    const data = this.readDisk();
    if (!data) return 0;
    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const [fp, entry] of Object.entries(data)) {
        if (!fp.startsWith("fp_") || typeof entry !== "object" || entry === null) continue;
        const existing = this.get(fp);
        const incoming = sanitize(entry);
        if (!incoming) continue;
        if (!existing || Date.parse(incoming.last_updated) > Date.parse(existing.last_updated)) {
          this.upsertStmt.run({ fingerprint: fp, ...incoming, watched: incoming.watched ? 1 : 0 });
          changed++;
        }
      }
    });
    try {
      tx();
    } catch (e) {
      console.error(`ledger merge (${reason}) failed:`, e);
      return 0;
    }
    return changed;
  }

  private readDisk(): ProgressLedgerData | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      // Strip a UTF-8 BOM — Notepad and PowerShell like to add one.
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8").replace(/^﻿/, ""));
    } catch (e) {
      console.error("locality.json unreadable, skipping merge:", e);
      return null;
    }
  }

  /** Merge entries recorded elsewhere (offline progress from a phone) — same
   *  newest-wins rules as the disk merge. Returns #changed. */
  mergeEntries(list: Array<{ fingerprint?: unknown } & Record<string, unknown>>): number {
    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const raw of list) {
        const fp = typeof raw?.fingerprint === "string" ? raw.fingerprint : "";
        if (!fp.startsWith("fp_")) continue;
        const incoming = sanitize(raw);
        if (!incoming) continue;
        const existing = this.get(fp);
        if (!existing || Date.parse(incoming.last_updated) > Date.parse(existing.last_updated)) {
          this.upsertStmt.run({ fingerprint: fp, ...incoming, watched: incoming.watched ? 1 : 0 });
          changed++;
        }
      }
    });
    try {
      tx();
    } catch (e) {
      console.error("ledger merge (client batch) failed:", e);
      return 0;
    }
    if (changed > 0) this.scheduleWrite();
    return changed;
  }

  get(fingerprint: string): ProgressEntry | null {
    const row = this.db
      .prepare("SELECT * FROM watch_progress WHERE fingerprint = ?")
      .get(fingerprint) as any;
    if (!row) return null;
    return {
      filename: row.filename,
      size_bytes: row.size_bytes,
      duration_seconds: row.duration_seconds,
      position_seconds: row.position_seconds,
      watched: !!row.watched,
      last_updated: row.last_updated,
    };
  }

  /** Record playback progress; marks watched when position passes ~90% of duration. */
  update(
    fingerprint: string,
    filename: string,
    sizeBytes: number,
    positionSeconds: number,
    durationSeconds: number,
    opts: { watched?: boolean } = {}
  ) {
    const existing = this.get(fingerprint);
    let watched = opts.watched ?? existing?.watched ?? false;
    if (opts.watched === undefined && durationSeconds > 0 && positionSeconds / durationSeconds >= WATCHED_THRESHOLD) {
      watched = true;
    }
    this.upsertStmt.run({
      fingerprint,
      filename,
      size_bytes: sizeBytes,
      duration_seconds: Math.round(durationSeconds),
      position_seconds: Math.round(positionSeconds),
      watched: watched ? 1 : 0,
      last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    this.scheduleWrite();
  }

  setWatched(fingerprint: string, filename: string, sizeBytes: number, watched: boolean) {
    const existing = this.get(fingerprint);
    this.upsertStmt.run({
      fingerprint,
      filename,
      size_bytes: sizeBytes,
      duration_seconds: existing?.duration_seconds ?? 0,
      position_seconds: watched ? existing?.position_seconds ?? 0 : 0,
      watched: watched ? 1 : 0,
      last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    this.scheduleWrite();
  }

  /** Debounced write — playback progress ticks every few seconds. */
  private scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
      try {
        this.onLocalChange?.();
      } catch (e) {
        console.error("cloud push hook failed:", e);
      }
    }, 1500);
  }

  /** Merge disk (in case it changed since last read) then atomically write the union. */
  flush() {
    this.mergeFromDisk("pre-write");
    const rows = this.db.prepare("SELECT * FROM watch_progress ORDER BY fingerprint").all() as any[];
    const out: ProgressLedgerData = {};
    for (const r of rows) {
      out[r.fingerprint] = {
        filename: r.filename,
        size_bytes: r.size_bytes,
        duration_seconds: r.duration_seconds,
        position_seconds: r.position_seconds,
        watched: !!r.watched,
        last_updated: r.last_updated,
      };
    }
    const content = JSON.stringify(out, null, 2) + "\n";
    if (content === this.lastWrittenContent && fs.existsSync(this.filePath)) return;
    try {
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, this.filePath);
      this.lastWrittenContent = content;
    } catch (e) {
      console.error("Failed writing locality.json:", e);
    }
  }
}

function sanitize(e: any): ProgressEntry | null {
  if (typeof e.filename !== "string" || typeof e.last_updated !== "string") return null;
  if (Number.isNaN(Date.parse(e.last_updated))) return null;
  return {
    filename: e.filename,
    size_bytes: Number(e.size_bytes) || 0,
    duration_seconds: Number(e.duration_seconds) || 0,
    position_seconds: Number(e.position_seconds) || 0,
    watched: !!e.watched,
    last_updated: e.last_updated,
  };
}
