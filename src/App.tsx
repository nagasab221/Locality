import { useCallback, useEffect, useRef, useState } from "react";
import { Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  apiFrom,
  get,
  post,
  put,
  subscribe,
  setActiveSource,
  loadServers,
  saveServers,
  getActiveProfile,
  setActiveProfile,
  setPartyServer,
  type RemoteServer,
} from "./api";
import type { AppState, Library, Profile } from "./types";
import { applyTheme } from "./theme";
import { ContextMenu } from "./components/ContextMenu";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Modal, btnGhost, btnPrimary, inputCls, selectCls } from "./components/ui";
import { ConnectServerDialog } from "./components/ConnectServerDialog";
import Home from "./pages/Home";
import LibraryPage from "./pages/Library";
import ItemDetail from "./pages/ItemDetail";
import Player from "./pages/Player";
import Settings from "./pages/Settings";
import PersonPage from "./pages/Person";
import CollectionPage from "./pages/Collection";
import SearchPage from "./pages/Search";
import DownloadsPage from "./pages/Downloads";
import PartyPage from "./pages/Party";
import type { PartySnapshot } from "./partySync";
import Welcome from "./components/Welcome";
import ProfileGate from "./components/ProfileGate";
import Onboarding from "./components/Onboarding";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "ok";
}

interface RemoteEntry {
  server: RemoteServer;
  name: string;
  libraries: Library[];
  loading: boolean;
  error?: string;
}

let toastId = 0;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [servers, setServers] = useState<RemoteServer[]>(() => loadServers());
  const [remotes, setRemotes] = useState<Record<string, RemoteEntry>>({});
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const location = useLocation();

  // Keep the active data source in sync with the route's ?src= param. Runs on
  // every render (App re-renders on navigation), before child pages render.
  setActiveSource(new URLSearchParams(location.search).get("src"));

  // A failed /state used to be swallowed, leaving "Loading…" forever if the
  // bundled server never came up. Track it so the app can say so instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(() => {
    get<AppState>("/state")
      .then((s) => {
        setState(s);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
    get<Profile[]>("/profiles").then(setProfiles).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  // Until the first /state succeeds, keep knocking quietly — the server may
  // still be starting when the window opens.
  useEffect(() => {
    if (!loadFailed || state) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [loadFailed, state, refresh]);

  // When the account restores settings/libraries on this machine, pull the new
  // state in so the sidebar + Settings reflect it without a manual reload.
  useEffect(() => subscribe("config-synced", () => refresh()), [refresh]);

  // Keep the streaming-party address current app-wide, not just while the Party
  // tab is open: the player resolves ?src=party through it, and you reach the
  // player straight from an invite.
  useEffect(() => {
    const apply = (s: PartySnapshot | null) => setPartyServer(s?.party?.hostServer ?? null);
    get<PartySnapshot>("/party/status").then(apply).catch(() => {});
    return subscribe("party", apply);
  }, []);

  // The colour theme follows the account. Apply whatever the settings carry
  // (these get overwritten by a cloud pull on another device), which also
  // caches it to localStorage so the next launch paints it before React mounts.
  useEffect(() => {
    const t = state?.settings?.theme;
    if (t) applyTheme(t);
  }, [state?.settings?.theme]);

  // First-launch sign-in prompt: shown once (until dismissed) when cloud sync is
  // available and nobody is signed in. localStorage keeps "seen" per install —
  // but localStorage alone isn't enough: an upgrade from a build that predates
  // this screen has an established library and no "seen" flag, and greeting a
  // long-time user with a full-page sign-up reads as "the app lost my data"
  // (it did, once). Libraries in the catalog = not a first launch.
  const [welcomeDone, setWelcomeDone] = useState(() => localStorage.getItem("locality.welcomeSeen") === "1");
  const [cloud, setCloud] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  useEffect(() => {
    get<{ configured: boolean; signedIn: boolean }>("/cloud/status")
      .then(setCloud)
      .catch(() => setCloud({ configured: false, signedIn: false }));
  }, []);
  const showWelcome =
    !welcomeDone && !!cloud && cloud.configured && !cloud.signedIn && !!state && state.libraries.length === 0;
  const dismissWelcome = useCallback(() => {
    localStorage.setItem("locality.welcomeSeen", "1");
    setWelcomeDone(true);
    refresh();
  }, [refresh]);

  // "Who's watching?" on launch. sessionStorage clears when the app window is
  // closed, so this is exactly "once per launch": survives in-app reloads (which
  // set the flag before reloading), reappears next time the app is opened. It's
  // shown when there's a real choice to make (2+ profiles) OR the profile we'd
  // otherwise open is locked — so a single locked profile still asks to unlock.
  const activeProfile =
    profiles.find((p) => String(p.id) === getActiveProfile()) ?? profiles.find((p) => p.is_default);
  const needProfileGate =
    !showWelcome &&
    profiles.length > 0 &&
    !sessionStorage.getItem("locality.profileChosen") &&
    (profiles.length >= 2 || !!activeProfile?.locked);

  // First-run: no libraries yet → guide the user to add one. Skippable for the
  // session (so they can look around an empty app without it nagging).
  const [onboardDone, setOnboardDone] = useState(() => !!sessionStorage.getItem("locality.onboardDone"));
  const showOnboarding =
    !showWelcome && !needProfileGate && !onboardDone && !!state && state.libraries.length === 0;
  const dismissOnboarding = useCallback(
    (added: boolean) => {
      sessionStorage.setItem("locality.onboardDone", "1");
      setOnboardDone(true);
      if (added) refresh();
    },
    [refresh]
  );

  const loadRemote = useCallback((server: RemoteServer) => {
    setRemotes((r) => ({ ...r, [server.id]: { server, name: server.name, libraries: [], loading: true } }));
    apiFrom<any>(server.id, "/state")
      .then((s) =>
        setRemotes((r) => ({
          ...r,
          [server.id]: { server, name: s.serverName || server.name, libraries: s.libraries ?? [], loading: false },
        }))
      )
      .catch((e) =>
        setRemotes((r) => ({
          ...r,
          [server.id]: { server, name: server.name, libraries: [], loading: false, error: String(e.message ?? e) },
        }))
      );
  }, []);

  useEffect(() => {
    for (const s of servers) loadRemote(s);
  }, [servers, loadRemote]);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // Toast when someone else joins or leaves the active party. The first snapshot
  // just seeds the baseline so existing members don't all announce themselves.
  const prevPartyMembers = useRef<Set<string> | null>(null);
  useEffect(() => {
    const apply = (s: PartySnapshot | null) => {
      const members = s?.party?.members ?? [];
      const joined = new Set(members.filter((m) => m.status === "joined" && m.userId !== s?.userId).map((m) => m.userId));
      const names = new Map(members.map((m) => [m.userId, m.username]));
      const prev = prevPartyMembers.current;
      if (prev && s?.party) {
        for (const id of joined) if (!prev.has(id)) toast(`${names.get(id) ?? "Someone"} joined the party`, "info");
        for (const id of prev) if (!joined.has(id)) toast(`${names.get(id) ?? "Someone"} left the party`, "info");
      }
      prevPartyMembers.current = s?.party ? joined : null;
    };
    get<PartySnapshot>("/party/status").then(apply).catch(() => {});
    return subscribe("party", apply);
  }, [toast]);

  useEffect(() => {
    const subs = [
      subscribe("scan", (d) => {
        if (d.phase === "done") {
          toast(`Library scan finished (${d.found} files)`, "ok");
          refresh();
        } else if (d.phase === "error") toast(`Scan failed: ${d.detail}`, "error");
      }),
      subscribe("ledger-merged", (d) =>
        toast(`Watch progress synced from locality.json (${d.changed} item${d.changed === 1 ? "" : "s"})`, "ok")
      ),
      subscribe("player-error", (d) => toast(d.message, "error")),
      subscribe("library-changed", refresh),
    ];
    return () => subs.forEach((u) => u());
  }, [refresh, toast]);

  const onConnected = useCallback(
    (server: RemoteServer) => {
      setServers(loadServers());
      loadRemote(server);
      toast(`Connected to ${server.name}`, "ok");
    },
    [loadRemote, toast]
  );

  const onDisconnect = useCallback((server: RemoteServer) => {
    const list = loadServers().filter((s) => s.id !== server.id);
    saveServers(list);
    setServers(list);
    setRemotes((r) => {
      const next = { ...r };
      delete next[server.id];
      return next;
    });
  }, []);

  const isPlayer = location.pathname.startsWith("/play/");

  // Nothing loaded and the server isn't answering: show a real stop instead of
  // an eternal "Loading…". Retries keep running in the background.
  if (!state && loadFailed) return <ServerDown onRetry={refresh} />;

  // The gate is modal over everything else; render it and nothing more.
  if (needProfileGate) return <ProfileGate profiles={profiles} />;
  if (showOnboarding) return <Onboarding onDone={dismissOnboarding} />;

  return (
    <div className="flex h-full">
      {showWelcome && <Welcome onDone={dismissWelcome} toast={toast} />}
      {!isPlayer && (
        <Sidebar
          state={state}
          remotes={remotes}
          profiles={profiles}
          refresh={refresh}
          reloadRemote={loadRemote}
          onDisconnect={onDisconnect}
          onConnected={onConnected}
          toast={toast}
        />
      )}
      <main className="flex-1 overflow-y-auto min-w-0">
        {/* keyed wrapper remounts on navigation so each page plays its enter
            animation — and resets the crash boundary, so a broken page heals
            as soon as you navigate somewhere else */}
        <div key={location.pathname + location.search} className="page-enter h-full">
          <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/library/:id" element={<LibraryPage />} />
            <Route path="/item/:id" element={<ItemDetail />} />
            <Route path="/play/:fileId" element={<Player />} />
            <Route path="/person/:tmdbId" element={<PersonPage />} />
            <Route path="/collection/:key" element={<CollectionPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/party" element={<PartyPage />} />
            <Route path="/settings" element={<Settings state={state} onSaved={refresh} toast={toast} />} />
          </Routes>
          </ErrorBoundary>
        </div>
      </main>

      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-in px-4 py-2.5 rounded-md border text-sm shadow-lg bg-raised ${
              t.tone === "error" ? "border-danger text-danger" : t.tone === "ok" ? "border-accent text-body" : "border-cardborder text-body"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Full-screen stop shown when the bundled server can't be reached at all. */
function ServerDown({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="font-display text-3xl text-heading">Can't reach the local server</h1>
      <p className="text-sm text-muted max-w-md leading-relaxed">
        Locality's built-in server isn't answering. It may still be starting, or another program may be
        using its port. Retrying automatically.
      </p>
      <button className={btnPrimary} onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}

function Sidebar({
  state,
  remotes,
  profiles,
  refresh,
  reloadRemote,
  onDisconnect,
  onConnected,
  toast,
}: {
  state: AppState | null;
  remotes: Record<string, RemoteEntry>;
  profiles: Profile[];
  refresh: () => void;
  reloadRemote: (s: RemoteServer) => void;
  onDisconnect: (s: RemoteServer) => void;
  onConnected: (s: RemoteServer) => void;
  toast: (text: string, tone?: "info" | "error" | "ok") => void;
}) {
  const [libMenu, setLibMenu] = useState<{ x: number; y: number; lib: Library } | null>(null);
  const [editLib, setEditLib] = useState<{ lib: Library; name: string; type: Library["type"] } | null>(null);
  const [serverMenu, setServerMenu] = useState<{ x: number; y: number; entry: RemoteEntry } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive ? "bg-hov text-heading" : "text-muted hover:text-body hover:bg-raised"
    }`;

  const remoteList = Object.values(remotes);

  const runSearch = () => {
    const q = query.trim();
    if (q.length >= 2) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <aside className="w-56 shrink-0 border-r border-divider flex flex-col bg-surface/50">
      <div className="px-5 pt-6 pb-3">
        <h1 className="font-display text-2xl text-accent tracking-wide">Locality</h1>
        <p className="text-[11px] text-muted mt-0.5">local media server</p>
      </div>

      {/* Household profile switcher — only appears once there's more than one. */}
      {profiles.length > 1 && <ProfileSwitcher profiles={profiles} />}

      <div className="px-3 pb-2">
        <div className="relative">
          <input
            className="w-full text-sm bg-raised border border-inborder rounded-md pl-8 pr-2 py-1.5 text-body placeholder:text-muted/70 focus:outline-none focus:border-accent"
            placeholder="Search everything…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none">
            <SearchIcon />
          </span>
        </div>
      </div>

      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        <NavLink to="/" className={linkClass} end>
          <HomeIcon /> Home
        </NavLink>
        <NavLink to="/downloads" className={linkClass}>
          <DownloadNavIcon /> Downloads
        </NavLink>
        <NavLink to="/party" className={linkClass}>
          <PartyNavIcon /> Watch party
        </NavLink>

        {state && state.libraries.length > 0 && (
          <div className="pt-4">
            <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted">Libraries</div>
            {state.libraries.map((lib) => (
              <NavLink
                key={lib.id}
                to={`/library/${lib.id}`}
                className={linkClass}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setLibMenu({ x: e.clientX, y: e.clientY, lib });
                }}
              >
                <LibraryIcon type={lib.type} />
                <span className="truncate">{lib.name}</span>
                {lib.shared === 0 && (
                  <span
                    className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-muted border border-inborder rounded px-1 py-px"
                    title="Private — not shared with your other devices"
                  >
                    Private
                  </span>
                )}
                {lib.scanning && <Spinner />}
              </NavLink>
            ))}
          </div>
        )}

        {/* Connected remote servers, each with its own libraries */}
        {remoteList.map((entry) => (
          <div key={entry.server.id} className="pt-4">
            <div
              className="px-3 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted cursor-default"
              onContextMenu={(e) => {
                e.preventDefault();
                setServerMenu({ x: e.clientX, y: e.clientY, entry });
              }}
              title={entry.server.url}
            >
              <ServerIcon />
              <span className="truncate">{entry.name}</span>
              {entry.loading && <Spinner />}
            </div>
            {entry.error ? (
              <div className="px-3 py-1 text-[11px] text-danger">
                unreachable ·{" "}
                <button className="underline hover:text-body" onClick={() => reloadRemote(entry.server)}>
                  retry
                </button>
              </div>
            ) : (
              entry.libraries.map((lib) => (
                <NavLink key={lib.id} to={`/library/${lib.id}?src=${entry.server.id}`} className={linkClass}>
                  {lib.type === "movies" ? <FilmIcon /> : <TvIcon />}
                  <span className="truncate">{lib.name}</span>
                </NavLink>
              ))
            )}
          </div>
        ))}

        <div className="pt-4">
          <button
            onClick={() => setConnectOpen(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted hover:text-body hover:bg-raised transition-colors"
          >
            <PlusServerIcon /> Connect to server
          </button>
        </div>
      </nav>

      {libMenu && (
        <ContextMenu
          x={libMenu.x}
          y={libMenu.y}
          onClose={() => setLibMenu(null)}
          entries={[
            {
              label: "Rescan",
              disabled: libMenu.lib.scanning,
              onClick: () => {
                post(`/libraries/${libMenu.lib.id}/scan`)
                  .then(() => toast(`Rescanning "${libMenu.lib.name}"…`))
                  .catch((e) => toast(String(e.message ?? e), "error"));
              },
            },
            {
              label: "Edit…",
              onClick: () => setEditLib({ lib: libMenu.lib, name: libMenu.lib.name, type: libMenu.lib.type }),
            },
            {
              label: "Rebuild (wipe & rescan)",
              danger: true,
              disabled: libMenu.lib.scanning,
              onClick: () => {
                if (!window.confirm(`Rebuild "${libMenu.lib.name}"? The catalog is wiped and rescanned. Watch progress survives, manual matches don't.`)) return;
                put(`/libraries/${libMenu.lib.id}`, { rebuild: true })
                  .then(() => {
                    toast(`Rebuilding "${libMenu.lib.name}"…`);
                    refresh();
                  })
                  .catch((e) => toast(String(e.message ?? e), "error"));
              },
            },
          ]}
        />
      )}

      {serverMenu && (
        <ContextMenu
          x={serverMenu.x}
          y={serverMenu.y}
          onClose={() => setServerMenu(null)}
          entries={[
            { label: "Refresh", onClick: () => reloadRemote(serverMenu.entry.server) },
            {
              label: "Disconnect",
              danger: true,
              onClick: () => onDisconnect(serverMenu.entry.server),
            },
          ]}
        />
      )}

      {editLib && (
        <Modal onClose={() => setEditLib(null)}>
          <div className="p-6">
          <h3 className="font-display text-xl text-heading mb-4">Edit library</h3>
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-muted">Name</span>
              <input
                className={inputCls + " mt-1"}
                value={editLib.name}
                onChange={(e) => setEditLib({ ...editLib, name: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Type</span>
              <select
                className={selectCls + " mt-1 w-full"}
                value={editLib.type}
                onChange={(e) => setEditLib({ ...editLib, type: e.target.value as Library["type"] })}
              >
                <option value="movies">Movies</option>
                <option value="tv">TV Shows</option>
                <option value="gallery">Photo Gallery</option>
                <option value="other">Other Videos</option>
              </select>
            </label>
            {editLib.type !== editLib.lib.type && (
              <p className="text-xs text-warn">Changing the type rebuilds the library (watch progress survives).</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button className={btnGhost} onClick={() => setEditLib(null)}>
                Cancel
              </button>
              <button
                className={btnPrimary}
                disabled={!editLib.name.trim()}
                onClick={() => {
                  put(`/libraries/${editLib.lib.id}`, { name: editLib.name.trim(), type: editLib.type })
                    .then(() => {
                      toast("Library updated", "ok");
                      setEditLib(null);
                      refresh();
                    })
                    .catch((e) => toast(String(e.message ?? e), "error"));
                }}
              >
                Save
              </button>
            </div>
          </div>
          </div>
        </Modal>
      )}

      {connectOpen && <ConnectServerDialog onClose={() => setConnectOpen(false)} onConnected={onConnected} />}

      <div className="px-3 pb-4 space-y-1">
        <NavLink to="/settings" className={linkClass}>
          <GearIcon /> Settings
        </NavLink>
        <p className="px-3 text-[10px] text-muted/70 leading-snug">Metadata: TMDB · TVmaze · AniList</p>
      </div>
    </aside>
  );
}

const ic = "w-4 h-4 shrink-0";
/** Avatar circle with a person's initial, tinted with their colour. */
function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  return (
    <span
      className="shrink-0 rounded-full flex items-center justify-center font-semibold text-accenttext"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Who's-watching switcher. Only mounted when 2+ profiles exist, so a single-user
 * install never sees profile chrome. Switching reloads the app so every cached
 * view (Home, library grids, item pages) refetches under the new profile.
 */
function ProfileSwitcher({ profiles }: { profiles: Profile[] }) {
  const [open, setOpen] = useState(false);
  const [unlocking, setUnlocking] = useState<Profile | null>(null);
  const activeId = getActiveProfile();
  const active = profiles.find((p) => String(p.id) === activeId) ?? profiles.find((p) => p.is_default) ?? profiles[0];

  const enter = (p: Profile) => {
    setActiveProfile(p.is_default ? null : p.id);
    // Already past the launch gate this session — don't make it reappear on the
    // reload just because we're switching.
    sessionStorage.setItem("locality.profileChosen", "1");
    window.location.reload();
  };

  const pick = (p: Profile) => {
    setOpen(false);
    if (String(p.id) === String(active.id)) return;
    if (p.locked) setUnlocking(p); // switching in needs the password
    else enter(p);
  };

  return (
    <div className="px-3 pb-2 relative">
      <button
        className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-raised transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={active.name} color={active.color} />
        <span className="text-sm text-body truncate flex-1 text-left">{active.name}</span>
        <span className="text-muted text-xs">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-3 right-3 mt-1 z-30 rounded-lg border border-cardborder bg-raised shadow-xl overflow-hidden">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-left hover:bg-hov ${
                  String(p.id) === String(active.id) ? "bg-hov" : ""
                }`}
                onClick={() => pick(p)}
              >
                <Avatar name={p.name} color={p.color} size={22} />
                <span className="text-sm text-body truncate flex-1">{p.name}</span>
                {p.locked && <LockIcon />}
              </button>
            ))}
            <NavLink
              to="/settings"
              className="block px-2.5 py-2 text-xs text-muted hover:text-body border-t border-divider"
              onClick={() => setOpen(false)}
            >
              Manage profiles
            </NavLink>
          </div>
        </>
      )}
      {unlocking && <UnlockDialog profile={unlocking} onClose={() => setUnlocking(null)} onUnlocked={() => enter(unlocking)} />}
    </div>
  );
}

/** Password prompt shown when switching into a locked profile. */
function UnlockDialog({ profile, onClose, onUnlocked }: { profile: Profile; onClose: () => void; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setErr(null);
    post(`/profiles/${profile.id}/unlock`, { password })
      .then(onUnlocked)
      .catch(() => {
        setErr("Wrong password");
        setBusy(false);
      });
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Avatar name={profile.name} color={profile.color} size={32} />
          <h3 className="font-display text-xl text-heading">Enter {profile.name}'s password</h3>
        </div>
        <input
          className={inputCls}
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {err && <p className="text-danger text-sm">{err}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={btnPrimary} onClick={submit} disabled={busy || !password}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function PartyNavIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16.5 6.4a3.2 3.2 0 0 1 0 6.2M18.5 20a6 6 0 0 0-3-5.2" />
    </svg>
  );
}
function DownloadNavIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
    </svg>
  );
}
function HomeIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}
function LibraryIcon({ type }: { type: string }) {
  if (type === "gallery") return <GalleryIcon />;
  if (type === "other") return <OtherIcon />;
  if (type === "movies") return <FilmIcon />;
  return <TvIcon />;
}
function GalleryIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}
function OtherIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function FilmIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}
function TvIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="m8 2 4 4 4-4" />
    </svg>
  );
}
function ServerIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
    </svg>
  );
}
function PlusServerIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <path d="M3 15h9" strokeLinecap="round" />
      <path d="M18 14v6M15 17h6" strokeLinecap="round" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9 17 7m-10 10-2.1 2.1" />
    </svg>
  );
}
export function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin text-accent ml-auto" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
