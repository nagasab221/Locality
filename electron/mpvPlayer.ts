// Phase 0 spike: drive a real mpv process embedded in the Electron window.
//
// Why mpv: Chromium's <video> is a narrow media pipeline (codec gaps, flaky
// seeking on re-muxed/VFR files). mpv uses ffmpeg for demux/decode, so it plays
// essentially anything and seeks frame-accurately — the desktop equivalent of
// ExoPlayer on Android. This module is the foundation; the React player is not
// wired to it yet. It's controlled over mpv's JSON IPC (newline-delimited JSON).
//
// Embedding: mpv is spawned with --wid=<HWND> so it renders INTO our window.
// This is Windows-first (named pipe + HWND). macOS/Linux need the NSView/X11
// equivalents and a unix socket, handled later.
import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";

/** mpv executable name for this platform. */
const MPV_BIN = process.platform === "win32" ? "mpv.exe" : "mpv";

/**
 * Whether we can embed mpv into the app window on this platform. Windows (HWND)
 * and Linux/X11 (XID) support `--wid` embedding; Wayland does not (no global
 * window ids), and macOS embedding isn't implemented. Used to decide the default
 * playback engine and whether to disable GPU compositing.
 */
export function mpvEmbedSupported(): boolean {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return process.env.XDG_SESSION_TYPE !== "wayland" && !process.env.WAYLAND_DISPLAY;
  return false;
}

/**
 * Locate an mpv binary. Preference: an explicit user setting, then the copy
 * BUNDLED with the app (Windows only, so end users never install mpv), then a
 * drop-in in the app's data dir, then PATH. On Linux/macOS there's no bundle, so
 * this resolves the system mpv (install via the package manager). `bundledPath`
 * is resolved by the caller because it differs between a dev run and a build.
 */
export function findMpv(dataDir: string, configuredPath?: string, bundledPath?: string): string {
  const candidates = [
    configuredPath,
    bundledPath,
    path.join(dataDir, "bin", MPV_BIN),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Search PATH. Node's spawn on Windows won't apply PATHEXT to a bare "mpv", so
  // a scoop/choco install needs the full path; on Linux the system mpv is here.
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, MPV_BIN))) return path.join(dir, MPV_BIN);
  }
  return MPV_BIN; // last resort; spawn ENOENT is caught and surfaced
}

/** Read the native window id out of BrowserWindow.getNativeWindowHandle(). */
function widFromHandle(handle: Buffer): string {
  // Windows HWND and X11 Window are both pointer/long-sized; the value sits in
  // the low bytes on 64-bit, so a little-endian read of the whole buffer yields
  // the HWND (Windows) or XID (X11) that mpv's --wid expects.
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
}

interface MpvEvents {
  /** A watched property changed (time-pos, duration, pause, …). */
  prop: (name: string, value: unknown) => void;
  /** Playback reached the end of the current file. */
  ended: () => void;
  /** The mpv process exited (crash or stop). */
  exit: (code: number | null) => void;
  /** Non-fatal diagnostic for the UI/log. */
  error: (message: string) => void;
  /** Double-click in the video: toggle the app window's fullscreen. */
  toggleFullscreen: () => void;
}

export declare interface MpvPlayer {
  on<E extends keyof MpvEvents>(event: E, listener: MpvEvents[E]): this;
  emit<E extends keyof MpvEvents>(event: E, ...args: Parameters<MpvEvents[E]>): boolean;
}

export class MpvPlayer extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private pipePath = "";
  private reqId = 1;
  private rxBuf = "";
  private starting: Promise<void> | null = null;
  private pending = new Map<number, (msg: any) => void>();
  // loadfile arg order changed in newer mpv (added an <index> before <options>).
  // Assume the new layout; fall back to the old one if a load is rejected.
  private modernLoadfile = true;

  get running(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /** Spawn mpv embedded in `handle`, ready to accept loadfile over IPC. */
  async start(bin: string, handle: Buffer, logFile?: string): Promise<void> {
    if (this.starting) return this.starting;
    if (this.running) return;
    this.starting = this.spawn(bin, handle, logFile).finally(() => (this.starting = null));
    return this.starting;
  }

  private async spawn(bin: string, handle: Buffer, logFile?: string): Promise<void> {
    // mpv's JSON IPC endpoint: a named pipe on Windows, a Unix domain socket
    // elsewhere. net.connect() speaks both.
    this.pipePath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\mpv-locality-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `mpv-locality-${process.pid}-${Date.now()}.sock`);
    const wid = widFromHandle(handle);
    const args = [
      `--wid=${wid}`,
      `--input-ipc-server=${this.pipePath}`,
      "--no-config", // ignore the user's global mpv config
      "--idle=yes", // stay alive with no file so we can loadfile over IPC
      "--force-window=yes",
      "--keep-open=yes", // pause on the last frame at EOF; we detect it and advance
      "--osc=no", // we draw our own control bar; mpv's OSC must not pop up when we feed it mouse motion
      "--hwdec=auto-safe", // hardware decode where the GPU supports it
      "--volume-max=200", // allow boosting past 100% (VLC-style); the UI slider matches
      "--cursor-autohide=2800", // hide the cursor over the video after this idle (armed by injected mouse motion)
      "--terminal=no",
      "--load-scripts=no",
      "--msg-level=all=v", // verbose, so the log file explains embedding/decode
      ...(logFile ? [`--log-file=${logFile}`] : []),
      // mpv handles its own keyboard/mouse for now (default bindings + OSC).
    ];
    console.log(`mpv: spawning ${bin} wid=${wid} ipc=${this.pipePath}${logFile ? ` log=${logFile}` : ""}`);

    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.proc = proc;
    let stderrTail = "";
    proc.stderr?.on("data", (c: Buffer) => {
      const s = c.toString();
      stderrTail = (stderrTail + s).slice(-1000);
      console.error("mpv stderr:", s.trim());
    });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      console.error("mpv spawn error:", e);
      this.emit("error", e.code === "ENOENT" ? "mpv binary not found" : String(e.message));
    });
    proc.on("exit", (code) => {
      console.log(`mpv: process exited (code ${code})`);
      this.cleanup();
      this.emit("exit", code);
      if (code && stderrTail) console.error(`mpv exited ${code}: ${stderrTail}`);
    });

    await this.connect();
    console.log("mpv: IPC connected");
    // Watch the properties the UI needs; ids are arbitrary but stable.
    for (const [id, name] of [
      [1, "time-pos"],
      [2, "duration"],
      [3, "pause"],
      [4, "eof-reached"],
      [5, "volume"],
      [6, "track-list"],
      [7, "speed"],
      [8, "audio-device"],
      [9, "audio-device-list"],
      [10, "chapter-list"],
      [11, "mute"],
    ] as const) {
      this.send(["observe_property", id, name]);
    }
    // Esc quits (returns to the app); q is already bound to quit by default.
    this.send(["keybind", "ESC", "quit"]);
    // Double-click toggles the app window's fullscreen (relayed to Electron).
    this.send(["keybind", "MBTN_LEFT_DBL", "script-message locality-toggle-fs"]);
  }

  /** mpv creates the pipe shortly after launch — retry until it's connectable. */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const attempt = () => {
        const sock = net.connect(this.pipePath);
        sock.on("connect", () => {
          this.sock = sock;
          sock.on("data", (c) => this.onData(c));
          sock.on("error", () => {});
          resolve();
        });
        sock.on("error", () => {
          sock.destroy();
          if (Date.now() > deadline) {
            console.error("mpv: IPC pipe never came up within 5s");
            reject(new Error("mpv IPC pipe never came up"));
          } else setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  private onData(chunk: Buffer) {
    this.rxBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.rxBuf.indexOf("\n")) >= 0) {
      const line = this.rxBuf.slice(0, nl).trim();
      this.rxBuf = this.rxBuf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Command responses (no "event", carry request_id + error) go to any
      // waiting caller; everything else is an async event.
      if (msg.event === undefined && msg.request_id !== undefined) {
        const cb = this.pending.get(msg.request_id);
        if (cb) {
          this.pending.delete(msg.request_id);
          cb(msg);
        }
        continue;
      }
      if (msg.event === "property-change") {
        if (msg.name === "eof-reached" && msg.data === true) this.emit("ended");
        else this.emit("prop", msg.name, msg.data);
      } else if (msg.event === "end-file" && msg.reason === "eof") {
        // Only a natural end advances. reason "quit"/"stop" (our exit) must NOT
        // fire "ended" — that was advancing to the next episode on Esc/q.
        this.emit("ended");
      } else if (msg.event === "client-message" && Array.isArray(msg.args) && msg.args.includes("locality-toggle-fs")) {
        this.emit("toggleFullscreen");
      }
    }
  }

  /** Send a raw mpv IPC command array, e.g. ["seek", 30, "absolute"]. An optional
   *  callback receives the command's response (for the rare case we care). */
  send(command: unknown[], onResponse?: (msg: any) => void): void {
    if (!this.sock) return;
    const id = this.reqId++;
    if (onResponse) this.pending.set(id, onResponse);
    try {
      this.sock.write(JSON.stringify({ command, request_id: id }) + "\n");
    } catch {
      this.pending.delete(id);
      /* socket gone; exit handler will fire */
    }
  }

  loadFile(url: string, startSec = 0, subsOff = false): void {
    console.log(`mpv: loadfile ${url} (start=${Math.floor(startSec)}${subsOff ? " subs-off" : ""})`);
    const opts: string[] = [];
    if (startSec > 0) opts.push(`start=${Math.floor(startSec)}`);
    if (subsOff) opts.push("sid=no"); // the user's saved preference is "no subtitles"
    this.sendLoadfile(url, opts.join(","));
  }

  /**
   * loadfile's argument order differs by mpv version: newer builds are
   * `loadfile <url> <flags> <index> <options>` (per-load options like start=/sid=
   * in the 5th slot), older ones are `loadfile <url> <flags> <options>` (4th).
   * The bundled Windows mpv is new; distro mpv (e.g. Linux) may be old. We try
   * the new layout and, if that mpv rejects it, remember and resend the old one.
   */
  private sendLoadfile(url: string, optStr: string): void {
    if (!optStr) {
      this.send(["loadfile", url, "replace"]);
      return;
    }
    if (this.modernLoadfile) {
      this.send(["loadfile", url, "replace", -1, optStr], (msg) => {
        if (msg?.error && msg.error !== "success") {
          this.modernLoadfile = false;
          this.send(["loadfile", url, "replace", optStr]); // older mpv layout
        }
      });
    } else {
      this.send(["loadfile", url, "replace", optStr]);
    }
  }
  setPause(paused: boolean): void {
    this.send(["set_property", "pause", paused]);
  }
  seekAbsolute(sec: number): void {
    this.send(["seek", sec, "absolute"]);
  }
  setVolume(v0to100: number): void {
    this.send(["set_property", "volume", Math.max(0, Math.min(100, v0to100))]);
  }
  setSpeed(rate: number): void {
    this.send(["set_property", "speed", rate]);
  }

  stop(): void {
    this.send(["quit"]);
    setTimeout(() => this.proc?.kill(), 300); // force if quit didn't take
  }

  private cleanup() {
    this.sock?.destroy();
    this.sock = null;
    this.proc = null;
    this.pending.clear();
  }
}
