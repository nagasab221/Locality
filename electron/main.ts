import { app, BrowserWindow, ipcMain, dialog, shell, net, Tray, Menu } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { startServer, type RunningServer } from "./server";
import { getSetting } from "./server/db";
import { setFetchImpl } from "./server/services/http";
import { MpvPlayer, findMpv, mpvEmbedSupported } from "./mpvPlayer";

/**
 * Mirror all console output (and crashes) into <dataDir>/locality.log so
 * problems are diagnosable without a terminal attached.
 */
function setupFileLogging(dataDir: string): string {
  const logPath = path.join(dataDir, "locality.log");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // Simple rotation: keep one previous generation.
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
      const old = logPath + ".old";
      if (fs.existsSync(old)) fs.unlinkSync(old);
      fs.renameSync(logPath, old);
    }
  } catch {
    /* logging must never break the app */
  }
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  // A write stream with no error handler turns any file hiccup (lock, disk)
  // into a process-killing uncaughtException loop — swallow instead.
  stream.on("error", () => {});
  const fmt = (a: unknown): string => {
    if (a instanceof Error) return a.stack ?? String(a);
    if (typeof a === "object" && a !== null) {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a);
  };
  const wrap = (orig: (...args: any[]) => void, level: string) =>
    (...args: any[]) => {
      orig(...args);
      try {
        stream.write(`[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(" ")}\n`);
      } catch {}
    };
  console.log = wrap(console.log.bind(console), "info");
  console.warn = wrap(console.warn.bind(console), "warn");
  console.error = wrap(console.error.bind(console), "error");
  process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
  return logPath;
}

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Experimental mpv playback engine (Phase 0 spike). Lazily created. */
let mpv: MpvPlayer | null = null;
/** Reskinned mpv overlay: one full-screen, transparent, on-top window over the
 * video (mpv paints above the DOM, so the controls can't live in the page). It
 * holds the top bar + bottom bar and handles its own show/hide + cursor hiding. */
let overlayWin: BrowserWindow | null = null;
/** File currently playing in mpv — the subtitle search needs it. */
let currentMpvFileId: number | null = null;
/** Title + whether a next episode exists, shown in the overlay. */
let currentMpvTitle = "";
let currentMpvHasNext = false;
/** OpenSubtitles search dialog: a separate centered window over the video. */
let subSearchWin: BrowserWindow | null = null;
/** True while running headless from the tray: closing the window doesn't quit. */
let serverOnlyMode = process.argv.includes("--server-only");

// Pin the identity and data location no matter how the app is launched.
// The folder name is deliberately NOT plain "Locality": other Locality
// implementations on this machine (an OpenCode-built fork and a synced copy
// of this project) use %APPDATA%\Locality and repeatedly clobbered each
// other's database, artwork cache, and logs. This copy owns its own dir.
app.setName("Locality");
app.setPath("userData", path.join(app.getPath("appData"), "Locality (Claude)"));

// Hardware-accelerated video for the embedded player. GPU compositing is on by
// default; these opt Chromium into platform HEVC/AV1 hardware decoders where the
// GPU + OS support them (they no-op otherwise). Without a hardware decoder the
// player falls back to the server's ffmpeg transcode path.
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCDecoderSupport,AcceleratedVideoDecodeLinuxGL"
);
// The embedded mpv player renders into a native child window. Chromium's default
// GPU compositor (DirectComposition on Windows) draws the page ABOVE any native
// child window, which hid mpv entirely. Disabling GPU *compositing* (decode and
// rasterization stay on the GPU) lets the native mpv surface show through. Small
// cost to page-compositing smoothness; only meaningful because we embed mpv, so
// scope it to platforms where mpv actually embeds (Windows + Linux/X11). Other
// platforms use the built-in player and want normal GPU compositing.
if (mpvEmbedSupported()) app.commandLine.appendSwitch("disable-gpu-compositing");
// Deep media buffering (a ~1 GB in-RAM media cache) makes seeking feel instant
// but is memory-hungry, so only opt in when the machine has the RAM to spare.
// os.totalmem() reports a bit under the installed amount (hardware-reserved),
// so 8 GB sticks land around 7.6-8.0 GiB; the 7.5 GiB gate keeps those in while
// excluding 4/6 GB machines. Below it, Chromium's small default cache is used.
const totalGiB = os.totalmem() / 1024 ** 3;
if (totalGiB >= 7.5) {
  app.commandLine.appendSwitch("media-cache-size", "1073741824"); // 1 GB in RAM
  app.commandLine.appendSwitch("disk-cache-size", "2147483648"); // 2 GB on disk
  console.log(`deep media buffering: ON (${totalGiB.toFixed(1)} GiB RAM)`);
} else {
  console.log(`deep media buffering: OFF (${totalGiB.toFixed(1)} GiB RAM, under 8 GB)`);
}

const SMOKE = process.env.LOCALITY_SMOKE === "1";

// One Locality per data dir: a second launch opens the existing instance's
// window instead of fighting over port 3777 (a frozen leftover once squatted
// the port and every relaunch looked crashed). Test/smoke sessions run beside
// the real app on purpose, so they skip the lock.
const IS_TEST_SESSION = SMOKE || !!process.env.LOCALITY_TEST_DATA_DIR;
/** True when another copy already owns the lock: this process exists only to
 *  hand the launch over to that one, and must not boot anything of its own. */
let handedOffToPrimary = false;
if (!IS_TEST_SESSION) {
  if (!app.requestSingleInstanceLock()) {
    handedOffToPrimary = true;
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } else {
        void createMainWindow();
      }
    });
  }
}

// Dev runs pick up the generated icon from the repo; packaged builds use the
// icon embedded in the exe by electron-builder.
const APP_ICON = path.join(__dirname, "..", "..", "assets", "icon.ico");

// Frameless splash shown while the server boots. Inlined as a data URL so it
// needs no extra build/copy step and appears instantly.
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:"Palatino Linotype",Palatino,Georgia,serif;-webkit-user-select:none;cursor:default}
  .card{position:absolute;inset:10px;background:#0D0D0D;border:1px solid #2A2620;
    border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  svg{width:64px;height:64px;opacity:0;animation:pop .5s ease-out forwards}
  .name{display:flex;font-size:44px;color:#F4EEE0}
  .name span{opacity:0;transform:translateY(16px);animation:rise .45s cubic-bezier(.16,1,.3,1) forwards}
  .bar{width:130px;height:2px;background:linear-gradient(90deg,#C4A47C,#D5B78D);border-radius:1px;
    transform:scaleX(0);animation:sweep .5s .85s ease-out forwards,pulse 1.6s 1.5s ease-in-out infinite}
  .sub{font-family:"Segoe UI",sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;
    color:#8C8478;opacity:0;animation:fadein .6s 1.05s ease-out forwards}
  @keyframes rise{to{opacity:1;transform:none}}
  @keyframes pop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
  @keyframes sweep{to{transform:scaleX(1)}}
  @keyframes fadein{to{opacity:1}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
</style></head><body><div class="card">
  <svg viewBox="0 0 512 512"><path d="M256 104 L448 296 L400 296 L256 152 L112 296 L64 296 Z" fill="#C4A47C"/><path d="M136 292 L256 172 L376 292 L376 396 Q376 416 356 416 L156 416 Q136 416 136 396 Z" fill="#C4A47C"/><path d="M222 268 L318 322 L222 376 Z" fill="#0D0D0D"/></svg>
  <div class="name">${"Locality"
    .split("")
    .map((c, i) => `<span style="animation-delay:${(0.15 + i * 0.07).toFixed(2)}s">${c}</span>`)
    .join("")}</div>
  <div class="bar"></div>
  <div class="sub">local media server</div>
</div></body></html>`;

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: { contextIsolation: true },
  });
  void splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SPLASH_HTML));
  return splash;
}

async function startApp() {
  // TEST-prefixed env overrides let automated tests run against isolated data
  // instead of the real library DB and the real Documents/Locality ledger.
  // (Deliberately awkward names — a leftover variable in a reused shell once
  // silently pointed a real session at disposable test folders.)
  const dataDir = process.env.LOCALITY_TEST_DATA_DIR || app.getPath("userData");
  const logPath = setupFileLogging(dataDir);
  console.log(
    `Locality ${app.getVersion()} starting${serverOnlyMode ? " (server only)" : ""} — dataDir=${dataDir}, log=${logPath}`
  );

  const splashShownAt = Date.now();
  const splash: BrowserWindow | null = SMOKE || serverOnlyMode ? null : createSplash();

  // Route metadata/image downloads through Chromium's network stack so they
  // respect system proxy/VPN settings (Node's fetch ignores them).
  setFetchImpl((input, init) => net.fetch(String(input), init as any));

  server = await startServer({
    dataDir,
    documentsDir: process.env.LOCALITY_TEST_DOCS_DIR || app.getPath("documents"),
    appVersion: app.getVersion(),
    logPath,
  });

  applyAutostartFromSettings();

  if (SMOKE) {
    console.log("SMOKE_OK port=" + server.port);
    setTimeout(() => app.quit(), 500);
    return;
  }

  createTray();
  if (serverOnlyMode) {
    console.log("running in the tray — right-click the icon for options");
  } else {
    await createMainWindow(splash, splashShownAt);
  }
}

/** Create (or re-focus) the main UI window. Reused by the tray and second launches. */
async function createMainWindow(splash: BrowserWindow | null = null, splashShownAt = 0) {
  if (!server) return;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0D0D0D",
    autoHideMenuBar: true,
    title: "Locality",
    show: false, // revealed when ready (splash covers the gap)
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on("closed", () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(`${devUrl}?port=${server.port}`);
  } else {
    await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
      query: { port: String(server.port) },
    });
  }

  // Let the splash animation finish even when startup is instant.
  const MIN_SPLASH_MS = 1800;
  const reveal = () => {
    if (splash && !splash.isDestroyed()) splash.close();
    if (win && !win.isDestroyed()) win.show();
  };
  if (splash) setTimeout(reveal, Math.max(0, MIN_SPLASH_MS - (Date.now() - splashShownAt)));
  else reveal();
}

// ---- tray / server-only mode --------------------------------------------------

function createTray() {
  if (tray) return;
  if (!fs.existsSync(APP_ICON)) return; // no icon asset — run without a tray
  tray = new Tray(APP_ICON);
  tray.setToolTip("Locality — media server");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Locality", click: () => void createMainWindow() },
      { label: "Server only (close window)", click: enterServerMode },
      { type: "separator" },
      { label: "Quit Locality", click: () => app.quit() },
    ])
  );
  tray.on("double-click", () => void createMainWindow());
}

function enterServerMode() {
  serverOnlyMode = true;
  if (win && !win.isDestroyed()) win.close();
  try {
    tray?.displayBalloon({
      title: "Locality is still running",
      content: "Serving your library from the tray. Right-click the icon to open or quit.",
      iconType: "info",
    });
  } catch {
    /* balloons are Windows-only decoration */
  }
}

/** Autostart writes a registry Run entry — only meaningful for the installed exe. */
function applyAutostart(enabled: boolean) {
  if (!app.isPackaged) return;
  // setLoginItemSettings is implemented on Windows and macOS only. On Linux it's
  // a no-op in Electron (autostart there is a ~/.config/autostart .desktop file);
  // skip it so the Settings toggle is simply inert rather than throwing.
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ["--server-only"] });
}

function applyAutostartFromSettings() {
  try {
    const v = server ? getSetting(server.ctx.db, "startWithWindows") : null;
    if (v === "1" || v === "0") applyAutostart(v === "1");
  } catch {
    /* setting not present yet */
  }
}

ipcMain.handle("choose-folder", async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("choose-file", async (_e, filters: { name: string; extensions: string[] }[]) => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("show-in-folder", (_e, p: string) => shell.showItemInFolder(p));

ipcMain.handle("enter-server-mode", () => enterServerMode());

ipcMain.handle("set-autostart", (_e, enabled: boolean) => applyAutostart(!!enabled));

// ---- experimental mpv playback -----------------------------------------------
// mpv is embedded in the main window and renders ABOVE the web page, so the
// reskinned controls live in a full-screen transparent on-top window (overlayWin)
// over the video. mpv property updates are relayed to it and the main window.

/** Relay an mpv event to the main window and the overlay. */
function broadcastMpv(payload: unknown) {
  win?.webContents.send("mpv:event", payload);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send("mpv:event", payload);
}

/** Locality is the active app (its main window or the overlay is focused). */
function appActive(): boolean {
  return !!((win && !win.isDestroyed() && win.isFocused()) || (overlayWin && !overlayWin.isDestroyed() && overlayWin.isFocused()));
}
/** Keep the overlay sized to the video — it's a full-screen transparent layer. */
function positionOverlay() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = win.getContentBounds();
  overlayWin.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
}
// Reposition the overlay and tell it the fullscreen state (for its icon). Two
// explicit handlers, not one that reads isFullScreen() — at event-fire time that
// query returns the *old* value on Windows, which flipped the icon the wrong way.
function onEnterFull() {
  positionOverlay();
  broadcastMpv({ type: "fullscreen", value: true });
}
function onLeaveFull() {
  positionOverlay();
  broadcastMpv({ type: "fullscreen", value: false });
}
/**
 * The mpv overlay: one full-screen, transparent, non-focusable, on-top window
 * over the video. It renders the top + bottom bars and manages its own show/hide
 * and cursor hiding in the renderer (reliable DOM mouse events, since the layer
 * covers the whole video). Non-focusable so it never pulls the foreground off
 * the fullscreen window — which would pop the taskbar back up.
 */
/** Load (or reload) the overlay window with the current episode's params. */
function loadOverlay(w: BrowserWindow) {
  const q = { port: String(server!.port), overlay: "mpvoverlay", title: currentMpvTitle, hasnext: currentMpvHasNext ? "1" : "", file: String(currentMpvFileId ?? "") };
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void w.loadURL(`${devUrl}?${new URLSearchParams(q)}`);
  else void w.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: q });
}
function openControls() {
  if (!win || !server) return;
  if (overlayWin && !overlayWin.isDestroyed()) {
    // Episode change: reload the existing window with the new params (keeping its
    // focus + cursor state) rather than recreating it.
    loadOverlay(overlayWin);
    showOverlay();
    return;
  }
  overlayWin = new BrowserWindow({
    parent: win,
    // Focusable (unlike a bar-only overlay) so Chromium actually applies our
    // cursor:none — a non-focused transparent window ignores cursor changes. It
    // covers the whole video, so a focused full-screen window keeps the taskbar
    // hidden; the thin-bar taskbar problem doesn't apply here.
    focusable: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  overlayWin.setMenuBarVisibility(false);
  loadOverlay(overlayWin);
  overlayWin.once("ready-to-show", () => {
    showOverlay();
    overlayWin?.focus(); // take focus so cursor:none is honored (see focusable note)
  });
  overlayWin.on("focus", refreshControlsVisibility);
  overlayWin.on("blur", refreshControlsVisibility);
  overlayWin.on("closed", () => (overlayWin = null));
  win.on("move", positionOverlay);
  win.on("resize", positionOverlay);
  win.on("enter-full-screen", onEnterFull);
  win.on("leave-full-screen", onLeaveFull);
  win.on("focus", refreshControlsVisibility);
  win.on("blur", refreshControlsVisibility);
  win.on("minimize", refreshControlsVisibility);
  win.on("restore", refreshControlsVisibility);
}
/** Show the overlay window (only while Locality is the active app). */
function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !appActive()) return;
  positionOverlay();
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}
function closeControls() {
  if (win && !win.isDestroyed()) {
    win.off("move", positionOverlay);
    win.off("resize", positionOverlay);
    win.off("enter-full-screen", onEnterFull);
    win.off("leave-full-screen", onLeaveFull);
    win.off("focus", refreshControlsVisibility);
    win.off("blur", refreshControlsVisibility);
    win.off("minimize", refreshControlsVisibility);
    win.off("restore", refreshControlsVisibility);
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
}

/** Let the user pick a local subtitle file and load it into mpv. */
async function addSubtitleFile() {
  if (!win || !mpv) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Add subtitle file",
    filters: [{ name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt", "sub"] }],
    properties: ["openFile"],
  });
  const file = r.filePaths?.[0];
  if (r.canceled || !file) return;
  mpv.send(["sub-add", file, "select"]); // mpv reads the file directly
}

/**
 * OpenSubtitles search. mpv paints over the main window's DOM, so the dialog
 * can't live there — it gets its own centered window that reuses the server's
 * existing os-search/os-download routes and loads the result into mpv over IPC.
 */
function openSubSearch() {
  if (!win || !server || currentMpvFileId == null) return;
  if (subSearchWin && !subSearchWin.isDestroyed()) {
    subSearchWin.focus();
    return;
  }
  const b = win.getContentBounds();
  const w = 620;
  const h = 560;
  subSearchWin = new BrowserWindow({
    parent: win,
    x: Math.round(b.x + (b.width - w) / 2),
    y: Math.round(b.y + (b.height - h) / 2),
    width: w,
    height: h,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0D0D0D",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  subSearchWin.setMenuBarVisibility(false);
  const q = { port: String(server.port), overlay: "subsearch", file: String(currentMpvFileId) };
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void subSearchWin.loadURL(`${devUrl}?${new URLSearchParams(q)}`);
  else void subSearchWin.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: q });
  subSearchWin.once("ready-to-show", () => subSearchWin?.show());
  subSearchWin.on("closed", () => (subSearchWin = null));
}
function closeSubSearch() {
  if (subSearchWin && !subSearchWin.isDestroyed()) subSearchWin.close();
  subSearchWin = null;
}

// The overlay is always-on-top so it sits above the embedded mpv surface, but
// that also floats it over OTHER apps. So show it only while Locality is the
// active app, and hide it the moment focus leaves. The short defer lets focus
// settle first (creating/showing the overlay briefly perturbs it).
function refreshControlsVisibility() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  setTimeout(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (appActive()) showOverlay();
    else overlayWin.hide();
  }, 80);
}

function ensureMpv(): MpvPlayer {
  if (mpv) return mpv;
  mpv = new MpvPlayer();
  // The overlay renders its own controls from these; track-list feeds its themed
  // subtitle/audio menus, pause keeps the bar up (handled in the renderer).
  mpv.on("prop", (name, value) => broadcastMpv({ type: "prop", name, value }));
  mpv.on("ended", () => broadcastMpv({ type: "ended" }));
  mpv.on("error", (message) => broadcastMpv({ type: "error", message }));
  mpv.on("toggleFullscreen", () => {
    if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
  });
  mpv.on("exit", (code) => {
    broadcastMpv({ type: "exit", code });
    mpv = null; // allow a fresh spawn next time
    currentMpvFileId = null;
    closeControls();
    closeSubSearch();
  });
  return mpv;
}

ipcMain.handle("mpv:start", async (_e, fileId: number, startSec = 0, title = "", hasNext = false, alang = "", slang = "") => {
  if (!server || !win) return { error: "not ready" };
  const dataDir = process.env.LOCALITY_TEST_DATA_DIR || app.getPath("userData");
  // The mpv binary shipped with the app: under resources/ in a packaged build,
  // under the repo's resources/ folder in a dev run.
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "mpv", "mpv.exe")
    : path.join(app.getAppPath(), "resources", "mpv", "mpv.exe");
  const bin = findMpv(dataDir, getSetting(server.ctx.db, "mpvPath") || undefined, bundled);
  const url = `http://127.0.0.1:${server.port}/api/stream/${fileId}`;
  const logFile = path.join(dataDir, "mpv.log");
  console.log(`mpv:start fileId=${fileId} startSec=${startSec} bin=${bin}`);
  currentMpvFileId = fileId;
  currentMpvTitle = String(title || "");
  currentMpvHasNext = !!hasNext;
  try {
    const player = ensureMpv();
    await player.start(bin, win.getNativeWindowHandle(), logFile);
    // Auto-pick the preferred audio/subtitle language: mpv reads alang/slang when
    // it selects tracks on load. slang "off" means the user wants no subtitles.
    if (alang) player.send(["set_property", "alang", String(alang)]);
    if (slang && slang !== "off") player.send(["set_property", "slang", String(slang)]);
    player.loadFile(url, startSec, slang === "off");
    openControls();
    console.log("mpv:start ok");
    return { ok: true, url, bin };
  } catch (e: any) {
    console.error("mpv:start failed:", e);
    return { error: String(e?.message ?? e) };
  }
});

ipcMain.handle("mpv:command", (_e, command: unknown[]) => {
  mpv?.send(Array.isArray(command) ? command : []);
});

ipcMain.handle("mpv:stop", () => {
  closeControls();
  closeSubSearch();
  mpv?.stop();
});

// The bottom bar's "Next" button lives in its own window; relay it to the main
// window, which owns navigation (goNext).
ipcMain.handle("mpv:next", () => win?.webContents.send("mpv:event", { type: "next" }));

ipcMain.handle("mpv:sub-search-close", () => closeSubSearch());
// The overlay's subtitle menu (themed, in the renderer) triggers these.
ipcMain.handle("mpv:sub-search", () => openSubSearch());
ipcMain.handle("mpv:sub-add-file", () => void addSubtitleFile());

ipcMain.handle("mpv:fullscreen", () => {
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
});

app.whenReady().then(() => {
  // Losing the single-instance lock means the copy already running is opening
  // the window instead. Carrying on here would boot a SECOND server and a window
  // that the pending quit tears down mid-load — which surfaced as a bogus
  // "Locality failed to start / ERR_FAILED (-2)" dialog on top of a working app
  // (and left two processes fighting over the same log file).
  if (handedOffToPrimary) return;
  return startApp().catch((e) => {
    // Without this, a startup failure leaves a splash on screen forever and
    // looks like a crash with no trace.
    console.error("startup failed:", e);
    dialog.showErrorBox("Locality failed to start", String(e?.message ?? e));
    app.quit();
  });
});

app.on("window-all-closed", () => {
  // In server-only mode the tray owns the lifetime; otherwise closing the
  // window quits like a normal desktop app.
  if (!serverOnlyMode) app.quit();
});

app.on("before-quit", async (e) => {
  tray?.destroy();
  tray = null;
  if (server) {
    e.preventDefault();
    const s = server;
    server = null;
    try {
      // Don't let a wedged shutdown keep the process alive.
      await Promise.race([s.close(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {}
    app.quit();
  }
});
