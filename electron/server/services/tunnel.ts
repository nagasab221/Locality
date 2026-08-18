// Internet access via a Cloudflare quick tunnel.
//
// Why a tunnel rather than port forwarding: the connection is OUTBOUND, so it
// works behind carrier-grade NAT and needs no router config, no public IP and
// no certificate work — Cloudflare terminates TLS at its edge and hands us a
// https://<name>.trycloudflare.com URL.
//
// The URL is ephemeral: a new one is minted every time cloudflared starts. That
// is fine here because nobody types it — cloudSync publishes it to the account's
// `servers` row and the phone picks up whatever is current.
//
// SECURITY: cloudflared connects to us over loopback, so requests arriving
// through it look local at the socket level. The auth middleware in index.ts
// must NOT rely on the socket address alone — see requestOrigin.ts.
import { spawn, execFileSync, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { appFetch } from "./http";
import { events } from "./events";

/** Official builds only. GitHub's `latest` redirect keeps this from going stale. */
const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
/** cloudflared is ~35 MB; anything much smaller is a truncated or error download. */
const MIN_BINARY_BYTES = 5 * 1024 * 1024;
/** How long to wait for the quick-tunnel banner before assuming the protocol is blocked. */
const URL_TIMEOUT_MS = 35_000;
/** Backoff between restart attempts after an unexpected exit. */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

export type TunnelState = "off" | "downloading" | "starting" | "online" | "error";

export interface TunnelStatus {
  enabled: boolean;
  state: TunnelState;
  /** Public https URL once the tunnel is up. */
  url: string | null;
  error: string | null;
  /** 0-100 while fetching cloudflared, else null. */
  downloadPercent: number | null;
}

/**
 * Pull the quick-tunnel URL out of cloudflared's log output. It arrives inside
 * a boxed banner on stderr, one field of a multi-line INF block:
 *
 *   2026-07-20T09:12:31Z INF +----------------------------------------------+
 *   2026-07-20T09:12:31Z INF |  Your quick Tunnel has been created! ...      |
 *   2026-07-20T09:12:31Z INF |  https://tan-river-8823.trycloudflare.com     |
 *
 * Exported so a test can pin it: if the banner format shifts and this stops
 * matching, remote access fails with no error, just a tunnel that never reports
 * a URL.
 */
export function parseTunnelUrl(text: string): string | null {
  const m = text.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/** cloudflared's asset name for this machine. */
function assetName(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : "amd64";
  if (process.platform === "win32") return `cloudflared-windows-${arch}.exe`;
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`;
  return `cloudflared-linux-${arch}`;
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private state: TunnelState = "off";
  private url: string | null = null;
  private error: string | null = null;
  private downloadPercent: number | null = null;
  private enabled = false;
  private port = 0;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private urlTimer: NodeJS.Timeout | null = null;
  /** QUIC is blocked on some networks; the second attempt falls back to http2. */
  private useHttp2 = false;
  private downloading: Promise<string> | null = null;

  constructor(private dataDir: string) {}

  private get binaryPath(): string {
    const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    return path.join(this.dataDir, "bin", exe);
  }

  private get pidPath(): string {
    return path.join(this.dataDir, "bin", "cloudflared.pid");
  }

  /**
   * Kill a cloudflared left behind by a previous run. Locality has a long
   * history of being force-quit from Task Manager, and a child process doesn't
   * die with its parent on Windows — the orphan would sit there holding a tunnel
   * that routes to a port nobody is listening on any more.
   *
   * The image name is checked before killing: Windows recycles PIDs, and a stale
   * pidfile must never take out an unrelated process.
   */
  private killOrphan() {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(this.pidPath, "utf8").trim());
    } catch {
      return; // no pidfile: clean shutdown last time
    }
    try {
      if (pid > 0 && this.isCloudflared(pid)) {
        process.kill(pid);
        console.log(`remote: cleaned up an orphaned cloudflared (pid ${pid})`);
      }
    } catch {
      /* already gone */
    }
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      /* best effort */
    }
  }

  private isCloudflared(pid: number): boolean {
    try {
      if (process.platform === "win32") {
        const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          timeout: 4000,
          windowsHide: true,
        });
        return /^"cloudflared\.exe"/i.test(out.trim());
      }
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 4000 });
      return out.trim().endsWith("cloudflared");
    } catch {
      return false;
    }
  }

  getStatus(): TunnelStatus {
    return {
      enabled: this.enabled,
      state: this.state,
      url: this.url,
      error: this.error,
      downloadPercent: this.downloadPercent,
    };
  }

  /** Public URL when the tunnel is actually up, else null. */
  publicUrl(): string | null {
    return this.state === "online" ? this.url : null;
  }

  private set(state: TunnelState, patch?: Partial<Pick<TunnelStatus, "url" | "error" | "downloadPercent">>) {
    this.state = state;
    if (patch && "url" in patch) this.url = patch.url ?? null;
    if (patch && "error" in patch) this.error = patch.error ?? null;
    this.downloadPercent = patch?.downloadPercent ?? null;
    events.broadcast("remote", this.getStatus());
  }

  // ---- binary ---------------------------------------------------------------

  private hasBinary(): boolean {
    try {
      return fs.statSync(this.binaryPath).size >= MIN_BINARY_BYTES;
    } catch {
      return false;
    }
  }

  /**
   * Fetch cloudflared into <dataDir>/bin on first use. Goes through appFetch so
   * it honours the system proxy like every other outbound request in this app.
   */
  private async ensureBinary(): Promise<string> {
    if (this.hasBinary()) return this.binaryPath;
    if (this.downloading) return this.downloading;
    if (process.platform !== "win32" && process.platform !== "linux") {
      throw new Error(
        `Locality can't fetch cloudflared automatically on ${process.platform}. Install it yourself and put it in ${path.dirname(this.binaryPath)}`
      );
    }

    this.downloading = (async () => {
      const url = `${RELEASE_BASE}/${assetName()}`;
      this.set("downloading", { downloadPercent: 0 });
      const res = await appFetch(url);
      if (!res.ok) throw new Error(`Downloading cloudflared failed (${res.status} from ${url})`);

      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Downloading cloudflared failed (empty response)");

      const chunks: Buffer[] = [];
      let got = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
        // Broadcasting every chunk would flood the SSE stream.
        if (total && Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          this.set("downloading", { downloadPercent: Math.round((got / total) * 100) });
        }
      }

      const buf = Buffer.concat(chunks);
      if (buf.length < MIN_BINARY_BYTES) throw new Error(`Downloaded cloudflared looks truncated (${buf.length} bytes)`);

      fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
      // Write beside the target and rename, so a half-written file can never be
      // mistaken for a usable binary by the next launch.
      const tmp = `${this.binaryPath}.part`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, this.binaryPath);
      if (process.platform !== "win32") fs.chmodSync(this.binaryPath, 0o755);
      console.log(`remote: downloaded cloudflared (${(buf.length / 1e6).toFixed(1)} MB)`);
      return this.binaryPath;
    })();

    try {
      return await this.downloading;
    } finally {
      this.downloading = null;
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Turn remote access on. Safe to call repeatedly; only the port matters. */
  async enable(port: number): Promise<TunnelStatus> {
    if (this.enabled && this.port === port && (this.state === "online" || this.state === "starting")) {
      return this.getStatus();
    }
    this.stopProcess();
    this.enabled = true;
    this.port = port;
    this.attempt = 0;
    this.useHttp2 = false;
    void this.spawnTunnel();
    return this.getStatus();
  }

  disable(): TunnelStatus {
    this.enabled = false;
    this.stopProcess();
    this.set("off", { url: null, error: null });
    return this.getStatus();
  }

  /** Kill the child and clear timers without changing `enabled`. */
  private stopProcess() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.retryTimer = null;
    this.urlTimer = null;
    const c = this.child;
    this.child = null;
    if (c) {
      c.removeAllListeners();
      try {
        c.kill();
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(this.pidPath); // shut down cleanly: nothing to clean up later
      } catch {
        /* best effort */
      }
    }
  }

  private async spawnTunnel() {
    if (!this.enabled) return;
    let bin: string;
    try {
      bin = await this.ensureBinary();
    } catch (e: any) {
      this.set("error", { error: String(e?.message ?? e) });
      console.error("remote:", this.error);
      return this.scheduleRetry();
    }
    if (!this.enabled) return; // disabled while downloading

    this.set("starting", { url: null });
    const args = [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${this.port}`,
      ...(this.useHttp2 ? ["--protocol", "http2"] : []),
    ];
    this.killOrphan();
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    try {
      if (child.pid) fs.writeFileSync(this.pidPath, String(child.pid));
    } catch {
      /* only affects orphan cleanup next launch */
    }

    const onOutput = (buf: Buffer) => {
      const text = buf.toString();
      const found = parseTunnelUrl(text);
      if (found && this.child === child) void this.onUrl(found);
      // cloudflared is chatty at INF; only surface real problems.
      for (const line of text.split(/\r?\n/)) {
        if (/\bERR\b|\bFTL\b/.test(line)) console.error("cloudflared:", line.trim());
      }
    };
    child.stderr?.on("data", onOutput);
    child.stdout?.on("data", onOutput);

    child.on("error", (e) => {
      if (this.child !== child) return;
      this.set("error", { error: `Couldn't run cloudflared: ${e.message}` });
      this.scheduleRetry();
    });
    child.on("exit", (code) => {
      if (this.child !== child) return; // superseded by a newer spawn
      this.child = null;
      if (!this.enabled) return;
      this.set("error", { error: `cloudflared stopped unexpectedly (exit ${code})` });
      this.scheduleRetry();
    });

    // No banner in time usually means the QUIC transport is blocked.
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.urlTimer = setTimeout(() => {
      if (this.child !== child || this.state === "online") return;
      if (!this.useHttp2) {
        console.log("remote: no tunnel URL yet, retrying over http2");
        this.useHttp2 = true;
        this.stopProcess();
        void this.spawnTunnel();
      } else {
        this.set("error", { error: "Cloudflare didn't hand out a tunnel URL. Check that this PC can reach the internet." });
        this.stopProcess();
        this.scheduleRetry();
      }
    }, URL_TIMEOUT_MS);
  }

  private async onUrl(url: string) {
    if (this.url === url && this.state === "online") return;
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.urlTimer = null;
    this.attempt = 0;
    this.set("online", { url });
    console.log(`remote: tunnel online at ${url}`);
  }

  private scheduleRetry() {
    if (!this.enabled || this.retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.spawnTunnel();
    }, delay);
  }

  /** Called on shutdown — leaving cloudflared running would orphan a process. */
  stop() {
    this.enabled = false;
    this.stopProcess();
  }
}
