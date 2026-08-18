// Watch party — two people (up to PARTY_MAX) watching the same thing in step.
//
// Two modes, chosen when the party is created:
//   "local"  — everyone plays their OWN copy. The party carries Locality's
//              path-independent fingerprint (sha1 of filename+size), each
//              member resolves it against their own library, and no video
//              crosses the network. Works with remote access switched off.
//   "stream" — only the host has the file. The party carries the host's tunnel
//              URL + server token, and guests play it as a remote source.
//
// Design rules, same as cloudSync.ts:
//  - OFFLINE-FIRST. Signed out or offline, nothing here runs and every other
//    feature behaves exactly as before.
//  - The SESSION IS BORROWED from CloudSync (see cloud.rest/cloud.rpc). A second
//    login would drift on refresh and fight over the stored refresh token.
//  - Supabase is reached over plain PostgREST. Playback state is POLLED rather
//    than pushed over Realtime, so this needs no websocket and no publication —
//    the cost is up to one poll interval of lag on a pause.
import type { DB } from "../db";
import { getSetting, setSetting } from "../db";
import type { CloudSync } from "./cloudSync";
import { events } from "./events";

/** Hard cap on party size. The UI stops you before this; the server enforces it. */
export const PARTY_MAX = 6;

/** How often the state row is read while a party is running. */
const STATE_POLL_MS = 700;
/** Member list changes are rare — poll it every Nth state tick. */
const MEMBER_POLL_EVERY = 5;
/** Invite inbox poll while idle (no party). Cheap and not latency-critical. */
const INVITE_POLL_MS = 8000;
/** Tell the others we're still here. */
const HEARTBEAT_MS = 15_000;
/** A member counts as "in the player" if they pinged presence within this window. */
const PRESENCE_FRESH_MS = 12_000;

export type PartyMode = "local" | "stream";

export interface PartyMember {
  userId: string;
  username: string;
  status: "invited" | "joined" | "declined" | "left";
  isHost: boolean;
  hasFile: boolean;
  lastSeen: string | null;
  /** True when this member currently has the player open (watching_at is fresh). */
  watching: boolean;
}

export interface PartyPlayback {
  position: number;
  paused: boolean;
  seq: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface PartyInvite {
  partyId: string;
  title: string;
  mode: PartyMode;
  hostUsername: string;
  /** Whether this machine can find the fingerprint in its own library. */
  hasFile: boolean;
}

export interface PartyContact {
  userId: string;
  username: string;
  email: string;
  lastUsed: string | null;
}

export interface ActiveParty {
  id: string;
  mode: PartyMode;
  title: string;
  fingerprint: string;
  hostFileId: number | null;
  isHost: boolean;
  members: PartyMember[];
  playback: PartyPlayback;
  /** "stream" guests only: where to fetch the video from. */
  hostServer: { url: string; token: string } | null;
  /** This machine's own file id for the party's fingerprint, when it has it. */
  localFileId: number | null;
}

export interface PartySnapshot {
  configured: boolean;
  signedIn: boolean;
  /** This account's id, so a player can tell its own echo from someone else's action. */
  userId: string | null;
  username: string | null;
  /** The address the invite field pre-fills with next time. */
  lastInvite: string;
  party: ActiveParty | null;
  invites: PartyInvite[];
  contacts: PartyContact[];
  error: string | null;
}

const USERNAME_RE = /^[A-Za-z]+$/;
const LAST_INVITE_KEY = "partyLastInvite";

/** Letters only, as specified. Returns the cleaned name or throws. */
export function validateUsername(raw: string): string {
  const name = String(raw ?? "").trim();
  if (name.length < 3 || name.length > 20) throw new Error("Username must be 3–20 characters");
  if (!USERNAME_RE.test(name)) throw new Error("Username can only contain letters (A–Z)");
  return name;
}

export class Party {
  private username: string | null = null;
  private party: ActiveParty | null = null;
  private invites: PartyInvite[] = [];
  private contacts: PartyContact[] = [];
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private lastHeartbeat = 0;
  /** Last snapshot signature broadcast, so an unchanged poll stays silent. */
  private lastSig = "";
  /** Set while a local action is in flight, so the poll can't overwrite it. */
  private pendingSeq = 0;

  constructor(
    private db: DB,
    private cloud: CloudSync,
    /** Current public tunnel URL, or null when remote access is off. */
    private publicUrl: () => string | null = () => null
  ) {}

  // ---- lifecycle ----------------------------------------------------------------

  start() {
    this.schedule();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One self-rescheduling loop; the interval depends on whether a party is live. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    const delay = this.party ? STATE_POLL_MS : INVITE_POLL_MS;
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((e) => {
          // A transient network blip must not kill the loop.
          this.error = String(e?.message ?? e);
        })
        .finally(() => this.schedule());
    }, delay);
  }

  private async poll() {
    if (!this.cloud.userId) {
      // Signed out: drop any stale party so the UI doesn't show a dead one.
      if (this.party || this.invites.length) {
        this.party = null;
        this.invites = [];
        this.emit();
      }
      return;
    }
    this.tick++;
    if (this.party) {
      await this.pullState();
      if (this.tick % MEMBER_POLL_EVERY === 0) await this.pullMembers();
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_MS) await this.heartbeat();
    } else {
      await this.pullInvites();
    }
    this.error = null; // a poll got through, so whatever failed before is over
    this.emit();
  }

  // ---- identity -----------------------------------------------------------------

  /** The account's username, loaded from the cloud profile once per session. */
  async loadProfile(): Promise<string | null> {
    if (!this.cloud.userId) return null;
    if (this.username) return this.username;
    const rows = await this.cloud.rest<any[]>(
      `profiles?user_id=eq.${this.cloud.userId}&select=username`
    );
    this.username = rows?.[0]?.username ?? null;
    return this.username;
  }

  /** Claim a username. Letters only; the unique index makes the race safe. */
  async setUsername(raw: string): Promise<string> {
    const name = validateUsername(raw);
    if (!this.cloud.userId) throw new Error("Sign in to your Locality account first");
    try {
      await this.cloud.rest("profiles", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: JSON.stringify({
          user_id: this.cloud.userId,
          username: name,
          email: this.cloud.userEmail ?? "",
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (e: any) {
      // 23505 is the unique index on lower(username).
      if (String(e?.message ?? e).includes("23505") || /duplicate/i.test(String(e?.message ?? e)))
        throw new Error(`"${name}" is taken — pick another`);
      throw e;
    }
    this.username = name;
    this.emit();
    return name;
  }

  // ---- invites ------------------------------------------------------------------

  /** Exact-match lookup by email or username (see locality_find_user in schema.sql). */
  async findUser(identifier: string): Promise<{ userId: string; username: string } | null> {
    const id = String(identifier ?? "").trim();
    if (!id) return null;
    const rows = await this.cloud.rpc<any[]>("locality_find_user", { identifier: id });
    const hit = rows?.[0];
    return hit ? { userId: hit.user_id, username: hit.username } : null;
  }

  /** Invite someone to the party we're hosting, by email or username. */
  async invite(identifier: string): Promise<PartyMember> {
    const party = this.requireParty();
    if (!party.isHost) throw new Error("Only the host can invite people");
    if (party.members.filter((m) => m.status !== "declined" && m.status !== "left").length >= PARTY_MAX)
      throw new Error(`A party can hold ${PARTY_MAX} people`);
    const found = await this.findUser(identifier);
    if (!found) throw new Error(`No Locality account for "${identifier}"`);
    if (found.userId === this.cloud.userId) throw new Error("That's you");
    if (party.members.some((m) => m.userId === found.userId && m.status === "joined"))
      throw new Error(`${found.username} is already here`);

    await this.cloud.rest("party_members", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: JSON.stringify({
        party_id: party.id,
        user_id: found.userId,
        username: found.username,
        status: "invited",
        is_host: false,
      }),
    });
    // Remember them, so next time it's one click. The typed address is what
    // pre-fills the field, so store exactly what was typed.
    setSetting(this.db, LAST_INVITE_KEY, String(identifier).trim());
    await this.cloud.rest("party_contacts", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: JSON.stringify({
        owner_id: this.cloud.userId,
        user_id: found.userId,
        username: found.username,
        email: String(identifier).includes("@") ? String(identifier).trim() : "",
        last_used: new Date().toISOString(),
      }),
    });
    await this.pullMembers();
    this.emit();
    return {
      userId: found.userId,
      username: found.username,
      status: "invited",
      isHost: false,
      hasFile: false,
      lastSeen: null,
      watching: false,
    };
  }

  private async pullInvites() {
    const rows = await this.cloud.rest<any[]>(
      `party_members?user_id=eq.${this.cloud.userId}&status=eq.invited` +
        `&select=party_id,parties(id,title,mode,fingerprint,host_id,ended_at)`
    );
    const open = (rows ?? []).filter((r) => r.parties && !r.parties.ended_at);
    this.invites = open.map((r) => ({
      partyId: String(r.party_id),
      title: String(r.parties.title ?? ""),
      mode: (r.parties.mode === "stream" ? "stream" : "local") as PartyMode,
      hostUsername: "",
      hasFile: !!this.localFileFor(String(r.parties.fingerprint ?? "")),
    }));
    // The host's name isn't on the party row; read it off their member row,
    // which every invitee is allowed to see.
    for (const inv of this.invites) {
      const hosts = await this.cloud.rest<any[]>(
        `party_members?party_id=eq.${inv.partyId}&is_host=is.true&select=username`
      );
      inv.hostUsername = hosts?.[0]?.username ?? "";
    }
  }

  async accept(partyId: string): Promise<ActiveParty> {
    if (this.party && this.party.id !== partyId) await this.leave();
    await this.cloud.rest(
      `party_members?party_id=eq.${partyId}&user_id=eq.${this.cloud.userId}`,
      { method: "PATCH", body: JSON.stringify({ status: "joined", last_seen: new Date().toISOString() }) }
    );
    await this.adopt(partyId);
    // The invite is now a relationship worth remembering in both directions.
    const host = this.party?.members.find((m) => m.isHost);
    if (host)
      await this.cloud.rest("party_contacts", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: JSON.stringify({
          owner_id: this.cloud.userId,
          user_id: host.userId,
          username: host.username,
          last_used: new Date().toISOString(),
        }),
      });
    this.emit();
    return this.requireParty();
  }

  async decline(partyId: string): Promise<void> {
    await this.cloud.rest(
      `party_members?party_id=eq.${partyId}&user_id=eq.${this.cloud.userId}`,
      { method: "PATCH", body: JSON.stringify({ status: "declined" }) }
    );
    this.invites = this.invites.filter((i) => i.partyId !== partyId);
    this.emit();
  }

  // ---- party lifecycle ------------------------------------------------------------

  /**
   * Start hosting. `mode` decides whether guests play their own copy or stream
   * this one; "stream" needs remote access on, since that's the only address a
   * guest outside the LAN can reach.
   */
  async host(fileId: number, mode: PartyMode): Promise<ActiveParty> {
    if (!this.cloud.userId) throw new Error("Sign in to your Locality account first");
    const username = await this.loadProfile();
    if (!username) throw new Error("Pick a username first");
    const file = this.db
      .prepare("SELECT id, filename, fingerprint FROM files WHERE id = ?")
      .get(fileId) as { id: number; filename: string; fingerprint: string } | undefined;
    if (!file) throw new Error("That file isn't in this library any more");

    let hostServer: { url: string; token: string } | null = null;
    if (mode === "stream") {
      const url = this.publicUrl();
      if (!url)
        throw new Error(
          "Streaming to your guests needs remote access. Turn it on in Settings → Network, then start the party."
        );
      hostServer = { url, token: getSetting(this.db, "lanToken") ?? "" };
    }

    if (this.party) await this.leave();

    const created = await this.cloud.rest<any[]>("parties", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({
        host_id: this.cloud.userId,
        mode,
        title: this.titleFor(fileId) || file.filename,
        fingerprint: file.fingerprint,
        host_file_id: fileId,
        host_server: hostServer ?? {},
      }),
    });
    const partyId = String(created?.[0]?.id ?? "");
    if (!partyId) throw new Error("Could not create the party");

    await this.cloud.rest("party_members", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: JSON.stringify({
        party_id: partyId,
        user_id: this.cloud.userId,
        username,
        status: "joined",
        is_host: true,
        has_file: true,
      }),
    });
    await this.cloud.rest("party_state", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: JSON.stringify({ party_id: partyId, position_seconds: 0, paused: true, seq: 0 }),
    });
    await this.adopt(partyId);
    this.emit();
    return this.requireParty();
  }

  /** Load a party we're a member of and make it the active one. */
  private async adopt(partyId: string) {
    const rows = await this.cloud.rest<any[]>(
      `parties?id=eq.${partyId}&select=id,mode,title,fingerprint,host_file_id,host_server,host_id,ended_at`
    );
    const p = rows?.[0];
    if (!p) throw new Error("That party no longer exists");
    if (p.ended_at) throw new Error("That party has ended");
    const isHost = p.host_id === this.cloud.userId;
    const hs = p.host_server && typeof p.host_server === "object" ? p.host_server : {};
    this.party = {
      id: String(p.id),
      mode: p.mode === "stream" ? "stream" : "local",
      title: String(p.title ?? ""),
      fingerprint: String(p.fingerprint ?? ""),
      hostFileId: p.host_file_id == null ? null : Number(p.host_file_id),
      isHost,
      members: [],
      playback: { position: 0, paused: true, seq: 0, updatedBy: null, updatedAt: null },
      hostServer: !isHost && hs.url ? { url: String(hs.url), token: String(hs.token ?? "") } : null,
      localFileId: this.localFileFor(String(p.fingerprint ?? "")),
    };
    this.invites = this.invites.filter((i) => i.partyId !== partyId);
    await this.pullMembers();
    await this.pullState();
    await this.heartbeat();
    this.schedule(); // switch the loop to the fast cadence
  }

  /** Leave the party. The host ending it closes it for everyone. */
  async leave(): Promise<void> {
    const party = this.party;
    this.party = null;
    this.schedule();
    if (!party || !this.cloud.userId) {
      this.emit();
      return;
    }
    try {
      if (party.isHost) {
        await this.cloud.rest(`parties?id=eq.${party.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ended_at: new Date().toISOString() }),
        });
      }
      await this.cloud.rest(`party_members?party_id=eq.${party.id}&user_id=eq.${this.cloud.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "left" }),
      });
    } catch {
      /* best effort — the row also ages out via last_seen */
    }
    this.emit();
  }

  // ---- playback state -------------------------------------------------------------

  /**
   * Publish a local play/pause/seek to everyone.
   *
   * Anyone may control playback, so two near-simultaneous actions need a total
   * order: `seq` increments on every write and the highest wins. Bumping our
   * cached seq immediately means the next poll can't hand us back the older
   * value and undo what the user just did.
   */
  async publish(position: number, paused: boolean): Promise<void> {
    const party = this.requireParty();
    const seq = Math.max(party.playback.seq, this.pendingSeq) + 1;
    this.pendingSeq = seq;
    party.playback = {
      position,
      paused,
      seq,
      updatedBy: this.cloud.userId,
      updatedAt: new Date().toISOString(),
    };
    this.emit();
    await this.cloud.rest(`party_state?party_id=eq.${party.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        position_seconds: position,
        paused,
        seq,
        updated_by: this.cloud.userId,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  private async pullState() {
    const party = this.party;
    if (!party) return;
    const rows = await this.cloud.rest<any[]>(
      `party_state?party_id=eq.${party.id}&select=position_seconds,paused,seq,updated_by,updated_at`
    );
    const s = rows?.[0];
    if (!s) return;
    const seq = Number(s.seq) || 0;
    // Our own newer write hasn't landed in this read yet — keep ours.
    if (seq < party.playback.seq) return;
    party.playback = {
      position: Number(s.position_seconds) || 0,
      paused: !!s.paused,
      seq,
      updatedBy: s.updated_by ?? null,
      updatedAt: s.updated_at ?? null,
    };
  }

  private async pullMembers() {
    const party = this.party;
    if (!party) return;
    const rows = await this.cloud.rest<any[]>(
      `party_members?party_id=eq.${party.id}&select=user_id,username,status,is_host,has_file,last_seen&order=is_host.desc`
    );
    party.members = (rows ?? []).map((r) => ({
      userId: String(r.user_id),
      username: String(r.username ?? ""),
      status: r.status,
      isHost: !!r.is_host,
      hasFile: !!r.has_file,
      lastSeen: r.last_seen ?? null,
      watching: false,
    }));
    // Presence is a SEPARATE best-effort read so a project that hasn't run the
    // watching_at migration yet still gets a fully working party (just no dots).
    try {
      const pres = await this.cloud.rest<any[]>(`party_members?party_id=eq.${party.id}&select=user_id,watching_at`);
      const fresh = new Map(
        (pres ?? []).map((r) => [String(r.user_id), !!r.watching_at && Date.now() - Date.parse(r.watching_at) < PRESENCE_FRESH_MS])
      );
      for (const m of party.members) m.watching = fresh.get(m.userId) ?? false;
    } catch {
      /* column not present yet — leave everyone as not-watching */
    }
    // The host closing the party (or us being removed) ends it here too.
    const me = party.members.find((m) => m.userId === this.cloud.userId);
    if (me && (me.status === "left" || me.status === "declined")) {
      this.party = null;
      this.schedule();
    }
  }

  /**
   * Mark whether THIS member currently has the player open. Called by the player
   * (over /party/presence) on a short interval while active, and once with false
   * when it closes. Drives the green presence dot everyone else sees.
   */
  async setWatching(watching: boolean): Promise<void> {
    const party = this.party;
    if (!party || !this.cloud.userId) return;
    await this.cloud.rest(`party_members?party_id=eq.${party.id}&user_id=eq.${this.cloud.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ watching_at: watching ? new Date().toISOString() : null }),
    });
  }

  private async heartbeat() {
    const party = this.party;
    if (!party) return;
    this.lastHeartbeat = Date.now();
    await this.cloud.rest(`party_members?party_id=eq.${party.id}&user_id=eq.${this.cloud.userId}`, {
      method: "PATCH",
      body: JSON.stringify({
        last_seen: new Date().toISOString(),
        has_file: party.localFileId != null,
      }),
    });
  }

  // ---- helpers --------------------------------------------------------------------

  /** This machine's file id for a fingerprint, or null when we don't have it. */
  private localFileFor(fingerprint: string): number | null {
    if (!fingerprint) return null;
    const row = this.db
      .prepare("SELECT id FROM files WHERE fingerprint = ? AND missing = 0 LIMIT 1")
      .get(fingerprint) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Human title for a file, matching what the player shows. */
  private titleFor(fileId: number): string {
    const row = this.db
      .prepare(
        `SELECT mi.title AS show_title, e.title AS ep_title, e.season, e.episode
           FROM files f
           LEFT JOIN media_items mi ON mi.id = f.media_item_id
           LEFT JOIN episodes e     ON e.id = f.episode_id
          WHERE f.id = ?`
      )
      .get(fileId) as any;
    if (!row) return "";
    if (row.season != null && row.episode != null)
      return `${row.show_title ?? ""} · S${String(row.season).padStart(2, "0")}E${String(row.episode).padStart(2, "0")}${
        row.ep_title ? ` · ${row.ep_title}` : ""
      }`;
    return row.show_title ?? "";
  }

  private requireParty(): ActiveParty {
    if (!this.party) throw new Error("You're not in a party");
    return this.party;
  }

  async loadContacts(): Promise<PartyContact[]> {
    if (!this.cloud.userId) return [];
    const rows = await this.cloud.rest<any[]>(
      `party_contacts?owner_id=eq.${this.cloud.userId}&select=user_id,username,email,last_used&order=last_used.desc&limit=12`
    );
    this.contacts = (rows ?? []).map((r) => ({
      userId: String(r.user_id),
      username: String(r.username ?? ""),
      email: String(r.email ?? ""),
      lastUsed: r.last_used ?? null,
    }));
    return this.contacts;
  }

  snapshot(): PartySnapshot {
    return {
      configured: this.cloud.getStatus().configured,
      signedIn: !!this.cloud.userId,
      userId: this.cloud.userId,
      username: this.username,
      lastInvite: getSetting(this.db, LAST_INVITE_KEY) ?? "",
      party: this.party,
      invites: this.invites,
      contacts: this.contacts,
      error: this.error,
    };
  }

  /** Broadcast to the renderer, but only when something actually changed. */
  private emit() {
    const snap = this.snapshot();
    const sig = JSON.stringify(snap);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    events.broadcast("party", snap);
  }
}
