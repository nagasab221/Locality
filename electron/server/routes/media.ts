// Library / media / metadata / settings routes.
import { Router } from "express";
import type { Request } from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Ctx } from "../context";
import type { Collection, Episode, Library, MediaFile, MediaItem, PersonRow, ProgressEntry, Season } from "../types";
import { getSetting, setSetting } from "../db";
import { TmdbError } from "../services/tmdb";
import { appFetch } from "../services/http";
import { cacheImageFromUrl } from "../services/images";
import { isLocalRequest, itemVisibleTo, libraryShared } from "../services/requestOrigin";
import { getHwAccelConfig, resetHwAccelCache } from "../services/hwaccel";

const LIBRARY_TYPES = new Set(["movies", "tv", "gallery", "other"]);

const SETTING_KEYS = [
  "tmdbApiKey", "tmdbProxyUrl", "osApiKey", "osUsername", "osPassword",
  "defaultSubLang", "backgroundScan",
  "lanEnabled", "lanPort", "lanToken", "remoteEnabled",
  "autoplayNext", "upNextSeconds", "skipIntro",
  "minMovieSizeMB", "startWithWindows", "theme",
  "supabaseUrl", "supabaseAnonKey", "hwaccel", "playbackEngine",
] as const;

export function mediaRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, scanner, ledger } = ctx;

  const getLibrary = (id: number) =>
    db.prepare("SELECT * FROM libraries WHERE id = ?").get(id) as Library | undefined;

  // ---- state / settings ----------------------------------------------------

  r.get("/state", (req, res) => {
    const libraries = db.prepare("SELECT * FROM libraries WHERE internal = 0 ORDER BY COALESCE(position, 999999999), name").all() as Library[];
    const settings: Record<string, string> = {};
    for (const k of SETTING_KEYS) settings[k] = getSetting(db, k) ?? "";
    // Don't hand API keys / credentials to remote clients even though they are
    // authenticated — they only need the library listing. isLocalRequest, not a
    // bare socket check: through the tunnel every caller looks like 127.0.0.1.
    const local = isLocalRequest(req);
    if (!local) {
      for (const k of ["tmdbApiKey", "osApiKey", "osUsername", "osPassword", "lanToken"]) settings[k] = "";
    }
    const folderRows = db.prepare("SELECT id, library_id, path FROM library_folders").all() as { id: number; library_id: number; path: string }[];
    const foldersByLib = new Map<number, { id: number; path: string }[]>();
    for (const f of folderRows) {
      if (!foldersByLib.has(f.library_id)) foldersByLib.set(f.library_id, []);
      foldersByLib.get(f.library_id)!.push({ id: f.id, path: f.path });
    }
    res.json({
      serverName: os.hostname(),
      version: ctx.config.appVersion,
      // Private libraries never appear to remote/LAN clients.
      libraries: libraries
        .filter((l) => local || l.shared !== 0)
        .map((l) => ({ ...l, scanning: scanner.isScanning(l.id), folders: foldersByLib.get(l.id) ?? [] })),
      settings,
      ledgerPath: ledger.ledgerPath,
      logPath: ctx.config.logPath ?? null,
      dataDir: ctx.config.dataDir,
      remote: local ? ctx.tunnel.getStatus() : null,
      lan: {
        enabled: settings.lanEnabled === "1",
        active: ctx.runtime.lanActive, // what the running server actually bound
        port: Number(settings.lanPort) || 3777,
        activePort: ctx.runtime.port,
        token: settings.lanToken,
        // LAN IPv4 addresses a phone on the same network can reach
        addresses: Object.values(os.networkInterfaces())
          .flat()
          .filter((i): i is os.NetworkInterfaceInfoIPv4 => !!i && i.family === "IPv4" && !i.internal)
          .map((i) => i.address),
      },
    });
  });

  /** Lightweight tunnel status. The Settings page polls this while the tunnel
   *  is coming up, so "connecting" flips to "reachable" on its own even if the
   *  live SSE event is missed. */
  r.get("/remote/status", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    res.json(ctx.tunnel.getStatus());
  });

  /**
   * Connectivity self-test through the app's own network stack — the metadata
   * APIs and their image CDNs are hosted separately and fail independently
   * (regional blocking, VPN routing), so test each one.
   */
  r.get("/net-check", async (_req, res) => {
    const proxyUrl = getSetting(db, "tmdbProxyUrl");
    const targets: { name: string; url: string; init?: RequestInit }[] = [
      { name: "TMDB API", url: "https://api.themoviedb.org/3/configuration" },
      ...(proxyUrl ? [{ name: "TMDB Proxy", url: (proxyUrl.trim().endsWith("/3") ? proxyUrl.trim() : `${proxyUrl.trim()}/3`) + "/configuration" }] : []),
      { name: "TMDB images", url: "https://image.tmdb.org/t/p/w92/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg" },
      { name: "TVmaze API", url: "https://api.tvmaze.com/shows/1" },
      { name: "TVmaze images", url: "https://static.tvmaze.com/uploads/images/medium_portrait/0/2400.jpg" },
      {
        name: "AniList API",
        url: "https://graphql.anilist.co",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query{Media(id:1){id}}" }),
        },
      },
      { name: "AniList images", url: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx151807-m1gX3iwfIsLu.png" },
      { name: "OpenSubtitles API", url: "https://api.opensubtitles.com/api/v1/infos/formats" },
    ];
    const results = [];
    for (const t of targets) {
      const started = Date.now();
      try {
        const r2 = await appFetch(t.url, { ...t.init, signal: AbortSignal.timeout(10000) });
        await r2.arrayBuffer().catch(() => {});
        // Any HTTP response (even 401 for keyless API pings) proves reachability.
        results.push({ name: t.name, reachable: true, status: r2.status, ms: Date.now() - started });
      } catch (e: any) {
        results.push({
          name: t.name,
          reachable: false,
          error: String(e?.cause ?? e?.message ?? e).slice(0, 160),
          ms: Date.now() - started,
        });
      }
    }
    console.log("net-check:", results.map((x: any) => `${x.name}=${x.reachable ? `OK(${x.status},${x.ms}ms)` : `FAIL(${x.error})`}`).join(" | "));
    res.json(results);
  });

  // Settings are desktop-only. Nothing else needs them (the phone keeps its own
  // preferences locally), and refusing remote writes means a leaked access token
  // can't rotate the token, read the TMDB key back, or switch remote access off.
  r.put("/settings", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Settings can only be changed on the PC itself" });

    const wasRemote = getSetting(db, "remoteEnabled") === "1";
    for (const k of SETTING_KEYS) {
      if (typeof req.body[k] === "string") setSetting(db, k, req.body[k]);
    }
    if (req.body.hwaccel !== undefined) resetHwAccelCache();
    const nowRemote = getSetting(db, "remoteEnabled") === "1";

    // Turning remote access on retires a weak legacy token. Phones paired by
    // signing in pick the new one up from the published row automatically; a
    // manually-typed one has to be re-entered, which the UI warns about.
    if (nowRemote && (getSetting(db, "lanToken") ?? "").length < 32) {
      setSetting(db, "lanToken", crypto.randomBytes(16).toString("hex"));
      console.log("remote: access token upgraded to 128 bits for internet exposure");
    }

    if (nowRemote !== wasRemote) {
      if (nowRemote) void ctx.tunnel.enable(ctx.runtime.port).catch((e) => console.error("remote: enable failed:", e));
      else ctx.tunnel.disable();
    }

    ctx.watcher.refresh();
    // LAN address/port/token may have changed — refresh what phones discover.
    void ctx.cloud.publishServer();
    ctx.cloud.markConfigChanged(); // sync preferences to the account
    res.json({ ok: true });
  });

  // The colour theme is set by clicking a swatch, so it gets its own tiny write
  // that skips the tunnel/publish/token machinery of PUT /settings — it just
  // persists the value and queues it for the account sync.
  r.put("/settings/theme", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Settings can only be changed on the PC itself" });
    const theme = typeof req.body?.theme === "string" ? req.body.theme : "";
    setSetting(db, "theme", theme);
    ctx.cloud.markConfigChanged();
    res.json({ ok: true });
  });

  r.get("/hwaccel/status", async (_req, res) => {
    res.json(await getHwAccelConfig(db));
  });

  // ---- media cache -----------------------------------------------------------

  /** Size of the whole media-cache tree (posters, thumbs, subtitle cache). */
  r.get("/cache/stats", (_req, res) => {
    let files = 0;
    let bytes = 0;
    const rec = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else {
          files++;
          bytes += fs.statSync(p).size;
        }
      }
    };
    try {
      const root = path.dirname(ctx.thumbsDir); // <dataDir>/media-cache
      if (fs.existsSync(root)) rec(root);
    } catch {
      /* best effort */
    }
    res.json({ files, bytes });
  });

  /**
   * Delete cached artwork nothing references anymore (removed libraries/items)
   * and stale gallery thumbs. Manual from Settings, never automatic — a
   * bookkeeping bug must not silently eat live posters.
   */
  r.post("/cache/cleanup", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Cache can only be managed on the PC itself" });

    // Every column that stores a cache-relative image path.
    const referenced = new Set<string>();
    for (const sql of [
      "SELECT poster AS p FROM media_items WHERE poster IS NOT NULL",
      "SELECT backdrop AS p FROM media_items WHERE backdrop IS NOT NULL",
      "SELECT poster AS p FROM seasons WHERE poster IS NOT NULL",
      "SELECT still AS p FROM episodes WHERE still IS NOT NULL",
      "SELECT photo AS p FROM persons WHERE photo IS NOT NULL",
    ]) {
      for (const row of db.prepare(sql).all() as { p: string }[]) referenced.add(row.p.replace(/\\/g, "/"));
    }

    let removed = 0;
    let freedBytes = 0;
    const sweep = (dir: string, keep: (rel: string) => boolean) => {
      if (!fs.existsSync(dir)) return;
      const rec = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            rec(p);
            continue;
          }
          if (keep(path.relative(dir, p).replace(/\\/g, "/"))) continue;
          try {
            const size = fs.statSync(p).size;
            fs.rmSync(p, { force: true });
            removed++;
            freedBytes += size;
          } catch {
            /* locked file etc — skip */
          }
        }
      };
      try {
        rec(dir);
      } catch {
        /* best effort */
      }
    };

    sweep(ctx.imagesDir, (rel) => referenced.has(rel));
    const liveThumbs = new Set(
      (db.prepare("SELECT id, mtime FROM gallery_items").all() as { id: number; mtime: number }[]).map(
        (g) => `g_${g.id}_${g.mtime}.jpg`
      )
    );
    sweep(path.join(path.dirname(ctx.thumbsDir), "gallery-thumbs"), (rel) => liveThumbs.has(rel));

    res.json({ removed, freedBytes });
  });

  // ---- libraries -------------------------------------------------------------

  r.post("/libraries", (req, res) => {
    const { name, type, path: libPath } = req.body ?? {};
    if (!name || !libPath || !LIBRARY_TYPES.has(type)) {
      return res.status(400).json({ error: "name, type (movies, tv, gallery or other) and path are required" });
    }
    if (!fs.existsSync(libPath) || !fs.statSync(libPath).isDirectory()) {
      return res.status(400).json({ error: "Folder does not exist" });
    }
    try {
      const info = db
        .prepare("INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)")
        .run(name, type, libPath);
      const lib = getLibrary(Number(info.lastInsertRowid))!;
      ctx.watcher.refresh();
      void scanner.scanLibrary(lib);
      ctx.cloud.markConfigChanged();
      res.json(lib);
    } catch (e: any) {
      res.status(400).json({ error: /UNIQUE/.test(String(e)) ? "That folder is already a library" : String(e) });
    }
  });

  // Sidebar order. Takes the full id list in display order; anything not listed
  // (or added later) sorts after the positioned ones, alphabetically.
  r.post("/libraries/order", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "number")) {
      return res.status(400).json({ error: "ids must be an array of library ids" });
    }
    const set = db.prepare("UPDATE libraries SET position = ? WHERE id = ?");
    db.transaction(() => ids.forEach((id: number, i: number) => set.run(i, id)))();
    ctx.cloud.markConfigChanged();
    res.json({ ok: true });
  });

  r.delete("/libraries/:id", (req, res) => {
    db.prepare("DELETE FROM libraries WHERE id = ?").run(+req.params.id);
    ctx.watcher.refresh();
    ctx.cloud.markConfigChanged();
    res.json({ ok: true });
  });

  // Extra source folders — a library can span several drives/folders. The
  // primary folder stays libraries.path; these are additional roots.
  r.post("/libraries/:id/folders", (req, res) => {
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    const folder = String(req.body?.path ?? "").trim();
    if (!folder) return res.status(400).json({ error: "A folder path is required" });
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return res.status(400).json({ error: "Folder does not exist" });
    }
    // A folder belongs to at most one library (and can't duplicate a primary path).
    const clash =
      db.prepare("SELECT 1 FROM libraries WHERE path = ?").get(folder) ||
      db.prepare("SELECT 1 FROM library_folders WHERE path = ?").get(folder);
    if (clash) return res.status(400).json({ error: "That folder is already part of a library" });
    db.prepare("INSERT INTO library_folders (library_id, path) VALUES (?, ?)").run(lib.id, folder);
    ctx.watcher.refresh();
    void scanner.scanLibrary(lib);
    ctx.cloud.markConfigChanged();
    res.json({ ok: true });
  });

  r.delete("/libraries/:id/folders/:folderId", (req, res) => {
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    const row = db
      .prepare("SELECT path FROM library_folders WHERE id = ? AND library_id = ?")
      .get(+req.params.folderId, lib.id) as { path: string } | undefined;
    if (!row) return res.status(404).json({ error: "No such folder" });
    const prefix = row.path.replace(/[\\/]+$/, "") + "%";
    db.transaction(() => {
      db.prepare("DELETE FROM library_folders WHERE id = ?").run(+req.params.folderId);
      // Drop the catalog rows for files under it; disk files + watch progress
      // (fingerprint-keyed) are untouched. The rescan clears any emptied items.
      db.prepare("DELETE FROM files WHERE library_id = ? AND path LIKE ?").run(lib.id, prefix);
      db.prepare("DELETE FROM gallery_items WHERE library_id = ? AND path LIKE ?").run(lib.id, prefix);
    })();
    ctx.watcher.refresh();
    void scanner.scanLibrary(lib);
    ctx.cloud.markConfigChanged();
    res.json({ ok: true });
  });

  /**
   * Edit a library. Changing the type (movies <-> tv) — or passing
   * rebuild: true — rebuilds it from scratch: items/episodes/files are dropped
   * and the folder rescanned with the right parsing rules. Watch progress is
   * untouched — it's keyed by file fingerprint, not by library — so resume
   * positions reattach on rescan.
   */
  r.put("/libraries/:id", (req, res) => {
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    const { name, type } = req.body ?? {};
    if (type && !LIBRARY_TYPES.has(type)) {
      return res.status(400).json({ error: "type must be movies, tv, gallery or other" });
    }
    const rebuild = (type && type !== lib.type) || req.body?.rebuild === true;
    const tx = db.transaction(() => {
      if (rebuild) {
        db.prepare("DELETE FROM files WHERE library_id = ?").run(lib.id);
        db.prepare("DELETE FROM media_items WHERE library_id = ?").run(lib.id);
        db.prepare("DELETE FROM gallery_items WHERE library_id = ?").run(lib.id);
      }
      db.prepare("UPDATE libraries SET name = ?, type = ? WHERE id = ?").run(
        typeof name === "string" && name.trim() ? name.trim() : lib.name,
        type ?? lib.type,
        lib.id
      );
    });
    tx();
    const fresh = getLibrary(lib.id)!;
    ctx.watcher.refresh();
    if (rebuild) void scanner.scanLibrary(fresh);
    ctx.cloud.markConfigChanged();
    res.json(fresh);
  });

  /**
   * Toggle whether a library is reachable by remote/LAN clients. Local-only, and
   * deliberately NOT synced to the account: sharing is a property of the machine
   * that holds the files, so each device decides for itself.
   */
  r.post("/libraries/:id/sharing", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    db.prepare("UPDATE libraries SET shared = ? WHERE id = ?").run(req.body?.shared ? 1 : 0, lib.id);
    res.json(getLibrary(lib.id)!);
  });

  r.post("/libraries/:id/scan", (req, res) => {
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    void scanner.scanLibrary(lib);
    res.json({ ok: true });
  });

  // ---- item listings ---------------------------------------------------------

  // Watch state is read/written through the ACTIVE profile (X-Locality-Profile
  // header or ?profile=), falling back to the default. The default profile uses
  // the ledger (so its progress stays portable + cloud-synced); other profiles
  // are server-local. See services/profiles.ts.
  type Get = (fingerprint: string) => ProgressEntry | null;
  const storeFor = (req: Request) =>
    ctx.profiles.store(ctx.profiles.resolve(req.header("x-locality-profile") ?? req.query.profile));
  /** Bound `get` for the active profile — one store per request. */
  const getFor = (req: Request): Get => {
    const store = storeFor(req);
    return (fp) => store.get(fp);
  };

  /** Watched/in-progress rollup for a movie item (any of its files). */
  function movieWatchState(itemId: number, get: Get) {
    const files = db
      .prepare("SELECT fingerprint FROM files WHERE media_item_id = ? AND episode_id IS NULL AND missing = 0")
      .all(itemId) as { fingerprint: string }[];
    let watched = false;
    let inProgress = false;
    let progressPct: number | undefined; // real resume % for the poster strip
    for (const f of files) {
      const p = get(f.fingerprint);
      if (p?.watched) watched = true;
      else if (p && p.position_seconds > 30) {
        inProgress = true;
        if (p.duration_seconds > 0) {
          const pct = Math.min(99, Math.max(1, Math.round((p.position_seconds / p.duration_seconds) * 100)));
          if (progressPct === undefined || pct > progressPct) progressPct = pct;
        }
      }
    }
    return { watched, inProgress, progressPct };
  }

  function showWatchState(showId: number, get: Get) {
    const eps = db
      .prepare(
        `SELECT e.id, f.fingerprint FROM episodes e
         LEFT JOIN files f ON f.episode_id = e.id AND f.missing = 0
         WHERE e.show_id = ?`
      )
      .all(showId) as { id: number; fingerprint: string | null }[];
    const total = new Set(eps.map((e) => e.id)).size;
    const watchedEps = new Set<number>();
    for (const e of eps) {
      if (e.fingerprint && get(e.fingerprint)?.watched) watchedEps.add(e.id);
    }
    return { episodeCount: total, watchedCount: watchedEps.size };
  }

  r.get("/libraries/:id/items", (req, res) => {
    const lib = getLibrary(+req.params.id);
    if (!lib) return res.status(404).json({ error: "No such library" });
    if (!isLocalRequest(req) && lib.shared === 0) return res.status(404).json({ error: "No such library" });
    const get = getFor(req);
    const items = db
      .prepare("SELECT * FROM media_items WHERE library_id = ? ORDER BY sort_title")
      .all(lib.id) as MediaItem[];
    res.json(
      items.map((it) => ({
        ...it,
        genres: JSON.parse(it.genres),
        ...(it.type === "movie" ? movieWatchState(it.id, get) : showWatchState(it.id, get)),
      }))
    );
  });

  /**
   * Search the whole catalog (all libraries) by title. Matches shows/movies and,
   * for episodes, surfaces the parent show so a search for an episode title still
   * lands somewhere playable. Returns list-shaped items with the library each is
   * in, so the UI can group and link.
   */
  r.get("/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const get = getFor(req);
    const libsById = new Map(
      (db.prepare("SELECT * FROM libraries").all() as Library[]).map((l) => [l.id, l])
    );

    // Direct title hits, then shows reachable via an episode-title hit. Remote
    // clients never see titles from a private library.
    const notInternal = isLocalRequest(req)
      ? "library_id IN (SELECT id FROM libraries WHERE internal = 0)"
      : "library_id IN (SELECT id FROM libraries WHERE internal = 0 AND shared != 0)";
    const direct = db
      .prepare(
        `SELECT * FROM media_items
          WHERE hidden = 0 AND ${notInternal} AND (title LIKE ? ESCAPE '\\' OR sort_title LIKE ? ESCAPE '\\')
          ORDER BY sort_title LIMIT 40`
      )
      .all(like, like) as MediaItem[];
    const found = new Map<number, MediaItem>(direct.map((it) => [it.id, it]));
    if (found.size < 40) {
      const viaEp = db
        .prepare(
          `SELECT DISTINCT mi.* FROM episodes e
             JOIN media_items mi ON mi.id = e.show_id
            WHERE mi.hidden = 0 AND mi.${notInternal} AND e.title LIKE ? ESCAPE '\\'
            ORDER BY mi.sort_title LIMIT 40`
        )
        .all(like) as MediaItem[];
      for (const it of viaEp) if (!found.has(it.id)) found.set(it.id, it);
    }

    const shape = listShape(get);
    res.json(
      [...found.values()].slice(0, 40).map((it) => {
        const lib = libsById.get(it.library_id);
        return { ...shape(it), libraryId: it.library_id, libraryName: lib?.name ?? "" };
      })
    );
  });

  // ---- home ------------------------------------------------------------------

  r.get("/home", (req, res) => {
    const local = isLocalRequest(req);
    // Continue Watching: newest-first unfinished progress for the active profile,
    // mapped back to local files.
    const rows = ctx.profiles.continueRows(
      ctx.profiles.resolve(req.header("x-locality-profile") ?? req.query.profile)
    ) as any[];
    const seen = new Set<string>();
    const continueWatching = [];
    for (const row of rows) {
      if (seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      const card = cardForFile(row);
      if (card) continueWatching.push(card);
    }

    // Gallery libraries have no media_items (photos live in gallery_items), so
    // they'd show as an empty row — leave them off Home.
    const libraries = (db.prepare("SELECT * FROM libraries WHERE internal = 0 AND type != 'gallery' ORDER BY COALESCE(position, 999999999), name").all() as Library[])
      .filter((l) => local || l.shared !== 0);
    const recentlyAdded = libraries.map((lib) => ({
      library: lib,
      items: (db
        .prepare("SELECT * FROM media_items WHERE library_id = ? AND hidden = 0 ORDER BY added_at DESC, id DESC LIMIT 12")
        .all(lib.id) as MediaItem[]).map((it) => ({ ...it, genres: JSON.parse(it.genres) })),
    }));

    // Watchlist ("Want to watch"), newest first, hidden items excluded.
    const watchlist = (db
      .prepare(
        `SELECT mi.* FROM watchlist w JOIN media_items mi ON mi.id = w.item_id
         WHERE mi.hidden = 0 ORDER BY w.added_at DESC`
      )
      .all() as any[])
      .filter((it) => local || libraryShared(db, it.library_id))
      .map((it) => ({ ...it, genres: JSON.parse(it.genres) }));

    res.json({ continueWatching, recentlyAdded, watchlist });

    function cardForFile(row: any) {
      if (row.episode_id) {
        const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(row.episode_id) as Episode | undefined;
        if (!ep) return null;
        const show = db.prepare("SELECT * FROM media_items WHERE id = ?").get(ep.show_id) as MediaItem | undefined;
        if (!show || show.hidden) return null;
        if (!local && !libraryShared(db, show.library_id)) return null;
        return {
          kind: "episode",
          fileId: row.file_id,
          itemId: show.id,
          title: show.title,
          subtitle: `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}${ep.title ? " · " + ep.title : ""}`,
          poster: show.poster,
          backdrop: ep.still ?? show.backdrop,
          position: row.position_seconds,
          duration: row.duration_seconds,
        };
      }
      if (row.media_item_id) {
        const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(row.media_item_id) as MediaItem | undefined;
        if (!item || item.hidden) return null;
        if (!local && !libraryShared(db, item.library_id)) return null;
        return {
          kind: "movie",
          fileId: row.file_id,
          itemId: item.id,
          title: item.title,
          subtitle: item.year ? String(item.year) : "",
          poster: item.poster,
          backdrop: item.backdrop,
          position: row.position_seconds,
          duration: row.duration_seconds,
        };
      }
      return null;
    }
  });

  // ---- item detail -----------------------------------------------------------

  r.get("/items/:id", (req, res) => {
    const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(+req.params.id) as MediaItem | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    if (!itemVisibleTo(db, req, item.id)) return res.status(404).json({ error: "No such item" });
    const out: any = {
      ...item,
      genres: JSON.parse(item.genres),
      cast: JSON.parse(item.cast_json),
      crew: JSON.parse(item.crew_json),
    };
    delete out.cast_json;
    delete out.crew_json;
    out.inWatchlist = !!db.prepare("SELECT 1 FROM watchlist WHERE item_id = ?").get(item.id);

    const get = getFor(req);

    if (item.type === "movie") {
      out.files = (db
        .prepare("SELECT * FROM files WHERE media_item_id = ? AND episode_id IS NULL AND missing = 0")
        .all(item.id) as MediaFile[]).map((f) => ({ ...f, progress: get(f.fingerprint) }));
      const ws = movieWatchState(item.id, get);
      out.watched = ws.watched;
      out.inProgress = ws.inProgress;
    } else {
      const seasons = db
        .prepare("SELECT * FROM seasons WHERE show_id = ? ORDER BY season")
        .all(item.id) as Season[];
      const seasonNums = (db
        .prepare("SELECT DISTINCT season FROM episodes WHERE show_id = ? ORDER BY season")
        .all(item.id) as { season: number }[]).map((s) => s.season);
      out.seasons = seasonNums.map((n) => {
        const meta = seasons.find((s) => s.season === n);
        const episodes = (db
          .prepare("SELECT * FROM episodes WHERE show_id = ? AND season = ? ORDER BY episode")
          .all(item.id, n) as Episode[]).map((ep) => {
          const file = db
            .prepare("SELECT * FROM files WHERE episode_id = ? AND missing = 0 LIMIT 1")
            .get(ep.id) as MediaFile | undefined;
          return { ...ep, file: file ?? null, progress: file ? get(file.fingerprint) : null };
        });
        return { season: n, name: meta?.name ?? (n === 0 ? "Specials" : `Season ${n}`), poster: meta?.poster ?? null, overview: meta?.overview ?? null, episodes };
      });
      const ws = showWatchState(item.id, get);
      out.episodeCount = ws.episodeCount;
      out.watchedCount = ws.watchedCount;
    }
    res.json(out);
  });

  // ---- matching / metadata refresh --------------------------------------------

  /** Uniform metadata search across providers (Match dialog). */
  r.get("/search-meta", async (req, res) => {
    const { q, type, year, provider } = req.query as Record<string, string>;
    if (!q || (type !== "movie" && type !== "tv")) {
      return res.status(400).json({ error: "q and type=movie|tv required" });
    }
    try {
      if (provider === "tvmaze") {
        if (type === "movie") return res.status(400).json({ error: "TVmaze only covers TV shows" });
        return res.json(await ctx.tvmaze.search(q));
      }
      if (provider === "anilist") {
        return res.json(await ctx.anilist.search(q, type === "movie"));
      }
      const results = await ctx.tmdb.search(q, type, year ? +year : null);
      res.json(results.map((r) => ({ providerId: r.tmdbId, title: r.title, year: r.year, overview: r.overview })));
    } catch (e: any) {
      res.status(e instanceof TmdbError ? e.status ?? 500 : 500).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/items/:id/match", async (req, res) => {
    const provider = (req.body?.provider ?? "tmdb") as "tmdb" | "tvmaze" | "anilist";
    const providerId = +(req.body?.providerId ?? req.body?.tmdbId);
    if (!providerId) return res.status(400).json({ error: "providerId required" });
    if (!["tmdb", "tvmaze", "anilist"].includes(provider)) {
      return res.status(400).json({ error: "provider must be tmdb|tvmaze|anilist" });
    }
    try {
      await scanner.fetchMetadataForItem(+req.params.id, { provider, providerId });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/items/:id/refresh", async (req, res) => {
    const item = db.prepare("SELECT id FROM media_items WHERE id = ?").get(+req.params.id) as Pick<MediaItem, "id"> | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    try {
      // Re-fetches from the stored provider/id; auto-matches if never matched.
      await scanner.fetchMetadataForItem(item.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // ---- watched toggles ---------------------------------------------------------

  r.post("/items/:id/watched", (req, res) => {
    const watched = !!req.body?.watched;
    const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(+req.params.id) as MediaItem | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    const files =
      item.type === "movie"
        ? (db.prepare("SELECT * FROM files WHERE media_item_id = ? AND episode_id IS NULL AND missing = 0").all(item.id) as MediaFile[])
        : (db
            .prepare(
              `SELECT f.* FROM files f JOIN episodes e ON f.episode_id = e.id
               WHERE e.show_id = ? AND f.missing = 0`
            )
            .all(item.id) as any[]);
    const store = storeFor(req);
    for (const f of files) store.setWatched(f.fingerprint, f.filename, f.size, watched);
    res.json({ ok: true });
  });

  /** Add or remove an item from the watchlist ("Want to watch"). */
  r.post("/items/:id/watchlist", (req, res) => {
    const id = +req.params.id;
    if (!db.prepare("SELECT id FROM media_items WHERE id = ?").get(id))
      return res.status(404).json({ error: "No such item" });
    if (req.body?.on) {
      db.prepare("INSERT INTO watchlist (item_id, added_at) VALUES (?, ?) ON CONFLICT(item_id) DO NOTHING").run(
        id,
        new Date().toISOString()
      );
    } else {
      db.prepare("DELETE FROM watchlist WHERE item_id = ?").run(id);
    }
    res.json({ ok: true, inWatchlist: !!req.body?.on });
  });

  /** Hide ("remove from library") or restore an item. Files are never touched. */
  r.post("/items/:id/hidden", (req, res) => {
    const info = db
      .prepare("UPDATE media_items SET hidden = ? WHERE id = ?")
      .run(req.body?.hidden ? 1 : 0, +req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: "No such item" });
    res.json({ ok: true });
  });

  // ---- person pages -----------------------------------------------------------

  /** Small helper: list-shaped item with watch rollups (same shape as library listings). */
  const listShape = (get: Get) => (it: any) => ({
    ...it,
    genres: JSON.parse(it.genres),
    ...(it.type === "movie" ? movieWatchState(it.id, get) : showWatchState(it.id, get)),
  });

  r.get("/person/:tmdbId", async (req, res) => {
    const tmdbId = +req.params.tmdbId;
    let row = db.prepare("SELECT * FROM persons WHERE tmdb_id = ?").get(tmdbId) as PersonRow | undefined;
    if (!row) {
      try {
        const d = await ctx.tmdb.personDetails(tmdbId);
        const photo = d.profile_path
          ? await cacheImageFromUrl(ctx.imagesDir, `https://image.tmdb.org/t/p/w300${d.profile_path}`, "poster", `tmdb-person:${tmdbId}`)
          : null;
        const data = {
          name: d.name,
          bio: (d.biography || "").split("\n\n").slice(0, 2).join("\n\n"),
          birthday: d.birthday ?? null,
          deathday: d.deathday ?? null,
          knownFor: d.known_for_department ?? null,
          placeOfBirth: d.place_of_birth ?? null,
        };
        const fetchedAt = new Date().toISOString();
        db.prepare("INSERT OR REPLACE INTO persons (tmdb_id, data, photo, fetched_at) VALUES (?, ?, ?, ?)")
          .run(tmdbId, JSON.stringify(data), photo, fetchedAt);
        row = { tmdb_id: tmdbId, data: JSON.stringify(data), photo, fetched_at: fetchedAt };
      } catch (e: any) {
        return res.status(e instanceof TmdbError ? e.status ?? 500 : 500).json({ error: String(e?.message ?? e) });
      }
    }
    if (!row) return res.status(500).json({ error: "Could not load person" });
    // Cross-reference against the library: items whose cast/crew carry this id.
    const items = db
      .prepare("SELECT * FROM media_items WHERE hidden = 0 AND provider = 'tmdb'")
      .all() as MediaItem[];
    const inLibrary = items.filter((it) => {
      try {
        const people = [...JSON.parse(it.cast_json), ...JSON.parse(it.crew_json)];
        return people.some((p: any) => p.id === tmdbId);
      } catch {
        return false;
      }
    });
    res.json({ person: { tmdbId, ...JSON.parse(row.data), photo: row.photo }, inLibrary: inLibrary.map(listShape(getFor(req))) });
  });

  // ---- "More Like This" ---------------------------------------------------------

  r.get("/items/:id/similar", async (req, res) => {
    const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(+req.params.id) as MediaItem | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    if (!itemVisibleTo(db, req, item.id)) return res.status(404).json({ error: "No such item" });
    let ids: number[] = [];
    try {
      ids = item.recs_json ? JSON.parse(item.recs_json) : [];
    } catch {}
    if (ids.length === 0 && item.tmdb_id && ctx.tmdb.hasKey()) {
      try {
        ids = await ctx.tmdb.recommendationIds(item.type === "movie" ? "movie" : "tv", item.tmdb_id);
        db.prepare("UPDATE media_items SET recs_json = ? WHERE id = ?").run(JSON.stringify(ids), item.id);
      } catch {
        /* no key / offline — empty row is fine */
      }
    }
    if (ids.length === 0) return res.json([]);
    // Only titles that exist in the library — never suggest unowned media.
    const placeholders = ids.map(() => "?").join(",");
    const owned = db
      .prepare(`SELECT * FROM media_items WHERE hidden = 0 AND tmdb_id IN (${placeholders}) AND id != ?`)
      .all(...ids, item.id) as MediaItem[];
    // Preserve TMDB's recommendation order. (tmdb_id can't be null here — the
    // query filters on it — but the column is nullable, so be explicit.)
    const rank = (v: number | null) => (v == null ? Number.MAX_SAFE_INTEGER : ids.indexOf(v));
    owned.sort((a, b) => rank(a.tmdb_id) - rank(b.tmdb_id));
    const visible = isLocalRequest(req) ? owned : owned.filter((it) => libraryShared(db, it.library_id));
    res.json(visible.map(listShape(getFor(req))));
  });

  // ---- intro/credits markers ------------------------------------------------------

  // ---- profiles --------------------------------------------------------------

  // Listing is allowed for any authenticated client (the phone needs it to pick
  // a profile later); creating/renaming/deleting is PC-only, like settings.
  r.get("/profiles", (_req, res) => res.json(ctx.profiles.list()));

  r.post("/profiles", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Profiles are managed on the PC itself" });
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "A name is required" });
    res.json(ctx.profiles.create(name, String(req.body?.color ?? "")));
  });

  r.put("/profiles/:id", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Profiles are managed on the PC itself" });
    try {
      res.json(ctx.profiles.update(+req.params.id, { name: req.body?.name, color: req.body?.color }));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.delete("/profiles/:id", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Profiles are managed on the PC itself" });
    try {
      ctx.profiles.remove(+req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Set or clear a profile's local password (empty string clears it). PC-only.
  r.put("/profiles/:id/password", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Profiles are managed on the PC itself" });
    try {
      ctx.profiles.setPassword(+req.params.id, String(req.body?.password ?? ""));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Verify a password to unlock a profile. Available to any authenticated client
  // (the check is local; the global middleware already rate-limits remote ones).
  r.post("/profiles/:id/unlock", (req, res) => {
    if (ctx.profiles.verify(+req.params.id, String(req.body?.password ?? ""))) return res.json({ ok: true });
    res.status(401).json({ error: "Wrong password" });
  });

  // ---- downloads (pull from another server) ----------------------------------

  // Start a download from a connected remote server. Local-only: the request
  // carries that server's URL + token, which must never come from the internet.
  r.post("/downloads", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Downloads are managed on the PC itself" });
    const { serverUrl, token, itemId, season, sourceName } = req.body ?? {};
    if (!serverUrl || !itemId) return res.status(400).json({ error: "serverUrl and itemId are required" });
    try {
      const out = await ctx.downloads.enqueue({
        serverUrl: String(serverUrl),
        token: String(token ?? ""),
        itemId: Number(itemId),
        season: season == null ? null : Number(season),
        sourceName: sourceName ? String(sourceName) : undefined,
      });
      res.json(out);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.get("/downloads", (_req, res) => res.json(ctx.downloads.list()));

  r.delete("/downloads/:id", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Downloads are managed on the PC itself" });
    ctx.downloads.remove(+req.params.id);
    res.json({ ok: true });
  });

  // ---- cloud account / sync (optional) --------------------------------------------

  r.get("/cloud/status", (_req, res) => res.json(ctx.cloud.getStatus()));

  r.post("/cloud/signup", async (req, res) => {
    try {
      res.json(await ctx.cloud.signUp(String(req.body?.email ?? "").trim(), String(req.body?.password ?? "")));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/cloud/signin", async (req, res) => {
    try {
      res.json(await ctx.cloud.signIn(String(req.body?.email ?? "").trim(), String(req.body?.password ?? "")));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/cloud/signout", (_req, res) => res.json(ctx.cloud.signOut()));

  // Server discovery for the "Connect to a server" dialog: find another PC by
  // account instead of by IP + token. Local-only, like every other route that
  // handles credentials.
  r.get("/cloud/servers", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      res.json(await ctx.cloud.listServers());
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  /** Same, for an account this machine isn't signed into (a friend's library). */
  r.post("/cloud/servers/lookup", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      const email = String(req.body?.email ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
      res.json(await ctx.cloud.lookupServers(email, password));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/cloud/sync", async (_req, res) => res.json(await ctx.cloud.syncNow("manual")));

  // ---- account servers (Settings > Account) -------------------------------------
  // Devices published under this account. Local-only: it manages the account's
  // own device list and touches its cloud session.

  r.get("/account/servers", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      res.json(await ctx.cloud.listAccountServers());
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/account/servers/rename", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.cloud.renameServer(String(req.body?.serverId ?? ""), String(req.body?.name ?? ""));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/account/servers/remove", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.cloud.removeServer(String(req.body?.serverId ?? ""));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // ---- watch party ------------------------------------------------------------------
  // Local-only: these act on this machine's account session and drive this
  // machine's player, so a LAN client (or a guest holding the server token) has
  // no business calling them.

  /** Full picture for the Party tab. Live updates arrive on the "party" SSE event. */
  r.get("/party/status", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.party.loadProfile();
      await ctx.party.loadContacts();
    } catch {
      // Offline or signed out — the snapshot still renders, just without them.
    }
    res.json(ctx.party.snapshot());
  });

  r.post("/party/username", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.party.setUsername(String(req.body?.username ?? ""));
      res.json(ctx.party.snapshot());
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  /** Does this email/username belong to a Locality account? Exact match only. */
  r.get("/party/lookup", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      res.json({ user: await ctx.party.findUser(String(req.query.q ?? "")) });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/party/host", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      const mode = req.body?.mode === "stream" ? "stream" : "local";
      res.json(await ctx.party.host(Number(req.body?.fileId), mode));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/party/invite", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      res.json(await ctx.party.invite(String(req.body?.identifier ?? "")));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/party/accept", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      res.json(await ctx.party.accept(String(req.body?.partyId ?? "")));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/party/decline", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.party.decline(String(req.body?.partyId ?? ""));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/party/leave", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    await ctx.party.leave();
    res.json({ ok: true });
  });

  /**
   * A local play/pause/seek, pushed to everyone else. Called by both players
   * (the mpv overlay and the built-in one) whenever the user acts — never for
   * the ordinary tick of playback, which would fight with everyone else's.
   */
  r.post("/party/state", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.party.publish(Number(req.body?.position) || 0, !!req.body?.paused);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  /** The player pings this while open so the others see a live "in the player" dot. */
  r.post("/party/presence", async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "Only available on the PC itself" });
    try {
      await ctx.party.setWatching(!!req.body?.watching);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  /** Live progress of the intro/credits detector (also pushed via the "detect" SSE event). */
  r.get("/detect/status", (_req, res) => res.json(ctx.detector.getStatus()));

  /** Pause/resume detection — takes effect mid-episode, not just between them. */
  r.post("/detect/pause", (req, res) => {
    ctx.detector.setPaused(!!req.body?.paused);
    res.json(ctx.detector.getStatus());
  });

  /** Force (re-)detection for a show. */
  r.post("/items/:id/detect-markers", (req, res) => {
    const item = db.prepare("SELECT id, type FROM media_items WHERE id = ?").get(+req.params.id) as Pick<MediaItem, "id" | "type"> | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    if (item.type !== "show") return res.status(400).json({ error: "Intro detection applies to shows" });
    ctx.detector.enqueueShow(item.id, true);
    res.json({ ok: true });
  });

  /** Manual override of detected timestamps (null/empty clears a field). */
  r.put("/episodes/:id/markers", (req, res) => {
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const info = db
      .prepare("UPDATE episodes SET intro_start=?, intro_end=?, credits_start=?, markers_done=1 WHERE id=?")
      .run(num(req.body?.intro_start), num(req.body?.intro_end), num(req.body?.credits_start), +req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: "No such episode" });
    res.json({ ok: true });
  });

  // ---- collections -----------------------------------------------------------------

  /** All collections: TMDB box sets derived from metadata + manual ones. Keys: "tmdb:<id>" / "man:<id>". */
  r.get("/collections", (req, res) => {
    const libId = req.query.libraryId ? +req.query.libraryId : null;
    const out: any[] = [];
    const tmdbQuery = libId
      ? `SELECT collection_id, collection_name, count(1) AS n FROM media_items
         WHERE hidden = 0 AND collection_id IS NOT NULL AND library_id = ?
         GROUP BY collection_id HAVING n >= 2`
      : `SELECT collection_id, collection_name, count(1) AS n FROM media_items
         WHERE hidden = 0 AND collection_id IS NOT NULL
         GROUP BY collection_id HAVING n >= 2`;
    const tmdbGroups = (libId ? db.prepare(tmdbQuery).all(libId) : db.prepare(tmdbQuery).all()) as any[];
    for (const g of tmdbGroups) {
      const firstQuery = libId
        ? "SELECT poster FROM media_items WHERE collection_id = ? AND library_id = ? AND hidden = 0 AND poster IS NOT NULL ORDER BY year LIMIT 1"
        : "SELECT poster FROM media_items WHERE collection_id = ? AND hidden = 0 AND poster IS NOT NULL ORDER BY year LIMIT 1";
      const first = (libId ? db.prepare(firstQuery).get(g.collection_id, libId) : db.prepare(firstQuery).get(g.collection_id)) as Pick<MediaItem, "poster"> | undefined;
      out.push({ key: `tmdb:${g.collection_id}`, name: g.collection_name, count: g.n, poster: first?.poster ?? null });
    }
    const manualQuery = libId
      ? `SELECT c.* FROM collections c
         JOIN collection_items ci ON ci.collection_id = c.id
         JOIN media_items mi ON mi.id = ci.item_id
         WHERE mi.hidden = 0 AND mi.library_id = ?
         GROUP BY c.id ORDER BY c.name`
      : `SELECT * FROM collections ORDER BY name`;
    const manual = (libId ? db.prepare(manualQuery).all(libId) : db.prepare(manualQuery).all()) as Collection[];
    for (const c of manual) {
      const posterQuery = libId
        ? `SELECT mi.poster FROM collection_items ci JOIN media_items mi ON mi.id = ci.item_id
           WHERE ci.collection_id = ? AND mi.library_id = ? AND mi.hidden = 0 AND mi.poster IS NOT NULL LIMIT 1`
        : `SELECT mi.poster FROM collection_items ci JOIN media_items mi ON mi.id = ci.item_id
           WHERE ci.collection_id = ? AND mi.hidden = 0 AND mi.poster IS NOT NULL LIMIT 1`;
      const items = (libId ? db.prepare(posterQuery).get(c.id, libId) : db.prepare(posterQuery).get(c.id)) as any;
      const countQuery = libId
        ? `SELECT count(1) AS n FROM collection_items ci JOIN media_items mi ON mi.id = ci.item_id WHERE ci.collection_id = ? AND mi.library_id = ? AND mi.hidden = 0`
        : `SELECT count(1) AS n FROM collection_items WHERE collection_id = ?`;
      const n = (libId ? db.prepare(countQuery).get(c.id, libId) : db.prepare(countQuery).get(c.id)) as { n: number };
      if (n.n > 0 || !libId) {
        out.push({ key: `man:${c.id}`, name: c.name, count: n.n, poster: items?.poster ?? null });
      }
    }
    res.json(out);
  });

  r.post("/collections", (req, res) => {
    const name = (req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    const info = db.prepare("INSERT INTO collections (name) VALUES (?)").run(name);
    res.json({ key: `man:${info.lastInsertRowid}`, id: Number(info.lastInsertRowid), name });
  });

  r.post("/collections/:id/items", (req, res) => {
    const itemId = +req.body?.itemId;
    if (!itemId) return res.status(400).json({ error: "itemId required" });
    try {
      db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, item_id) VALUES (?, ?)").run(+req.params.id, itemId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  r.delete("/collections/:id/items/:itemId", (req, res) => {
    db.prepare("DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?").run(+req.params.id, +req.params.itemId);
    res.json({ ok: true });
  });

  /** Collection detail. TMDB collections also report how many parts exist in total. */
  r.get("/collections/:key", async (req, res) => {
    const key = req.params.key;
    if (key.startsWith("tmdb:")) {
      const cid = +key.slice(5);
      const items = db
        .prepare("SELECT * FROM media_items WHERE collection_id = ? AND hidden = 0 ORDER BY year, title")
        .all(cid) as MediaItem[];
      if (items.length === 0) return res.status(404).json({ error: "Collection not in library" });
      let total: number | null = null;
      if (ctx.tmdb.hasKey()) {
        try {
          const d = await ctx.tmdb.collectionDetails(cid);
          total = (d.parts ?? []).length || null;
        } catch {}
      }
      return res.json({ key, name: items[0].collection_name, manual: false, total, items: items.map(listShape(getFor(req))) });
    }
    if (key.startsWith("man:")) {
      const id = +key.slice(4);
      const c = db.prepare("SELECT * FROM collections WHERE id = ?").get(id) as Collection | undefined;
      if (!c) return res.status(404).json({ error: "No such collection" });
      const items = db
        .prepare(
          `SELECT mi.* FROM collection_items ci JOIN media_items mi ON mi.id = ci.item_id
           WHERE ci.collection_id = ? AND mi.hidden = 0 ORDER BY mi.year, mi.title`
        )
        .all(id) as any[];
      return res.json({ key, name: c.name, manual: true, id, total: null, items: items.map(listShape(getFor(req))) });
    }
    res.status(400).json({ error: "bad collection key" });
  });

  r.delete("/collections/:id", (req, res) => {
    db.prepare("DELETE FROM collections WHERE id = ?").run(+req.params.id);
    res.json({ ok: true });
  });

  r.post("/episodes/:id/watched", (req, res) => {
    const watched = !!req.body?.watched;
    const file = db
      .prepare("SELECT * FROM files WHERE episode_id = ? AND missing = 0 LIMIT 1")
      .get(+req.params.id) as MediaFile | undefined;
    if (!file) return res.status(404).json({ error: "Episode has no file" });
    storeFor(req).setWatched(file.fingerprint, file.filename, file.size, watched);
    res.json({ ok: true });
  });

  return r;
}
