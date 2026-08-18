// Local server layer. Deliberately self-contained (no Electron imports).
//
// Network exposure, in increasing order of reach:
//   loopback only          — the default; only the desktop UI can talk to us.
//   "lanEnabled"           — binds 0.0.0.0 on a fixed port for phones at home.
//   "remoteEnabled"        — plus a Cloudflare tunnel, reachable from anywhere.
// Everything past loopback must present the access token from Settings.
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { openDatabase, backupDatabase, getSetting, setSetting } from "./db";
import type { ServerConfig } from "./types";
import { buildContext, type Ctx } from "./context";
import { mediaRoutes } from "./routes/media";
import { playerRoutes } from "./routes/player";
import { events } from "./services/events";
import { isLocalRequest, clientKey } from "./services/requestOrigin";

export interface RunningServer {
  port: number;
  ctx: Ctx;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = openDatabase(config.dataDir);
  // Daily snapshot before this session touches anything (runs in the background).
  void backupDatabase(db, config.dataDir);
  const ctx = buildContext(db, config);
  // Migration: rescue anything in the old (Chromium-owned) cache location —
  // merge file-by-file so partially-populated targets still pick everything up.
  const mergeDirs = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      if (e.isDirectory()) mergeDirs(src, dst);
      else if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    }
  };
  for (const [legacy, current] of [
    [path.join(config.dataDir, "cache", "images"), ctx.imagesDir],
    [path.join(config.dataDir, "cache", "subtitles"), ctx.subsCacheDir],
  ]) {
    try {
      if (fs.existsSync(legacy)) {
        mergeDirs(legacy, current);
        fs.rmSync(legacy, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }
  fs.mkdirSync(ctx.imagesDir, { recursive: true });
  fs.mkdirSync(ctx.subsCacheDir, { recursive: true });
  fs.mkdirSync(ctx.downloadsDir, { recursive: true });

  ctx.ledger.start();
  ctx.downloads.resume(); // pick up any transfer a quit interrupted
  ctx.cloud.start(); // no-op unless Supabase is configured + signed in
  ctx.party.start(); // idles on a slow invite poll until a party is running
  ctx.watcher.refresh();

  // After every completed scan, kick intro/credits detection for shows that
  // gained episodes (the detector itself is throttled to one job at a time).
  events.on("scan", (d: any) => {
    if (d?.phase === "done") {
      try {
        ctx.detector.enqueueLibrary(d.libraryId);
      } catch (e) {
        console.error("marker detection enqueue failed:", e);
      }
    }
  });

  // Ensure an access token exists (shown in Settings, required for LAN clients).
  // 16 bytes, not the 4 this used to mint: once remote access is on, the token
  // is the ONLY thing between the internet and the library, and 32 bits can be
  // exhausted in hours. Existing short tokens are upgraded when remote access is
  // switched on (see routes/media.ts) rather than here, so turning it on doesn't
  // silently unpair a phone that was paired by hand.
  if (!getSetting(db, "lanToken")) {
    setSetting(db, "lanToken", crypto.randomBytes(16).toString("hex"));
  }
  const lanEnabled = getSetting(db, "lanEnabled") === "1";

  const app = express();
  app.use(express.json());

  // Renderer runs from file:// (origin "null") — allow it.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Locality-Token, X-Locality-Profile");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Auth: the desktop UI (genuinely local — see isLocalRequest) passes freely;
  // anything else must send the token, either as `X-Locality-Token: <token>` or
  // `?token=<token>` (the query form exists for EventSource/<img>/<video>, which
  // can't set headers).
  //
  // Failed attempts are throttled per client. On the LAN that's belt-and-braces;
  // with the tunnel open it's what stops someone who finds the URL from simply
  // grinding through tokens.
  const MAX_FAILURES = 8;
  const BLOCK_MS = 60_000;
  const FAILURE_WINDOW_MS = 5 * 60_000;
  const MAX_TRACKED = 4096;
  const failures = new Map<string, { count: number; first: number; until: number }>();

  /** Constant-time compare that doesn't leak length via an early return. */
  const tokenMatches = (supplied: string, expected: string) => {
    const a = crypto.createHash("sha256").update(supplied).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  app.use((req, res, next) => {
    if (isLocalRequest(req)) return next();

    const key = clientKey(req);
    const now = Date.now();
    const rec = failures.get(key);
    if (rec && rec.until > now) {
      res.setHeader("Retry-After", Math.ceil((rec.until - now) / 1000));
      return res.status(429).json({ error: "Too many failed attempts. Try again in a minute." });
    }

    const token = getSetting(db, "lanToken") ?? "";
    const supplied = (req.headers["x-locality-token"] as string) ?? (req.query.token as string) ?? "";
    if (token && supplied && tokenMatches(supplied, token)) {
      failures.delete(key);
      return next();
    }

    // Stale entries would otherwise accumulate one per attacking address.
    if (failures.size > MAX_TRACKED) {
      for (const [k, v] of failures) if (v.until < now && now - v.first > FAILURE_WINDOW_MS) failures.delete(k);
      if (failures.size > MAX_TRACKED) failures.clear();
    }
    const cur = rec && now - rec.first < FAILURE_WINDOW_MS ? rec : { count: 0, first: now, until: 0 };
    cur.count++;
    if (cur.count >= MAX_FAILURES) {
      cur.until = now + BLOCK_MS;
      cur.count = 0;
      cur.first = now;
    }
    failures.set(key, cur);
    res.status(401).json({ error: "Missing or wrong access token — see Settings → Remote access on the PC" });
  });

  app.get("/api/events", (_req, res) => events.addClient(res));
  app.use("/api/images", express.static(ctx.imagesDir, { maxAge: "30d", immutable: true }));
  app.use("/api", mediaRoutes(ctx));
  app.use("/api", playerRoutes(ctx));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("API error:", err);
    res.status(500).json({ error: String(err?.message ?? err) });
  });

  const server = http.createServer(app);
  // Loopback + dynamic port normally. LAN mode binds all interfaces on a fixed
  // port so phones can find it. LOCALITY_PORT pins the port (tests/scripts).
  const host = lanEnabled ? "0.0.0.0" : "127.0.0.1";
  const requestedPort =
    Number(process.env.LOCALITY_PORT) || (lanEnabled ? Number(getSetting(db, "lanPort")) || 3777 : 0);
  const listen = (h: string, p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      server.once("error", onError);
      server.listen(p, h, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  let lanActive = lanEnabled;
  let port: number;
  try {
    port = await listen(host, requestedPort);
  } catch (e: any) {
    // A fixed LAN port can be squatted by a leftover instance — don't let that
    // kill startup with a hung splash. Fall back to loopback so the desktop UI
    // still works; the phone just can't connect until the squatter is gone.
    if (lanEnabled && e?.code === "EADDRINUSE") {
      console.error(
        `LAN port ${requestedPort} is already in use — another Locality instance is probably still running ` +
          `(check Task Manager for Locality.exe / electron.exe). Starting WITHOUT remote access on a loopback port.`
      );
      lanActive = false;
      port = await listen("127.0.0.1", 0);
    } else {
      throw e;
    }
  }
  ctx.runtime.lanActive = lanActive;
  ctx.runtime.port = port;
  console.log(`server listening on ${lanActive ? host : "127.0.0.1"}:${port}${lanActive ? " (LAN access enabled)" : ""}`);

  // Remote access. Independent of LAN mode: the tunnel points at loopback, so it
  // works even when the server isn't bound to 0.0.0.0. Started after listen()
  // so it always targets the port we actually got.
  if (getSetting(db, "remoteEnabled") === "1") {
    void ctx.tunnel.enable(port).catch((e) => console.error("remote: enable failed:", e));
  }
  // Re-publish the address book whenever the public URL changes, so the phone
  // follows the tunnel across restarts without anyone typing anything. Keyed on
  // the URL because "remote" also fires for download progress.
  let publishedUrl: string | null = null;
  events.on("remote", (s: any) => {
    const url = s?.state === "online" ? (s.url as string) : null;
    if (url === publishedUrl) return;
    publishedUrl = url;
    void ctx.cloud.publishServer();
  });

  return {
    port,
    ctx,
    async close() {
      ctx.watcher.stop();
      ctx.tunnel.stop();
      ctx.cloud.stop();
      ctx.party.stop();
      ctx.ledger.stop();
      // closeAllConnections drops open SSE streams — without it close() waits forever.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
