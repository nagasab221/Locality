// Optional Supabase account + watch-progress sync.
//
// Design rules (deliberate):
//  - OFFLINE-FIRST. SQLite stays the source of truth and locality.json stays
//    the portable copy. The cloud is a THIRD mirror, never a dependency: signed
//    out, or with no internet, every feature still works exactly as before.
//  - SERVER-CENTRIC. This desktop server holds the session, so anything that
//    talks to it (the local UI, a phone on the LAN) gets sync for free without
//    each client needing credentials.
//  - Same merge rule as everywhere else in this app: per fingerprint, the
//    newest `last_updated` wins. Push and pull both obey it, so two machines
//    can't clobber each other.
//
// Uses Supabase's REST endpoints directly (no @supabase/supabase-js) — the app
// already speaks raw fetch to four other APIs, and it keeps `npm install` (and
// the better-sqlite3 ABI dance) out of this feature entirely.
import os from "os";
import fs from "fs";
import crypto from "crypto";
import type { DB } from "../db";
import { getSetting, setSetting } from "../db";
import type { ProgressLedger } from "./progressLedger";
import { appFetch } from "./http";
import { events } from "./events";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./cloudConfig";

const TABLE = "watch_progress";
const SERVERS_TABLE = "servers";
const CONFIG_TABLE = "user_settings";

/**
 * Settings that follow the account. User-level preferences and the user's OWN
 * API keys — never device/security values (serverId, lanToken, the auth session,
 * or the network/autostart toggles, which must not auto-enable on a new machine).
 */
const SYNC_SETTING_KEYS = [
  "tmdbApiKey", "osApiKey", "osUsername", "osPassword",
  "defaultSubLang", "backgroundScan", "theme",
  "autoplayNext", "upNextSeconds", "skipIntro", "minMovieSizeMB",
];
/** Push soon after playback stops ticking, but coalesce bursts of updates. */
const PUSH_DEBOUNCE_MS = 4000;
/** Background pull cadence — picks up other devices' progress. */
const PULL_INTERVAL_MS = 5 * 60 * 1000;

/** One row of the account's address book, as handed to the connect dialog. */
export interface PublishedServer {
  serverId: string;
  name: string;
  port: number;
  /** Preference-ordered; `remote` entries are a full URL, the rest bare hosts. */
  addresses: { host: string; kind: string }[];
  token: string;
  lastSeen: string | null;
}

export interface CloudStatus {
  configured: boolean; // URL + anon key present
  signedIn: boolean;
  email: string | null;
  syncing: boolean;
  lastSync: string | null;
  lastError: string | null;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  userId: string;
  email: string;
}

export class CloudSync {
  private session: Session | null = null;
  private syncing = false;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private lastSync: string | null = null;
  private lastError: string | null = null;
  /** Set while applying a cloud pull, so the resulting ledger write doesn't echo back as a push. */
  private applyingRemote = false;
  private configPushTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private ledger: ProgressLedger,
    /** Current public tunnel URL, or null when remote access is off/starting. */
    private publicUrl: () => string | null = () => null,
    /** Kick a scan for a library restored from the cloud (path permitting). */
    private rescanLibrary: (id: number) => void = () => {}
  ) {}

  // ---- config -----------------------------------------------------------------

  // Ships pointing at Locality's own project; the settings keys stay as an
  // escape hatch for anyone self-hosting their own Supabase, but the UI no
  // longer asks — users just sign in.
  private get url(): string {
    return ((getSetting(this.db, "supabaseUrl") || SUPABASE_URL) ?? "").trim().replace(/\/+$/, "");
  }
  private get anonKey(): string {
    return ((getSetting(this.db, "supabaseAnonKey") || SUPABASE_ANON_KEY) ?? "").trim();
  }
  get configured(): boolean {
    return !!this.url && !!this.anonKey;
  }

  /** Stable id for this install, so re-publishing updates the same row. */
  private serverId(): string {
    let id = getSetting(this.db, "serverId");
    if (!id) {
      id = crypto.randomBytes(8).toString("hex");
      setSetting(this.db, "serverId", id);
    }
    return id;
  }

  getStatus(): CloudStatus {
    return {
      configured: this.configured,
      signedIn: !!this.session,
      email: this.session?.email ?? null,
      syncing: this.syncing,
      lastSync: this.lastSync,
      lastError: this.lastError,
    };
  }

  private emit() {
    events.broadcast("cloud", this.getStatus());
  }

  // ---- lifecycle ----------------------------------------------------------------

  /** Restore a stored session and start syncing (no-op when not configured). */
  start() {
    this.ledger.onLocalChange = () => {
      if (!this.applyingRemote) this.schedulePush();
    };
    const refresh = getSetting(this.db, "supabaseRefreshToken");
    if (this.configured && refresh) {
      this.refreshSession(refresh)
        .then(async () => {
          await this.syncConfig("startup"); // pull-first so a reinstall restores
          await this.syncNow("startup");
          await this.publishServer();
        })
        .catch((e) => console.error("cloud: session restore failed:", e));
    }
    this.pullTimer = setInterval(() => {
      if (this.session) {
        void this.syncNow("interval");
        void this.syncConfig("interval");
        void this.publishServer(); // doubles as a heartbeat / IP-change refresh
      }
    }, PULL_INTERVAL_MS);
  }

  stop() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.configPushTimer) clearTimeout(this.configPushTimer);
  }

  // ---- auth -----------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return { apikey: this.anonKey, "Content-Type": "application/json" };
  }

  /** Supabase returns JSON errors; surface its own message rather than a status code. */
  private async parse(res: Response, what: string): Promise<any> {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${what}: server returned a non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const msg =
        body?.error_description || body?.msg || body?.message || body?.error || `${res.status} ${res.statusText}`;
      throw new Error(`${what}: ${msg}`);
    }
    return body;
  }

  private storeSession(data: any) {
    const user = data.user ?? data;
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      userId: user?.id ?? "",
      email: user?.email ?? "",
    };
    setSetting(this.db, "supabaseRefreshToken", data.refresh_token ?? "");
    this.lastError = null;
    this.emit();
  }

  /**
   * Create an account. Requires "Confirm email" to be OFF in the Supabase
   * dashboard — with it on, Supabase returns a user but no session and the
   * account can't be used until the emailed link is clicked.
   */
  async signUp(email: string, password: string): Promise<CloudStatus> {
    if (!this.configured) throw new Error("Set the Supabase URL and anon key first");
    const res = await appFetch(`${this.url}/auth/v1/signup`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await this.parse(res, "Sign up failed");
    if (!data.access_token) {
      // Email confirmation is enabled on the project.
      throw new Error(
        "Account created but it needs email confirmation. Turn OFF “Confirm email” in Supabase → Authentication → Sign In / Providers → Email, then sign in."
      );
    }
    this.storeSession(data);
    console.log(`cloud: signed up as ${this.session?.email}`);
    await this.syncConfig("sign-up");
    await this.syncNow("sign-up");
    await this.publishServer();
    return this.getStatus();
  }

  async signIn(email: string, password: string): Promise<CloudStatus> {
    if (!this.configured) throw new Error("Set the Supabase URL and anon key first");
    const res = await appFetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await this.parse(res, "Sign in failed");
    this.storeSession(data);
    console.log(`cloud: signed in as ${this.session?.email}`);
    await this.syncConfig("sign-in"); // pull-first: restore this account's setup
    await this.syncNow("sign-in");
    await this.publishServer();
    return this.getStatus();
  }

  signOut(): CloudStatus {
    // Withdraw the address book first — a stale row would point phones at a
    // server they can no longer authenticate against.
    const old = this.session;
    if (old) void this.withdrawServer(old);
    this.session = null;
    setSetting(this.db, "supabaseRefreshToken", "");
    this.lastError = null;
    this.lastSync = null;
    console.log("cloud: signed out");
    this.emit();
    return this.getStatus();
  }

  private async refreshSession(refreshToken: string) {
    const res = await appFetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    let data: any;
    try {
      data = await this.parse(res, "Session refresh failed");
    } catch (e) {
      // A dead refresh token means the stored session is useless — drop it so
      // the UI shows "signed out" instead of retrying forever.
      setSetting(this.db, "supabaseRefreshToken", "");
      this.session = null;
      this.emit();
      throw e;
    }
    this.storeSession(data);
  }

  /** Valid access token, refreshing shortly before expiry. */
  private async token(): Promise<string | null> {
    if (!this.session) return null;
    if (Date.now() > this.session.expiresAt - 60_000) {
      await this.refreshSession(this.session.refreshToken);
    }
    return this.session?.accessToken ?? null;
  }

  // ---- borrowed session (watch party) -----------------------------------------------
  //
  // The party feature talks to its own Supabase tables but must NOT own a second
  // session: two independent logins would drift apart on refresh and fight over
  // the stored refresh token. So it borrows this one. Everything below is the
  // minimum surface for that — no party logic leaks into this class.

  /** The signed-in account's user id, or null when signed out. */
  get userId(): string | null {
    return this.session?.userId ?? null;
  }
  get userEmail(): string | null {
    return this.session?.email ?? null;
  }

  /**
   * Authenticated PostgREST call against this project. `path` is everything
   * after /rest/v1/ (e.g. `parties?id=eq.…&select=*`). Returns parsed JSON, or
   * null when signed out — callers treat that as "party features are off".
   */
  async rest<T = any>(path: string, init?: RequestInit & { prefer?: string }): Promise<T | null> {
    if (!this.configured) return null;
    const accessToken = await this.token();
    if (!accessToken) return null;
    const headers: Record<string, string> = {
      apikey: this.anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (init?.prefer) headers.Prefer = init.prefer;
    const res = await appFetch(`${this.url}/rest/v1/${path}`, { ...init, headers });
    // 204 (a DELETE, or a write without Prefer: return=representation) has no body.
    if (res.status === 204) return null as T;
    return (await this.parse(res, "Cloud request failed")) as T;
  }

  /** Call a Postgres function exposed over PostgREST (used for invite lookups). */
  async rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T | null> {
    return this.rest<T>(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  }

  // ---- server discovery -------------------------------------------------------------

  /**
   * Every address a client might reach us on, in preference order. Tailscale
   * hands out 100.64.0.0/10 (CGNAT) addresses which — unlike LAN IPs — stay
   * valid off the home network, and the Cloudflare tunnel works from anywhere
   * at the cost of a round trip through Cloudflare. The phone tries them in this
   * order and stops at the first that answers, so it lands on the cheapest path
   * available without asking the user anything.
   *
   * `remote` entries are a full https URL rather than a bare host; the phone
   * detects the scheme and ignores `port` for those.
   */
  private addresses(): { host: string; kind: "tailscale" | "lan" | "remote" }[] {
    const out: { host: string; kind: "tailscale" | "lan" | "remote" }[] = [];
    const lanEnabled = getSetting(this.db, "lanEnabled") === "1";
    if (lanEnabled) {
      for (const iface of Object.values(os.networkInterfaces())) {
        for (const i of iface ?? []) {
          if (i.family !== "IPv4" || i.internal) continue;
          const [a, b] = i.address.split(".").map(Number);
          const tailscale = a === 100 && b >= 64 && b <= 127;
          out.push({ host: i.address, kind: tailscale ? "tailscale" : "lan" });
        }
      }
      // LAN first (fast, local), Tailscale as the works-anywhere direct route.
      out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "lan" ? -1 : 1));
    }
    const url = this.publicUrl();
    if (url) out.push({ host: url, kind: "remote" }); // last resort, always last
    return out;
  }

  /**
   * Every server published to an account, so the desktop can connect to another
   * machine by signing in rather than by copying an IP and a token around.
   *
   * `accessToken` lets this run for an account we are NOT signed in as (see
   * lookupServers) — connecting to someone else's library must not disturb the
   * session that owns this machine's own sync.
   */
  private async fetchServers(accessToken: string): Promise<PublishedServer[]> {
    const res = await appFetch(
      `${this.url}/rest/v1/${SERVERS_TABLE}?select=server_id,name,port,addresses,token,last_seen&order=last_seen.desc`,
      { headers: { apikey: this.anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
    const rows: any[] = await this.parse(res, "Looking up servers failed");
    const self = this.serverId();
    return rows
      // Our own row would offer to connect the app to itself.
      .filter((r) => r.server_id !== self)
      .map((r) => ({
        serverId: String(r.server_id),
        name: String(r.name ?? ""),
        port: Number(r.port) || 3777,
        addresses: Array.isArray(r.addresses) ? r.addresses : [],
        token: String(r.token ?? ""),
        lastSeen: r.last_seen ?? null,
      }));
  }

  /** Servers on the account this desktop is already signed into. */
  async listServers(): Promise<PublishedServer[]> {
    if (!this.configured) throw new Error("Cloud accounts aren't configured in this build");
    const accessToken = await this.token();
    if (!accessToken) throw new Error("Sign in first, under Settings");
    return this.fetchServers(accessToken);
  }

  /**
   * Sign in just long enough to read another account's server list. Deliberately
   * does NOT call storeSession: the credentials are used once and dropped, so
   * connecting to a friend's library can't sign this machine out of its own
   * account or start syncing your watch progress into theirs.
   */
  async lookupServers(email: string, password: string): Promise<PublishedServer[]> {
    if (!this.configured) throw new Error("Cloud accounts aren't configured in this build");
    const res = await appFetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ email, password }),
    });
    const data = await this.parse(res, "Sign in failed");
    if (!data?.access_token) throw new Error("Sign in failed");
    return this.fetchServers(data.access_token);
  }

  private async withdrawServer(session: Session): Promise<void> {
    try {
      await appFetch(
        `${this.url}/rest/v1/${SERVERS_TABLE}?user_id=eq.${session.userId}&server_id=eq.${encodeURIComponent(this.serverId())}`,
        {
          method: "DELETE",
          headers: {
            apikey: this.anonKey,
            Authorization: `Bearer ${session.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch {
      /* best effort — the row also goes stale on its own via last_seen */
    }
  }

  /**
   * Publish (or withdraw) this server's address book so the phone can find it
   * after a plain sign-in instead of typing an IP. Called on sign-in, at
   * startup, after a settings change, on the 5-minute heartbeat, and whenever
   * the tunnel URL changes.
   */
  async publishServer(): Promise<void> {
    if (!this.session || !this.configured) return;
    try {
      const accessToken = await this.token();
      if (!accessToken) return;
      const headers = {
        apikey: this.anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
      const sid = this.serverId();
      const addresses = this.addresses();

      // Nothing reachable to advertise (both LAN and remote off, or the tunnel
      // hasn't come up yet). A row pointing at a server that isn't listening is
      // worse than no row: the phone would sit there retrying a dead address.
      if (addresses.length === 0) {
        await appFetch(
          `${this.url}/rest/v1/${SERVERS_TABLE}?user_id=eq.${this.session.userId}&server_id=eq.${encodeURIComponent(sid)}`,
          { method: "DELETE", headers }
        );
        return;
      }

      const row = {
        user_id: this.session.userId,
        server_id: sid,
        name: getSetting(this.db, "serverName") || os.hostname(),
        port: Number(getSetting(this.db, "lanPort")) || 3777,
        addresses,
        token: getSetting(this.db, "lanToken") ?? "",
        last_seen: new Date().toISOString(),
      };
      const res = await appFetch(`${this.url}/rest/v1/${SERVERS_TABLE}?on_conflict=user_id,server_id`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([row]),
      });
      if (!res.ok) await this.parse(res, "Publishing this server failed");
      console.log(`cloud: published server "${row.name}" (${row.addresses.map((a) => a.host).join(", ") || "no addresses"})`);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      console.error("cloud: publish failed:", this.lastError);
      this.emit();
    }
  }

  // ---- account server management (Settings > Account) ---------------------------

  /** Every server row published under this account, this PC flagged as `isSelf`. */
  async listAccountServers(): Promise<{ serverId: string; name: string; lastSeen: string | null; isSelf: boolean }[]> {
    const rows = await this.rest<any[]>(`${SERVERS_TABLE}?select=server_id,name,last_seen&order=last_seen.desc`);
    const self = this.serverId();
    return (rows ?? []).map((r) => ({
      serverId: String(r.server_id),
      name: String(r.name ?? ""),
      lastSeen: r.last_seen ?? null,
      isSelf: String(r.server_id) === self,
    }));
  }

  /**
   * Rename a server. For THIS PC the name is also stored locally so it survives
   * the next publish; for another device it holds until that device next
   * republishes its own hostname (nothing here can reach across to stop that).
   */
  async renameServer(serverId: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error("A name is required");
    if (serverId === this.serverId()) setSetting(this.db, "serverName", clean);
    await this.rest(`${SERVERS_TABLE}?server_id=eq.${encodeURIComponent(serverId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: clean }),
    });
  }

  /** Remove a server row from the account (for a device you no longer use). */
  async removeServer(serverId: string): Promise<void> {
    if (serverId === this.serverId()) setSetting(this.db, "serverName", "");
    await this.rest(`${SERVERS_TABLE}?server_id=eq.${encodeURIComponent(serverId)}`, { method: "DELETE" });
  }

  // ---- settings + library sync --------------------------------------------------

  /** Local "config last changed" time; unset (epoch) until the user edits something. */
  private get configUpdatedAt(): number {
    return Number(getSetting(this.db, "configUpdatedAt")) || 0;
  }
  private set configUpdatedAt(ms: number) {
    setSetting(this.db, "configUpdatedAt", String(ms));
  }

  /** Called by the routes when settings or libraries change: stamp + push soon. */
  markConfigChanged() {
    this.configUpdatedAt = Date.now();
    if (!this.session) return;
    if (this.configPushTimer) clearTimeout(this.configPushTimer);
    this.configPushTimer = setTimeout(() => {
      this.configPushTimer = null;
      void this.syncConfig("local-change");
    }, PUSH_DEBOUNCE_MS);
  }

  /** The blob we store per user: syncable settings + library definitions. */
  private buildConfigBlob(): { settings: Record<string, string>; libraries: any[] } {
    const settings: Record<string, string> = {};
    for (const k of SYNC_SETTING_KEYS) {
      const v = getSetting(this.db, k);
      if (v) settings[k] = v;
    }
    // Blob array order = sidebar order; applyConfigBlob restores it by index.
    const libs = this.db
      .prepare("SELECT id, name, type, path FROM libraries WHERE internal = 0 ORDER BY COALESCE(position, 999999999), name, id")
      .all() as { id: number; name: string; type: string; path: string }[];
    const libraries = libs.map((l) => ({
      name: l.name,
      type: l.type,
      path: l.path,
      folders: (this.db.prepare("SELECT path FROM library_folders WHERE library_id = ?").all(l.id) as { path: string }[]).map((f) => f.path),
    }));
    return { settings, libraries };
  }

  /** Apply a pulled blob: overwrite synced settings, add any missing libraries. */
  private applyConfigBlob(data: { settings?: Record<string, string>; libraries?: any[] }) {
    for (const k of SYNC_SETTING_KEYS) {
      if (data.settings && typeof data.settings[k] === "string") setSetting(this.db, k, data.settings[k]);
    }
    for (const [i, lib] of (data.libraries ?? []).entries()) {
      if (!lib?.path || typeof lib.path !== "string") continue;
      const exists = this.db.prepare("SELECT id FROM libraries WHERE path = ?").get(lib.path) as { id: number } | undefined;
      if (exists) {
        // Already have this folder as a library — just take the account's order.
        this.db.prepare("UPDATE libraries SET position = ? WHERE id = ?").run(i, exists.id);
        continue;
      }
      const type = ["movies", "tv", "gallery", "other"].includes(lib.type) ? lib.type : "movies";
      let id: number;
      try {
        // Restore even when the folder is missing on THIS machine — the config is
        // preserved (and re-pushed), and an existing-path library scans normally.
        const info = this.db
          .prepare("INSERT INTO libraries (name, type, path, position) VALUES (?, ?, ?, ?)")
          .run(String(lib.name ?? "Library"), type, lib.path, i);
        id = Number(info.lastInsertRowid);
      } catch {
        continue; // UNIQUE clash etc.
      }
      for (const f of lib.folders ?? []) {
        if (typeof f === "string") {
          try {
            this.db.prepare("INSERT OR IGNORE INTO library_folders (library_id, path) VALUES (?, ?)").run(id, f);
          } catch {
            /* folder already belongs somewhere */
          }
        }
      }
      try {
        if (fs.existsSync(lib.path)) this.rescanLibrary(id);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Two-way settings/library sync, newest-wins at the blob level. PULL-FIRST: a
   * fresh install (configUpdatedAt = 0) always loses to a real remote, so it
   * restores instead of clobbering the cloud with its empty config.
   */
  async syncConfig(reason: string): Promise<void> {
    if (!this.session) return;
    try {
      const accessToken = await this.token();
      if (!accessToken) return;
      const headers = { apikey: this.anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

      const res = await appFetch(`${this.url}/rest/v1/${CONFIG_TABLE}?select=data,last_updated&limit=1`, { headers });
      const rows: any[] = await this.parse(res, "Settings pull failed");
      const remote = rows[0];
      const remoteTs = remote ? Date.parse(remote.last_updated) : 0;
      const localTs = this.configUpdatedAt;

      if (remote && remoteTs > localTs) {
        this.applyConfigBlob(remote.data ?? {});
        this.configUpdatedAt = remoteTs;
        events.broadcast("config-synced", { restored: true });
        console.log(`cloud settings (${reason}): restored from the account`);
        return;
      }

      // Push when we're newer — or seed the account if it has nothing yet and we
      // actually have something worth saving.
      const haveLocal = localTs > 0 || (this.db.prepare("SELECT 1 FROM libraries WHERE internal = 0 LIMIT 1").get() as unknown);
      if (localTs > remoteTs || (!remote && haveLocal)) {
        const ts = Math.max(localTs, Date.now());
        this.configUpdatedAt = ts;
        const up = await appFetch(`${this.url}/rest/v1/${CONFIG_TABLE}?on_conflict=user_id`, {
          method: "POST",
          headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ user_id: this.session.userId, data: this.buildConfigBlob(), last_updated: new Date(ts).toISOString() }]),
        });
        if (!up.ok) await this.parse(up, "Settings push failed");
        console.log(`cloud settings (${reason}): pushed`);
      }
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      console.error(`cloud settings (${reason}) failed:`, this.lastError);
    }
  }

  // ---- sync ---------------------------------------------------------------------

  private schedulePush() {
    if (!this.session) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.syncNow("local-change");
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * Full two-way sync. The ledger is small (one row per file ever played), so
   * we compare everything rather than tracking deltas — simpler and immune to
   * a missed change. Newest `last_updated` wins in both directions.
   */
  async syncNow(reason: string): Promise<CloudStatus> {
    if (!this.session || this.syncing) return this.getStatus();
    this.syncing = true;
    this.emit();
    try {
      const accessToken = await this.token();
      if (!accessToken) return this.getStatus();
      const headers = {
        apikey: this.anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };

      // --- pull ---
      const res = await appFetch(
        `${this.url}/rest/v1/${TABLE}?select=fingerprint,filename,size_bytes,duration_seconds,position_seconds,watched,last_updated`,
        { headers }
      );
      const remote: any[] = await this.parse(res, "Cloud pull failed");
      const remoteByFp = new Map<string, any>(remote.map((r) => [r.fingerprint, r]));

      this.applyingRemote = true;
      let pulled = 0;
      try {
        pulled = this.ledger.mergeEntries(
          remote.map((r) => ({
            fingerprint: r.fingerprint,
            filename: r.filename,
            size_bytes: r.size_bytes,
            duration_seconds: r.duration_seconds,
            position_seconds: r.position_seconds,
            watched: r.watched,
            // Postgres timestamptz -> the ISO form the ledger compares on
            last_updated: new Date(r.last_updated).toISOString().replace(/\.\d{3}Z$/, "Z"),
          }))
        );
      } finally {
        this.applyingRemote = false;
      }

      // --- push (only rows we hold newer than the cloud) ---
      const local = this.ledger.allEntries();
      const outgoing = Object.entries(local)
        .filter(([fp, e]) => {
          const r = remoteByFp.get(fp);
          return !r || Date.parse(e.last_updated) > Date.parse(r.last_updated);
        })
        .map(([fp, e]) => ({
          user_id: this.session!.userId,
          fingerprint: fp,
          filename: e.filename,
          size_bytes: e.size_bytes,
          duration_seconds: e.duration_seconds,
          position_seconds: e.position_seconds,
          watched: e.watched,
          last_updated: e.last_updated,
        }));

      if (outgoing.length > 0) {
        // Chunked upsert; conflict target matches the table's composite PK.
        for (let i = 0; i < outgoing.length; i += 500) {
          const chunk = outgoing.slice(i, i + 500);
          const up = await appFetch(`${this.url}/rest/v1/${TABLE}?on_conflict=user_id,fingerprint`, {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(chunk),
          });
          if (!up.ok) await this.parse(up, "Cloud push failed");
        }
      }

      this.lastSync = new Date().toISOString();
      this.lastError = null;
      if (pulled > 0 || outgoing.length > 0) {
        console.log(`cloud sync (${reason}): pulled ${pulled}, pushed ${outgoing.length}`);
        if (pulled > 0) events.broadcast("ledger-merged", { changed: pulled });
      }
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      console.error(`cloud sync (${reason}) failed:`, this.lastError);
    } finally {
      this.syncing = false;
      this.emit();
    }
    return this.getStatus();
  }
}
