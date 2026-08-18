// Optional background scanning: watch library roots with chokidar and run an
// incremental scan (debounced) when video files appear/disappear.
import chokidar, { FSWatcher } from "chokidar";
import path from "path";
import type { DB } from "../db";
import { getSetting } from "../db";
import type { Library } from "../types";
import { Scanner, VIDEO_EXTS, libraryRoots } from "./scanner";

export class LibraryWatcher {
  private watchers = new Map<number, FSWatcher>();
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private db: DB, private scanner: Scanner) {}

  /** Reconcile watchers with the current libraries + backgroundScan setting. */
  refresh() {
    const enabled = getSetting(this.db, "backgroundScan") === "1";
    // The internal Downloads library has no watchable source folder.
    const libraries = this.db.prepare("SELECT * FROM libraries WHERE internal = 0").all() as Library[];
    const wanted = new Set(enabled ? libraries.map((l) => l.id) : []);

    for (const [id, w] of this.watchers) {
      if (!wanted.has(id)) {
        w.close();
        this.watchers.delete(id);
      }
    }
    if (!enabled) return;

    for (const lib of libraries) {
      if (this.watchers.has(lib.id)) continue;
      const watcher = chokidar.watch(libraryRoots(this.db, lib), {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
        depth: 8,
      });
      const onFsEvent = (p: string) => {
        if (!VIDEO_EXTS.has(path.extname(p).toLowerCase())) return;
        this.scheduleScan(lib);
      };
      watcher.on("add", onFsEvent);
      watcher.on("unlink", onFsEvent);
      watcher.on("error", () => {});
      this.watchers.set(lib.id, watcher);
    }
  }

  private scheduleScan(lib: Library) {
    const existing = this.timers.get(lib.id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      lib.id,
      setTimeout(() => {
        this.timers.delete(lib.id);
        const fresh = this.db.prepare("SELECT * FROM libraries WHERE id = ?").get(lib.id) as Library | undefined;
        if (fresh) void this.scanner.scanLibrary(fresh);
      }, 5000)
    );
  }

  stop() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
