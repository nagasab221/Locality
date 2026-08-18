import { useCallback, useEffect, useState } from "react";
import { del, get, post, put, api, subscribe, fmtSize } from "../api";
import type { AppState, NetCheckResult } from "../types";
import { btnGhost, btnPrimary, inputCls, selectCls, SectionTitle, CheckIcon } from "../components/ui";
import { ProfilesPanel } from "../components/ProfilesPanel";
import { THEMES, applyTheme, getTheme } from "../theme";

interface DetectStatus {
  active: boolean;
  paused: boolean;
  showId: number | null;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  done: number;
  total: number;
  queued: number;
}

interface CloudStatus {
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  syncing: boolean;
  lastSync: string | null;
  lastError: string | null;
}

/**
 * Optional cloud account. Signed out, nothing changes — everything still runs
 * locally; signing in adds automatic watch-progress sync across devices.
 */
interface AccountServer {
  serverId: string;
  name: string;
  lastSeen: string | null;
  isSelf: boolean;
}

/** Devices published under the signed-in account: rename this PC, remove old ones. */
function ServersPanel({ toast }: { toast: (text: string, tone?: "info" | "error" | "ok") => void }) {
  const [servers, setServers] = useState<AccountServer[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameVal, setNameVal] = useState("");

  const load = useCallback(() => {
    get<AccountServer[]>("/account/servers").then(setServers).catch(() => setServers([]));
  }, []);
  useEffect(load, [load]);

  // Nothing published (signed out, or remote access never turned on) — no panel.
  if (!servers || servers.length === 0) return null;

  const rename = (id: string) => {
    if (!nameVal.trim()) return;
    post("/account/servers/rename", { serverId: id, name: nameVal.trim() })
      .then(() => {
        toast("Device renamed", "ok");
        setRenaming(null);
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"));
  };
  const remove = (s: AccountServer) => {
    if (!confirm(`Remove "${s.name || "this device"}" from your account?${s.isSelf ? "" : "\n\nIf that device is still running it will re-publish itself."}`)) return;
    post("/account/servers/remove", { serverId: s.serverId })
      .then(() => {
        toast("Device removed", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"));
  };

  return (
    <section className="space-y-3">
      <SectionTitle>Your devices</SectionTitle>
      <p className="text-xs text-muted">
        Machines signed into this account that your phone can connect to. Rename this PC, or remove devices you no longer use.
      </p>
      <div className="space-y-2">
        {servers.map((s) => (
          <div key={s.serverId} className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-cardborder">
            {renaming === s.serverId ? (
              <>
                <input
                  className={inputCls + " flex-1"}
                  value={nameVal}
                  autoFocus
                  maxLength={60}
                  onChange={(e) => setNameVal(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && rename(s.serverId)}
                />
                <button className={btnPrimary + " !px-3 !py-1.5"} onClick={() => rename(s.serverId)}>Save</button>
                <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => setRenaming(null)}>Cancel</button>
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-body truncate">
                    {s.name || "Unnamed"}
                    {s.isSelf && <span className="text-[10px] uppercase tracking-wider text-accent ml-1.5">this PC</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {s.lastSeen ? `last seen ${new Date(s.lastSeen).toLocaleString()}` : "never seen"}
                  </div>
                </div>
                <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => { setRenaming(s.serverId); setNameVal(s.name); }}>Rename</button>
                <button
                  className={btnGhost + " !px-3 !py-1.5 !text-danger !border-danger/40 hover:!bg-danger/10"}
                  onClick={() => remove(s)}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function CloudPanel({
  toast,
}: {
  toast: (text: string, tone?: "info" | "error" | "ok") => void;
}) {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<CloudStatus>("/cloud/status").then(setSt).catch(() => {});
    return subscribe("cloud", (d) => d && setSt(d as CloudStatus));
  }, []);

  const run = (p: Promise<any>, ok: string) => {
    setBusy(true);
    p.then((s) => {
      setSt(s);
      setPassword("");
      toast(ok, "ok");
    })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  return (
    <section className="space-y-3">
      <SectionTitle>Account</SectionTitle>
      <p className="text-xs text-muted leading-relaxed">
        Sign in to sync watch progress across devices and let the Android app find this PC automatically. Your
        preferences, API keys and library folders are saved to your account too, so a reinstall or a new machine
        restores your setup after you sign in. Optional. Your media never leaves this PC.
      </p>

      {st && !st.configured && (
        <p className="text-xs text-warn">Sync isn't available in this build.</p>
      )}

      {st?.signedIn ? (
        <div className="p-3 rounded-lg bg-surface border border-cardborder flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-body truncate">
              Signed in as <span className="text-heading">{st.email}</span>
            </div>
            <div className="text-[11px] text-muted">
              {st.syncing
                ? "Syncing…"
                : st.lastError
                  ? <span className="text-danger">{st.lastError}</span>
                  : st.lastSync
                    ? `Last synced ${new Date(st.lastSync).toLocaleString()}`
                    : "Not synced yet"}
            </div>
          </div>
          <button className={btnGhost + " !px-3 !py-1.5"} disabled={busy || st.syncing} onClick={() => run(post("/cloud/sync"), "Synced")}>
            Sync now
          </button>
          <button className={btnGhost + " !px-3 !py-1.5"} disabled={busy} onClick={() => run(post("/cloud/signout"), "Signed out")}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted">Email</span>
              <input className={inputCls + " mt-1"} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Password</span>
              <input
                className={inputCls + " mt-1"}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email && password && run(post("/cloud/signin", { email, password }), "Signed in")}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              className={btnPrimary}
              disabled={busy || !st?.configured || !email || !password}
              onClick={() => run(post("/cloud/signin", { email, password }), "Signed in")}
            >
              Sign in
            </button>
            <button
              className={btnGhost}
              disabled={busy || !st?.configured || !email || !password}
              onClick={() => run(post("/cloud/signup", { email, password }), "Account created")}
            >
              Create account
            </button>
          </div>
          {st?.lastError && <p className="text-danger text-xs">{st.lastError}</p>}
        </div>
      )}
    </section>
  );
}

/** Live view of the background intro/credits detector, with a pause switch. */
function DetectionPanel() {
  const [st, setSt] = useState<DetectStatus | null>(null);

  useEffect(() => {
    get<DetectStatus>("/detect/status").then(setSt).catch(() => {});
    return subscribe("detect", (d) => {
      if (d && typeof d.active === "boolean") setSt(d as DetectStatus);
    });
  }, []);

  if (!st) return null;
  const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0;
  const idle = !st.active && !st.paused;

  return (
    <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">Intro / credits detection</div>
          <div className="text-sm text-body truncate">
            {idle ? (
              st.queued > 0 ? `${st.queued} show(s) queued` : "Idle"
            ) : (
              <>
                {st.showTitle ?? "Working"}
                {st.season != null && st.episode != null && (
                  <span className="text-muted">
                    {" "}
                    · S{String(st.season).padStart(2, "0")}E{String(st.episode).padStart(2, "0")}
                  </span>
                )}
                {st.paused && <span className="text-warn"> · paused</span>}
              </>
            )}
          </div>
        </div>
        {(st.active || st.paused) && (
          <button
            className={btnGhost + " !px-3 !py-1.5"}
            onClick={() => post("/detect/pause", { paused: !st.paused }).then(setSt).catch(() => {})}
          >
            {st.paused ? "Resume" : "Pause"}
          </button>
        )}
      </div>
      {(st.active || st.paused) && st.total > 0 && (
        <>
          <div className="h-1.5 rounded-full bg-track overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${st.paused ? "bg-warn" : "bg-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-[11px] text-muted">
            {st.done} of {st.total} episodes
            {st.queued > 0 && ` · ${st.queued} more show(s) queued`}
          </div>
        </>
      )}
    </div>
  );
}

const LANGS = [
  ["", "None"],
  ["en", "English"], ["ar", "Arabic"], ["es", "Spanish"], ["fr", "French"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["tr", "Turkish"],
  ["nl", "Dutch"], ["pl", "Polish"], ["sv", "Swedish"], ["hi", "Hindi"],
];

// Settings is organized into these tabs (Plex-style left nav). FORM_TABS are the
// ones whose fields are saved by the shared "Save settings" button.
const TABS = [
  { key: "general", label: "General" },
  { key: "libraries", label: "Libraries" },
  { key: "playback", label: "Playback" },
  { key: "metadata", label: "Metadata" },
  { key: "remote", label: "Remote Access" },
  { key: "account", label: "Account" },
];
const FORM_TABS = new Set(["libraries", "playback", "metadata", "remote", "general"]);

const libTypeLabel = (t: string) =>
  t === "tv" ? "TV Shows" : t === "gallery" ? "Photo Gallery" : t === "other" ? "Other Videos" : "Movies";

// Small TMDB wordmark in their brand gradient. For strict brand compliance you
// can drop the official TMDB logo (downloadable from themoviedb.org/about/logos)
// in here as an <img>; this attributes clearly in the meantime.
function TmdbMark() {
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide text-[#042541]"
      style={{ background: "linear-gradient(90deg,#90cea1,#01b4e4)" }}
    >
      TMDB
    </span>
  );
}

function RemoteStatus({ remote }: { remote: AppState["remote"] }) {
  if (!remote || remote.state === "off") return <span>off</span>;
  switch (remote.state) {
    case "downloading":
      return (
        <span className="text-warn">
          getting cloudflared{remote.downloadPercent != null ? ` ${remote.downloadPercent}%` : "…"}
        </span>
      );
    case "starting":
      return <span className="text-warn">connecting…</span>;
    case "online":
      return <span className="text-ok">reachable from anywhere</span>;
    default:
      return <span className="text-danger">{remote.error ?? "failed"}</span>;
  }
}

/** Cache size + a manual sweep of artwork nothing references anymore. */
function CachePanel({ toast }: { toast: (text: string, tone?: "info" | "error" | "ok") => void }) {
  const [stats, setStats] = useState<{ files: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    get<{ files: number; bytes: number }>("/cache/stats").then(setStats).catch(() => {});
  }, []);
  useEffect(load, [load]);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-cardborder">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted mb-0.5">Media cache (posters, thumbnails, subtitles)</div>
        <div className="text-sm text-body">{stats ? `${fmtSize(stats.bytes)} · ${stats.files} files` : "…"}</div>
      </div>
      <button
        className={btnGhost + " !px-3 !py-1.5"}
        disabled={busy}
        title="Delete cached artwork that no longer belongs to anything in your libraries"
        onClick={() => {
          setBusy(true);
          post<{ removed: number; freedBytes: number }>("/cache/cleanup")
            .then((r) => {
              toast(r.removed ? `Removed ${r.removed} unused files (${fmtSize(r.freedBytes)})` : "Nothing unused found", "ok");
              load();
            })
            .catch((e) => toast(String(e.message ?? e), "error"))
            .finally(() => setBusy(false));
        }}
      >
        Remove unused
      </button>
    </div>
  );
}

/**
 * Colour theme picker. Applies instantly (localStorage cache for a flash-free
 * launch) and saves to the account so the theme follows the user to other
 * devices — no Save button needed, like the autostart toggle.
 */
function ThemePicker({ current }: { current: string }) {
  const [sel, setSel] = useState(current || getTheme());
  // Follow the account if a cloud pull changes the theme while this is open.
  useEffect(() => setSel(current || getTheme()), [current]);
  return (
    <section className="space-y-3">
      <SectionTitle>Appearance</SectionTitle>
      <p className="text-xs text-muted leading-relaxed">Colour theme. Saved to your account and applied on every device you sign in on.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {THEMES.map((t) => {
          const active = sel === t.id;
          return (
            <button
              key={t.id}
              title={t.hint}
              onClick={() => {
                applyTheme(t.id);
                setSel(t.id);
                put("/settings/theme", { theme: t.id }).catch(() => {});
              }}
              className={`text-left rounded-lg overflow-hidden border transition-all ${
                active ? "border-accent ring-1 ring-accent" : "border-cardborder hover:border-accent/60"
              }`}
            >
              <div className="h-16 flex" style={{ background: t.bg }}>
                <div className="w-1/3 h-full" style={{ background: t.surface }} />
                <div className="flex-1 p-2.5 flex flex-col justify-center gap-1.5">
                  <div className="h-1.5 w-10 rounded-full" style={{ background: t.accent }} />
                  <div className="h-1 w-full rounded-full" style={{ background: t.text, opacity: 0.5 }} />
                  <div className="h-1 w-2/3 rounded-full" style={{ background: t.text, opacity: 0.3 }} />
                </div>
              </div>
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface">
                <span className="w-3 h-3 rounded-full shrink-0 border border-black/20" style={{ background: t.accent }} />
                <span className="text-xs text-body flex-1 truncate">{t.name}</span>
                {active && (
                  <span className="text-accent shrink-0">
                    <CheckIcon />
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function HwAccelPanel({ form, set }: { form: Record<string, string>; set: (k: string, v: string) => void }) {
  const [status, setStatus] = useState<{ encoder: string; name: string } | null>(null);

  useEffect(() => {
    get<{ encoder: string; name: string }>("/hwaccel/status").then(setStatus).catch(() => {});
  }, [form.hwaccel]);

  return (
    <div className="p-4 rounded-lg bg-surface border border-cardborder space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-heading">Hardware Acceleration (GPU Transcoding)</span>
        {status && (
          <span className="text-xs px-2 py-0.5 rounded bg-accent/20 text-hint border border-accent/40 font-mono">
            Active: {status.name}
          </span>
        )}
      </div>
      <p className="text-xs text-muted leading-relaxed">
        Uses your GPU (NVIDIA NVENC, Intel QuickSync, AMD AMF) for real-time video transcoding when streaming to web browsers or companion apps, keeping PC CPU load minimal.
      </p>
      <label className="block max-w-sm">
        <span className="text-xs text-muted">Transcoder Engine</span>
        <select
          className={selectCls + " mt-1 block w-full"}
          value={form.hwaccel ?? "auto"}
          onChange={(e) => set("hwaccel", e.target.value)}
        >
          <option value="auto">Auto-detect GPU (Recommended)</option>
          <option value="nvenc">NVIDIA NVENC (NVIDIA GPUs)</option>
          <option value="qsv">Intel QuickSync / QSV (Intel GPUs/CPUs)</option>
          <option value="amf">AMD AMF (AMD GPUs)</option>
          <option value="off">Disabled (CPU Software encoding - libx264)</option>
        </select>
      </label>
    </div>
  );
}

export default function Settings({
  state,
  onSaved,
  toast,
}: {
  state: AppState | null;
  onSaved: () => void;
  toast: (text: string, tone?: "info" | "error" | "ok") => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [libName, setLibName] = useState("");
  const [libType, setLibType] = useState<"movies" | "tv" | "gallery" | "other">("movies");
  const [tab, setTab] = useState("general");
  const [libPath, setLibPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [netResults, setNetResults] = useState<NetCheckResult[] | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  // The tunnel takes a while to come up (and may download cloudflared first), so
  // this section follows the "remote" event instead of the /state snapshot.
  const [remote, setRemote] = useState<AppState["remote"]>(null);

  useEffect(() => {
    if (state) setForm(state.settings);
    if (state?.remote) setRemote(state.remote);
  }, [state]);

  useEffect(() => subscribe("remote", (d) => setRemote(d)), []);

  // The status arrives on the "remote" SSE event, but that fires once and is easy
  // to miss, which left it stuck on "connecting" until a manual save. While the
  // tunnel is mid-transition, poll so it resolves to "reachable" on its own.
  useEffect(() => {
    if (remote?.state !== "downloading" && remote?.state !== "starting") return;
    const t = setInterval(() => {
      get<AppState["remote"]>("/remote/status")
        .then((r) => r && setRemote(r))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [remote?.state]);

  if (!state) return <div className="p-8 text-muted">Loading…</div>;

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    setBusy(true);
    put("/settings", form)
      .then(() => {
        toast("Settings saved", "ok");
        onSaved();
      })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  const addLibrary = () => {
    if (!libName.trim() || !libPath) return;
    setBusy(true);
    post("/libraries", { name: libName.trim(), type: libType, path: libPath })
      .then(() => {
        toast(`Library "${libName}" added`, "ok");
        setLibName("");
        setLibPath("");
        onSaved();
      })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  // Swap a library with its neighbour and persist the whole order.
  const moveLib = (index: number, dir: -1 | 1) => {
    const ids = state.libraries.map((l) => l.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    post("/libraries/order", { ids })
      .then(onSaved)
      .catch((e) => toast(String(e.message ?? e), "error"));
  };

  const field = (label: string, key: string, type = "text", placeholder = "") => (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        type={type}
        className={inputCls + " mt-1"}
        value={form[key] ?? ""}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="flex gap-8 p-8 max-w-5xl">
      <div className="w-40 shrink-0">
        <h1 className="font-display text-2xl text-heading mb-5">Settings</h1>
        <nav className="space-y-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`block w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                tab === t.key ? "bg-hov text-heading" : "text-muted hover:text-body hover:bg-raised"
              }`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 min-w-0 space-y-8">

      {tab === "libraries" && (
      <>
      {/* Libraries */}
      <section className="space-y-4">
        <SectionTitle>Libraries</SectionTitle>
        {state.libraries.length === 0 && <p className="text-sm text-muted">No libraries yet. Add your first below.</p>}
        {state.libraries.map((lib, i) => (
          <div key={lib.id} className="p-3 rounded-lg bg-surface border border-cardborder space-y-2.5">
            <div className="flex items-center gap-3">
              <div className="flex flex-col shrink-0 -my-1">
                <button
                  className="text-muted hover:text-heading disabled:opacity-25 disabled:hover:text-muted text-[9px] leading-tight px-1"
                  disabled={i === 0}
                  title="Move up"
                  onClick={() => moveLib(i, -1)}
                >
                  ▲
                </button>
                <button
                  className="text-muted hover:text-heading disabled:opacity-25 disabled:hover:text-muted text-[9px] leading-tight px-1"
                  disabled={i === state.libraries.length - 1}
                  title="Move down"
                  onClick={() => moveLib(i, 1)}
                >
                  ▼
                </button>
              </div>
              <select
                className={selectCls + " !py-1 !text-[11px] uppercase"}
                value={lib.type}
                title="Library type"
                onChange={(e) => {
                  const type = e.target.value;
                  if (
                    confirm(`Change "${lib.name}" to a ${libTypeLabel(type)} library?\n\nIt gets rescanned. Watch progress is kept.`)
                  ) {
                    api(`/libraries/${lib.id}`, { method: "PUT", body: JSON.stringify({ type }) })
                      .then(() => {
                        toast(`"${lib.name}" changed to ${libTypeLabel(type)}`, "ok");
                        onSaved();
                      })
                      .catch((err) => toast(String(err.message ?? err), "error"));
                  } else {
                    e.target.value = lib.type; // revert the select
                  }
                }}
              >
                <option value="movies">Movies</option>
                <option value="tv">TV Shows</option>
                <option value="gallery">Photo Gallery</option>
                <option value="other">Other Videos</option>
              </select>
              <div className="min-w-0 flex-1 text-sm text-body">{lib.name}</div>
              <button
                className={btnGhost + " !px-3 !py-1.5 flex items-center gap-1.5"}
                title={
                  lib.shared === 0
                    ? "Private — only this PC can see it. Click to make it reachable by your other devices."
                    : "Shared — reachable by your other devices over the network/tunnel. Click to make it private."
                }
                onClick={() =>
                  post(`/libraries/${lib.id}/sharing`, { shared: lib.shared === 0 })
                    .then(() => {
                      toast(lib.shared === 0 ? `"${lib.name}" is now shared` : `"${lib.name}" is now private`, "ok");
                      onSaved();
                    })
                    .catch((err) => toast(String(err.message ?? err), "error"))
                }
              >
                <span className={`w-1.5 h-1.5 rounded-full ${lib.shared === 0 ? "bg-muted" : "bg-accent"}`} />
                {lib.shared === 0 ? "Private" : "Shared"}
              </button>
              <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => post(`/libraries/${lib.id}/scan`).then(() => toast("Scan started"))}>
                Rescan
              </button>
              <button
                className={btnGhost + " !px-3 !py-1.5"}
                title="Wipe and rescan the catalog (files and watch progress are kept)"
                onClick={() => {
                  if (confirm(`Rebuild "${lib.name}"?\n\nThe catalog is wiped and rescanned. Your files and watch progress are not touched.`)) {
                    api(`/libraries/${lib.id}`, { method: "PUT", body: JSON.stringify({ rebuild: true }) })
                      .then(() => toast(`Rebuilding "${lib.name}"`, "ok"))
                      .catch((err) => toast(String(err.message ?? err), "error"));
                  }
                }}
              >
                Rebuild
              </button>
              <button
                className={btnGhost + " !px-3 !py-1.5 !text-danger !border-danger/40 hover:!bg-danger/10"}
                onClick={() => {
                  if (confirm(`Remove library "${lib.name}"? Files on disk are not touched.`)) {
                    del(`/libraries/${lib.id}`).then(onSaved);
                  }
                }}
              >
                Remove
              </button>
            </div>
            {/* Source folders — a library can span several. The first is primary. */}
            <div className="pl-1 space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted truncate flex-1" title={lib.path}>{lib.path}</span>
                <span className="text-[10px] uppercase tracking-widest text-muted/50">primary</span>
              </div>
              {(lib.folders ?? []).map((f) => (
                <div key={f.id} className="flex items-center gap-2 text-xs">
                  <span className="text-muted truncate flex-1" title={f.path}>{f.path}</span>
                  <button
                    className="text-danger hover:opacity-80 shrink-0"
                    title="Remove this folder (files on disk are not touched)"
                    onClick={() =>
                      del(`/libraries/${lib.id}/folders/${f.id}`)
                        .then(() => {
                          toast("Folder removed", "ok");
                          onSaved();
                        })
                        .catch((err) => toast(String(err.message ?? err), "error"))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                className={btnGhost + " !px-2 !py-1 text-xs"}
                onClick={async () => {
                  const p = await window.locality.chooseFolder();
                  if (!p) return;
                  post(`/libraries/${lib.id}/folders`, { path: p })
                    .then(() => {
                      toast("Folder added, scanning…", "ok");
                      onSaved();
                    })
                    .catch((err) => toast(String(err.message ?? err), "error"));
                }}
              >
                + Add folder
              </button>
            </div>
          </div>
        ))}

        <div className="p-4 rounded-lg bg-surface border border-cardborder space-y-3">
          <div className="grid grid-cols-[1fr,auto] gap-3">
            <input className={inputCls} placeholder="Library name (e.g. Movies)" value={libName} onChange={(e) => setLibName(e.target.value)} />
            <select className={selectCls} value={libType} onChange={(e) => setLibType(e.target.value as any)}>
              <option value="movies">Movies</option>
              <option value="tv">TV Shows</option>
              <option value="gallery">Photo Gallery</option>
              <option value="other">Other Videos</option>
            </select>
          </div>
          <div className="flex gap-3 items-center">
            <button
              className={btnGhost}
              onClick={async () => {
                const p = await window.locality.chooseFolder();
                if (p) setLibPath(p);
              }}
            >
              Choose folder…
            </button>
            <span className="text-xs text-muted truncate flex-1">{libPath || "No folder selected"}</span>
            <button className={btnPrimary} disabled={busy || !libName.trim() || !libPath} onClick={addLibrary}>
              Add library
            </button>
          </div>
        </div>

        <label className="flex items-center gap-3 text-sm text-body">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.backgroundScan === "1"}
            onChange={(e) => set("backgroundScan", e.target.checked ? "1" : "0")}
          />
          Watch library folders for new files automatically
        </label>

        <label className="flex items-center gap-3 text-sm text-body">
          <span>Ignore movie files smaller than</span>
          <input
            type="text"
            inputMode="numeric"
            className="w-20 bg-input border border-inborder rounded px-2 py-1 text-sm text-body"
            value={form.minMovieSizeMB ?? ""}
            placeholder="200"
            onChange={(e) => set("minMovieSizeMB", e.target.value.replace(/\D/g, ""))}
          />
          <span className="text-muted">MB (0 to keep everything)</span>
        </label>
      </section>
      </>
      )}

      {tab === "general" && (
      <>
      <ThemePicker current={state.settings.theme} />

      {/* App behavior */}
      <section className="space-y-3">
        <SectionTitle>App</SectionTitle>
        <label className="flex items-center gap-3 text-sm text-body">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.startWithWindows === "1"}
            onChange={(e) => {
              const enabled = e.target.checked;
              set("startWithWindows", enabled ? "1" : "0");
              put("/settings", { ...form, startWithWindows: enabled ? "1" : "0" })
                .then(() => window.locality.setAutostart(enabled))
                .then(() => toast(enabled ? "Locality will start with Windows" : "Autostart off", "ok"))
                .catch((err) => toast(String(err.message ?? err), "error"));
            }}
          />
          Start with Windows (runs in the tray)
        </label>
        <div className="flex items-center gap-3">
          <button className={btnGhost} onClick={() => void window.locality.enterServerMode()}>
            Switch to server mode
          </button>
          <span className="text-xs text-muted">closes the window, keeps serving from the tray</span>
        </div>
      </section>
      </>
      )}

      {tab === "metadata" && (
      <>
      {/* Metadata */}
      <section className="space-y-3">
        <SectionTitle>Metadata</SectionTitle>
        {field("TMDB API key (optional)", "tmdbApiKey", "password", "free key at themoviedb.org/settings/api")}
        {field("TMDB Proxy URL (Cloudflare Worker)", "tmdbProxyUrl", "text", "default: https://locality.madebymanara.workers.dev")}
        <p className="text-xs text-muted leading-relaxed">
          If a personal TMDB API key is entered, Locality connects directly to TMDB. If left empty, requests route through your Cloudflare Worker proxy.
        </p>
        <p className="text-xs text-muted leading-relaxed">
          Falls back to TVmaze and AniList automatically for anime and TV.
        </p>
        <p className="text-[11px] text-muted/70 leading-relaxed">
          Metadata from{" "}
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="text-hint hover:text-accent">
            TMDB
          </a>
          ,{" "}
          <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer" className="text-hint hover:text-accent">
            TVmaze
          </a>{" "}
          and{" "}
          <a href="https://anilist.co" target="_blank" rel="noreferrer" className="text-hint hover:text-accent">
            AniList
          </a>
          . Not endorsed by TMDB.
        </p>
      </section>
      </>
      )}

      {tab === "playback" && (
      <>
      {/* Subtitles */}
      <section className="space-y-3">
        <SectionTitle>Subtitles</SectionTitle>
        {field("OpenSubtitles API key", "osApiKey", "password", "from opensubtitles.com")}
        <div className="grid grid-cols-2 gap-3">
          {field("Username (optional)", "osUsername")}
          {field("Password", "osPassword", "password")}
        </div>
        <label className="block">
          <span className="text-xs text-muted">Default subtitle language</span>
          <select className={selectCls + " mt-1 block"} value={form.defaultSubLang ?? ""} onChange={(e) => set("defaultSubLang", e.target.value)}>
            {LANGS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Playback */}
      <section className="space-y-3">
        <SectionTitle>Playback</SectionTitle>
        <label className="block max-w-sm">
          <span className="text-xs text-muted">Playback engine (local files)</span>
          <select
            className={selectCls + " mt-1 block w-full"}
            value={form.playbackEngine === "mpv" ? "mpv" : form.playbackEngine === "builtin" ? "builtin" : "auto"}
            onChange={(e) => set("playbackEngine", e.target.value === "auto" ? "" : e.target.value)}
          >
            <option value="auto">Default (mpv where supported)</option>
            <option value="mpv">mpv</option>
            <option value="builtin">Built-in player</option>
          </select>
          <p className="text-[11px] text-muted/80 leading-relaxed mt-1">
            mpv plays local files with its own engine: more codecs, sturdier seeking, and richer controls. It's the
            default on Windows and Linux (X11); other setups use the built-in player. Save, then reopen a video.
            Remote playback always uses the built-in player.
          </p>
        </label>
        <HwAccelPanel form={form} set={set} />
        <label className="flex items-center gap-3 text-sm text-body">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.autoplayNext !== "0"}
            onChange={(e) => set("autoplayNext", e.target.checked ? "1" : "0")}
          />
          Autoplay next episode (Up Next countdown when the credits start)
        </label>
        <label className="flex items-center gap-3 text-sm text-body">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.skipIntro !== "0"}
            onChange={(e) => set("skipIntro", e.target.checked ? "1" : "0")}
          />
          Auto skip intros (3-second notice, click it to keep watching the intro)
        </label>
        <label className="block max-w-56">
          <span className="text-xs text-muted">Up Next countdown seconds</span>
          <input
            className={inputCls + " mt-1"}
            value={form.upNextSeconds ?? ""}
            placeholder="10"
            onChange={(e) => set("upNextSeconds", e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <DetectionPanel />
      </section>

      {/* Watch progress */}
      <section className="space-y-2">
        <SectionTitle>Watch progress</SectionTitle>
        <p className="text-sm text-muted leading-relaxed">
          Resume positions are saved to a file you can copy to another machine.
        </p>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-cardborder">
          <code className="text-xs text-hint flex-1 truncate">{state.ledgerPath}</code>
          <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => window.locality.showInFolder(state.ledgerPath)}>
            Show in folder
          </button>
        </div>
      </section>
      </>
      )}

      {tab === "account" && (
      <>
      <CloudPanel toast={toast} />

      <ServersPanel toast={toast} />

      <ProfilesPanel toast={toast} />
      </>
      )}

      {tab === "remote" && (
      <>
      {/* Remote access (Android companion) */}
      <section className="space-y-3">
        <SectionTitle>Remote access</SectionTitle>
        <label className="flex items-center gap-3 text-sm text-body">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.lanEnabled === "1"}
            onChange={(e) => set("lanEnabled", e.target.checked ? "1" : "0")}
          />
          Let the Android app connect to this PC
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted">Port</span>
            <input
              className={inputCls + " mt-1"}
              value={form.lanPort ?? ""}
              placeholder="3777"
              onChange={(e) => set("lanPort", e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Access token</span>
            <div className="flex gap-2 mt-1">
              <input className={inputCls + " font-mono"} readOnly value={form.lanToken ?? ""} />
              <button
                className={btnGhost + " !px-3"}
                title="Generate a new token"
                onClick={() => {
                  const b = new Uint8Array(16);
                  crypto.getRandomValues(b);
                  set("lanToken", Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
                }}
              >
                New
              </button>
            </div>
          </label>
        </div>
        {state.lan && (
          <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-1.5">
            <div className="text-xs text-muted">
              Status:{" "}
              {state.lan.active ? (
                <span className="text-ok">on (port {state.lan.activePort})</span>
              ) : state.lan.enabled ? (
                <span className="text-warn">restart Locality to apply</span>
              ) : (
                <span>off</span>
              )}
            </div>
            {state.lan.addresses.length > 0 && (
              <div className="text-xs text-muted">
                Phone address:{" "}
                {state.lan.addresses.map((a) => (
                  <code key={a} className="text-hint mr-2">
                    http://{a}:{state.lan!.port}
                  </code>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted/80 leading-relaxed">
              Restart after changing. Allow Locality through Windows Firewall on private networks when asked.
            </p>
          </div>
        )}

        <label className="flex items-center gap-3 text-sm text-body pt-1">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={form.remoteEnabled === "1"}
            onChange={(e) => set("remoteEnabled", e.target.checked ? "1" : "0")}
          />
          Reach this PC from outside the house
        </label>
        <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-1.5">
          <div className="text-xs text-muted">
            Status: <RemoteStatus remote={remote} />
          </div>
          {remote?.url && remote.state === "online" && (
            <div className="flex items-center gap-2">
              <code className="text-xs text-hint truncate flex-1">{remote.url}</code>
              <button
                className={btnGhost + " !px-2 !py-1 text-xs"}
                onClick={() => {
                  navigator.clipboard.writeText(remote.url!);
                  toast("Address copied");
                }}
              >
                Copy
              </button>
            </div>
          )}
          <p className="text-[11px] text-muted/80 leading-relaxed">
            No router setup needed. The phone finds the address after signing in. Your video passes through
            Cloudflare, and the access token is all that protects your library, so keep it private.
          </p>
          {form.remoteEnabled === "1" && (form.lanToken ?? "").length < 32 && (
            <p className="text-[11px] text-warn leading-relaxed">
              Saving will replace your short access token with a longer one. Phones that paired by signing in update
              themselves; any you set up by typing the token need it entered again.
            </p>
          )}
        </div>
      </section>
      </>
      )}

      {tab === "general" && (
      <>
      {/* Troubleshooting */}
      <section className="space-y-3">
        <SectionTitle>Troubleshooting</SectionTitle>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-cardborder">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted mb-0.5">Data folder</div>
            <code className="text-xs text-hint block truncate">{state.dataDir}</code>
          </div>
          <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => window.locality.showInFolder(state.dataDir)}>
            Show in folder
          </button>
        </div>
        {state.logPath && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-cardborder">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted mb-0.5">App log</div>
              <code className="text-xs text-hint block truncate">{state.logPath}</code>
            </div>
            <button className={btnGhost + " !px-3 !py-1.5"} onClick={() => window.locality.showInFolder(state.logPath!)}>
              Show in folder
            </button>
          </div>
        )}
        <CachePanel toast={toast} />
        <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted flex-1">Checks that the metadata servers are reachable.</p>
            <button
              className={btnGhost + " !px-3 !py-1.5"}
              disabled={netBusy}
              onClick={() => {
                setNetBusy(true);
                setNetResults(null);
                get<NetCheckResult[]>("/net-check")
                  .then(setNetResults)
                  .catch((e) => toast(String(e.message ?? e), "error"))
                  .finally(() => setNetBusy(false));
              }}
            >
              {netBusy ? "Testing…" : "Run network test"}
            </button>
          </div>
          {netResults && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {netResults.map((r) => (
                <div key={r.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-raised border border-inborder text-xs">
                  <span className={r.reachable ? "text-ok" : "text-danger"}>{r.reachable ? "✓" : "✗"}</span>
                  <span className="text-body flex-1">{r.name}</span>
                  <span className="text-muted">{r.reachable ? `${r.ms} ms` : r.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* About / attributions (required by the TMDB and OpenSubtitles API terms) */}
      <section className="space-y-3">
        <SectionTitle>About</SectionTitle>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-lg text-heading">Locality</span>
          {state.version && <span className="text-xs text-muted">v{state.version}</span>}
        </div>
        <div className="p-4 rounded-lg bg-surface border border-cardborder space-y-3 text-xs text-muted leading-relaxed">
          <div className="flex items-center gap-2">
            <TmdbMark />
            <p>
              This product uses the TMDB API but is not endorsed or certified by{" "}
              <a className="text-hint hover:text-body underline" href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
                TMDB
              </a>
              .
            </p>
          </div>
          <p>
            Metadata also from{" "}
            <a className="text-hint hover:text-body underline" href="https://www.tvmaze.com/" target="_blank" rel="noreferrer">
              TVmaze
            </a>{" "}
            and{" "}
            <a className="text-hint hover:text-body underline" href="https://anilist.co/" target="_blank" rel="noreferrer">
              AniList
            </a>
            . Subtitles from{" "}
            <a className="text-hint hover:text-body underline" href="https://www.opensubtitles.com/" target="_blank" rel="noreferrer">
              OpenSubtitles.com
            </a>
            .
          </p>
          <p>
            Playback by{" "}
            <a className="text-hint hover:text-body underline" href="https://mpv.io/" target="_blank" rel="noreferrer">
              mpv
            </a>{" "}
            (when installed) and a bundled{" "}
            <a className="text-hint hover:text-body underline" href="https://ffmpeg.org/" target="_blank" rel="noreferrer">
              FFmpeg
            </a>
            , each run as a separate program under its own licence.
          </p>
          <p className="pt-1 border-t border-divider">
            Locality is released under the{" "}
            <a className="text-hint hover:text-body underline" href="https://opensource.org/license/mit" target="_blank" rel="noreferrer">
              MIT License
            </a>
            . It plays media you already have; it does not provide or stream any content.
          </p>
        </div>
      </section>
      </>
      )}

      {FORM_TABS.has(tab) && (
        <div className="pt-2 pb-8">
          <button className={btnPrimary} onClick={save} disabled={busy}>
            Save settings
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
