// Talk to a Locality server. There are two kinds of "source":
//   - local  : this desktop app's own bundled server (127.0.0.1:<port>)
//   - remote : another machine's Locality server, connected via Settings/sidebar
//
// The app has one ACTIVE source at a time, driven by the `?src=<id>` query on
// the current route (App keeps it in sync). All data helpers read the active
// source unless an explicit one is passed. Remote requests carry the access
// token — as an `X-Locality-Token` header for fetch(), or `?token=` for URLs
// that can't set headers (images, video, subtitle tracks, SSE).
const port = new URLSearchParams(window.location.search).get("port") ?? "3777";
export const LOCAL_BASE = `http://127.0.0.1:${port}/api`;
export const API = LOCAL_BASE; // back-compat alias

export interface RemoteServer {
  id: string;
  name: string;
  url: string; // origin, e.g. http://192.168.1.20:3777
  token: string;
}

const SERVERS_KEY = "locality.servers";

export function loadServers(): RemoteServer[] {
  try {
    const list = JSON.parse(localStorage.getItem(SERVERS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
export function saveServers(list: RemoteServer[]) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(list));
}

let activeSourceId = "local";
export function setActiveSource(id: string | null | undefined) {
  activeSourceId = id || "local";
}
export function isRemoteActive(): boolean {
  return activeSourceId !== "local";
}

// Active household profile. Sent as X-Locality-Profile on LOCAL requests so the
// server returns that person's Continue Watching / watched state. Remote servers
// have their own profiles; v1 uses their default, so the header is local-only.
const PROFILE_LS_KEY = "locality.profile";
export function getActiveProfile(): string {
  return localStorage.getItem(PROFILE_LS_KEY) || "";
}
export function setActiveProfile(id: number | string | null | undefined) {
  if (id) localStorage.setItem(PROFILE_LS_KEY, String(id));
  else localStorage.removeItem(PROFILE_LS_KEY);
}

// The host of a "stream" watch party, addressed as ?src=party.
//
// Deliberately NOT stored in the saved-server list: it's transient (it dies with
// the party), and it must not show up in the sidebar as a library you can go
// browsing through. Persisted to localStorage anyway so a window reload with
// ?src=party in the URL can still resolve the address.
const PARTY_SRC = "party";
const PARTY_LS_KEY = "locality.partyServer";

export function setPartyServer(s: { url: string; token: string } | null) {
  if (s?.url) localStorage.setItem(PARTY_LS_KEY, JSON.stringify(s));
  else localStorage.removeItem(PARTY_LS_KEY);
}
function partyServer(): { url: string; token: string } | null {
  try {
    const raw = localStorage.getItem(PARTY_LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function serverById(id: string): RemoteServer | null {
  return loadServers().find((s) => s.id === id) ?? null;
}

/** The remote server currently being browsed, or null when on the local one. */
export function activeRemoteServer(): RemoteServer | null {
  return activeSourceId === "local" ? null : serverById(activeSourceId);
}

/** Resolve a source id to its API base URL + optional token. */
export function sourceBase(id: string = activeSourceId): string {
  if (id === "local") return LOCAL_BASE;
  if (id === PARTY_SRC) {
    const p = partyServer();
    return p ? p.url.replace(/\/+$/, "") + "/api" : LOCAL_BASE;
  }
  const s = serverById(id);
  return s ? s.url.replace(/\/+$/, "") + "/api" : LOCAL_BASE;
}
export function sourceToken(id: string = activeSourceId): string | undefined {
  if (id === "local") return undefined;
  if (id === PARTY_SRC) return partyServer()?.token || undefined;
  return serverById(id)?.token || undefined;
}

/** Append the active source to an internal link path. */
export function lp(path: string, id: string = activeSourceId): string {
  if (id === "local") return path;
  return path + (path.includes("?") ? "&" : "?") + "src=" + encodeURIComponent(id);
}

export function imgUrl(rel: string | null | undefined, id: string = activeSourceId): string | undefined {
  if (!rel) return undefined;
  const token = sourceToken(id);
  return `${sourceBase(id)}/images/${rel}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export async function apiFrom<T = any>(sourceId: string, path: string, init?: RequestInit): Promise<T> {
  const token = sourceToken(sourceId);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (token) headers["X-Locality-Token"] = token;
  // Profiles belong to the local server; a remote server serves its own default.
  const profile = getActiveProfile();
  if (profile && sourceId === "local") headers["X-Locality-Profile"] = profile;
  const res = await fetch(sourceBase(sourceId) + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  return apiFrom<T>(activeSourceId, path, init);
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) =>
  api<T>(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T = any>(p: string, body?: unknown) =>
  api<T>(p, { method: "PUT", body: JSON.stringify(body) });
export const del = <T = any>(p: string) => api<T>(p, { method: "DELETE" });

/** A server published to a cloud account, as returned by /cloud/servers. */
export interface PublishedServer {
  serverId: string;
  name: string;
  port: number;
  /** Preference-ordered. `remote` entries are a full URL, the rest bare hosts. */
  addresses: { host: string; kind: string }[];
  token: string;
  lastSeen: string | null;
}

/** Base URL for one published address entry. */
export function addressUrl(a: { host: string }, port: number): string {
  return /^https?:\/\//i.test(a.host) ? a.host.replace(/\/+$/, "") : `http://${a.host}:${port}`;
}

/**
 * Find a working address for a published server. All addresses are tried at
 * once, but the winner is the first that answers *in preference order* (LAN,
 * Tailscale, then the Cloudflare tunnel), so at home we stay on the direct route
 * even if the tunnel happens to reply sooner.
 *
 * Each probe carries its own timeout: without one, an address that silently
 * drops packets (a LAN IP from another network the other PC is also on) would
 * hang the dialog for as long as the browser's default takes.
 */
export async function probePublishedServer(s: PublishedServer): Promise<{ url: string; name: string } | null> {
  const attempts = s.addresses.map(async (a) => {
    const url = addressUrl(a, s.port);
    try {
      const res = await fetch(`${url}/api/state`, {
        headers: s.token ? { "X-Locality-Token": s.token } : {},
        signal: AbortSignal.timeout(a.kind === "remote" ? 10000 : 3000),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.libraries)) return null;
      return { url, name: data.serverName || s.name || url };
    } catch {
      return null;
    }
  });
  for (const p of attempts) {
    const hit = await p;
    if (hit) return hit;
  }
  return null;
}

/** Probe a server before saving it. Returns its reported name + libraries. */
export async function testServer(url: string, token: string): Promise<{ name: string; libraries: any[] }> {
  const base = url.replace(/\/+$/, "") + "/api";
  const res = await fetch(base + "/state", {
    headers: token ? { "X-Locality-Token": token } : {},
  });
  if (res.status === 401) throw new Error("Wrong or missing access token");
  if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.libraries)) throw new Error("That doesn't look like a Locality server");
  return { name: data.serverName || url.replace(/^https?:\/\//, ""), libraries: data.libraries };
}

// ---- server-sent events (LOCAL only) -------------------------------------------
// Live scan/detect/player events are inherently local; remote browsing is
// request/response. Keeping SSE pinned to the local server avoids reconnect
// churn when switching sources.

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;

// EventSource only delivers named events you've explicitly subscribed to, so a
// type missing here silently never fires — that's what had "subs-updated" doing
// nothing until the player grew a polling fallback.
const KNOWN_EVENTS = [
  "scan", "library-changed", "item-changed", "ledger-merged",
  "player", "player-error", "detect", "cloud", "subs-updated", "remote", "download", "config-synced",
  "party",
];

function ensureSource() {
  if (source) return;
  source = new EventSource(`${LOCAL_BASE}/events`);
  for (const type of KNOWN_EVENTS) {
    source.addEventListener(type, (e) => {
      let data: any = null;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {}
      handlers.get(type)?.forEach((h) => h(data));
    });
  }
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

export function subscribe(type: string, handler: Handler): () => void {
  ensureSource();
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler);
  return () => handlers.get(type)!.delete(handler);
}

// ---- misc helpers ----------------------------------------------------------------

export function fmtTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + " GB";
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(0) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

declare global {
  interface Window {
    locality: {
      chooseFolder(): Promise<string | null>;
      chooseFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
      showInFolder(p: string): Promise<void>;
      enterServerMode(): Promise<void>;
      setAutostart(enabled: boolean): Promise<void>;
      /** Experimental mpv playback engine. */
      mpv: {
        start(fileId: number, startSec?: number, title?: string, hasNext?: boolean, alang?: string, slang?: string): Promise<{ ok?: boolean; error?: string; url?: string; bin?: string }>;
        command(command: unknown[]): Promise<void>;
        stop(): Promise<void>;
        next(): Promise<void>;
        fullscreen(): Promise<void>;
        subSearch(): Promise<void>;
        subAddFile(): Promise<void>;
        closeSubSearch(): Promise<void>;
        onEvent(cb: (data: { type: string; name?: string; value?: unknown; message?: string; code?: number | null }) => void): () => void;
      };
    };
  }
}
