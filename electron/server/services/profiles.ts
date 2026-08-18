// Household profiles + per-profile watch state.
//
// Design (deliberately minimal-risk): the DEFAULT profile keeps using the
// original watch_progress table, so the portable ledger and Supabase sync — the
// most-tested, easiest-to-corrupt path — are completely unchanged. Additional
// profiles read/write profile_progress instead and are server-local (they do
// not travel in locality.json or sync to the cloud). That covers the real use
// case: one owner whose progress follows them across devices, plus separate
// Continue Watching for everyone else who shares the screen.
import crypto from "crypto";
import type { DB } from "../db";
import type { ProgressEntry, Profile } from "../types";
import type { ProgressLedger } from "./progressLedger";

const WATCHED_THRESHOLD = 0.9;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Internal row shape including the secret columns list() must never return. */
interface ProfileRow extends Profile {
  password_hash: string | null;
  password_salt: string | null;
}

/** The read/write surface the routes need, satisfied by both the ledger (default
 *  profile) and ProfileProgressStore (everyone else). */
export interface ProgressStore {
  get(fingerprint: string): ProgressEntry | null;
  update(
    fingerprint: string,
    filename: string,
    sizeBytes: number,
    positionSeconds: number,
    durationSeconds: number,
    opts?: { watched?: boolean }
  ): void;
  setWatched(fingerprint: string, filename: string, sizeBytes: number, watched: boolean): void;
}

/** watch-state store for a non-default profile, backed by profile_progress. */
class ProfileProgressStore implements ProgressStore {
  private upsert;
  constructor(private db: DB, private profileId: number) {
    this.upsert = db.prepare(`
      INSERT INTO profile_progress (profile_id, fingerprint, filename, size_bytes, duration_seconds, position_seconds, watched, last_updated)
      VALUES (@profile_id, @fingerprint, @filename, @size_bytes, @duration_seconds, @position_seconds, @watched, @last_updated)
      ON CONFLICT(profile_id, fingerprint) DO UPDATE SET
        filename = excluded.filename,
        size_bytes = excluded.size_bytes,
        duration_seconds = excluded.duration_seconds,
        position_seconds = excluded.position_seconds,
        watched = excluded.watched,
        last_updated = excluded.last_updated
    `);
  }

  get(fingerprint: string): ProgressEntry | null {
    const row = this.db
      .prepare("SELECT * FROM profile_progress WHERE profile_id = ? AND fingerprint = ?")
      .get(this.profileId, fingerprint) as any;
    if (!row) return null;
    return {
      filename: row.filename,
      size_bytes: row.size_bytes,
      duration_seconds: row.duration_seconds,
      position_seconds: row.position_seconds,
      watched: !!row.watched,
      last_updated: row.last_updated,
    };
  }

  update(
    fingerprint: string,
    filename: string,
    sizeBytes: number,
    positionSeconds: number,
    durationSeconds: number,
    opts: { watched?: boolean } = {}
  ) {
    const existing = this.get(fingerprint);
    let watched = opts.watched ?? existing?.watched ?? false;
    if (opts.watched === undefined && durationSeconds > 0 && positionSeconds / durationSeconds >= WATCHED_THRESHOLD) {
      watched = true;
    }
    this.upsert.run({
      profile_id: this.profileId,
      fingerprint,
      filename,
      size_bytes: sizeBytes,
      duration_seconds: Math.round(durationSeconds),
      position_seconds: Math.round(positionSeconds),
      watched: watched ? 1 : 0,
      last_updated: nowIso(),
    });
  }

  setWatched(fingerprint: string, filename: string, sizeBytes: number, watched: boolean) {
    const existing = this.get(fingerprint);
    this.upsert.run({
      profile_id: this.profileId,
      fingerprint,
      filename,
      size_bytes: sizeBytes,
      duration_seconds: existing?.duration_seconds ?? 0,
      position_seconds: watched ? existing?.position_seconds ?? 0 : 0,
      watched: watched ? 1 : 0,
      last_updated: nowIso(),
    });
  }
}

export class Profiles {
  constructor(private db: DB, private ledger: ProgressLedger) {}

  private row(id: number): ProfileRow | undefined {
    return this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as ProfileRow | undefined;
  }

  /** Public shape — `locked` derived, secret columns stripped. Never returns the hash. */
  list(): Profile[] {
    const rows = this.db.prepare("SELECT * FROM profiles ORDER BY is_default DESC, id").all() as ProfileRow[];
    return rows.map(pub);
  }

  get(id: number): Profile | undefined {
    const r = this.row(id);
    return r ? pub(r) : undefined;
  }

  defaultId(): number {
    const row = this.db.prepare("SELECT id FROM profiles WHERE is_default = 1").get() as { id: number } | undefined;
    return row?.id ?? 1;
  }

  isDefault(id: number): boolean {
    return id === this.defaultId();
  }

  /** Resolve a client-supplied profile id (header/query) to a real one, falling
   *  back to the default so a stale or missing id never breaks a request. */
  resolve(raw: unknown): number {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && this.get(id)) return id;
    return this.defaultId();
  }

  /** The right progress store for a profile: the ledger for the default (keeps
   *  the portable file + cloud sync working), profile_progress for the rest. */
  store(profileId: number): ProgressStore {
    return this.isDefault(profileId) ? this.ledger : new ProfileProgressStore(this.db, profileId);
  }

  create(name: string, color: string): Profile {
    const clean = name.trim().slice(0, 40) || "New profile";
    const info = this.db
      .prepare("INSERT INTO profiles (name, color, is_default) VALUES (?, ?, 0)")
      .run(clean, normalizeColor(color));
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: { name?: string; color?: string }): Profile {
    const p = this.get(id);
    if (!p) throw new Error("No such profile");
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 40) || p.name : p.name;
    const color = patch.color !== undefined ? normalizeColor(patch.color) : p.color;
    this.db.prepare("UPDATE profiles SET name = ?, color = ? WHERE id = ?").run(name, color, id);
    return this.get(id)!;
  }

  /** Remove a profile and its watch state. The default can never be deleted —
   *  it owns the synced ledger, and something must always resolve. */
  remove(id: number) {
    if (this.isDefault(id)) throw new Error("The main profile can't be removed");
    if (!this.get(id)) throw new Error("No such profile");
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id); // profile_progress cascades
  }

  // ---- optional local lock --------------------------------------------------

  /** Set (or, with an empty string, clear) a profile's password. Stored as a
   *  salted scrypt hash on the local server, so unlocking works offline. */
  setPassword(id: number, password: string) {
    if (!this.row(id)) throw new Error("No such profile");
    if (!password) {
      this.db.prepare("UPDATE profiles SET password_hash = NULL, password_salt = NULL WHERE id = ?").run(id);
      return;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 32).toString("hex");
    this.db.prepare("UPDATE profiles SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, id);
  }

  /** True when the password is right — or when the profile has no lock at all. */
  verify(id: number, password: string): boolean {
    const r = this.row(id);
    if (!r) return false;
    if (!r.password_hash || !r.password_salt) return true;
    const attempt = crypto.scryptSync(password ?? "", r.password_salt, 32).toString("hex");
    const a = Buffer.from(attempt, "hex");
    const b = Buffer.from(r.password_hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Continue-watching rows for a profile: unfinished, newest first, already
   * joined to a present local file. Mirrors the default-profile query but
   * against profile_progress when needed.
   */
  continueRows(profileId: number): any[] {
    if (this.isDefault(profileId)) {
      return this.db
        .prepare(
          `SELECT wp.*, f.id AS file_id, f.media_item_id, f.episode_id
             FROM watch_progress wp
             JOIN files f ON f.fingerprint = wp.fingerprint AND f.missing = 0
            WHERE wp.watched = 0 AND wp.position_seconds > 30
            ORDER BY wp.last_updated DESC LIMIT 24`
        )
        .all();
    }
    return this.db
      .prepare(
        `SELECT wp.*, f.id AS file_id, f.media_item_id, f.episode_id
           FROM profile_progress wp
           JOIN files f ON f.fingerprint = wp.fingerprint AND f.missing = 0
          WHERE wp.profile_id = ? AND wp.watched = 0 AND wp.position_seconds > 30
          ORDER BY wp.last_updated DESC LIMIT 24`
      )
      .all(profileId);
  }
}

/** Public projection: derive `locked`, never expose the hash/salt. */
function pub(r: ProfileRow): Profile {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    is_default: r.is_default,
    created_at: r.created_at,
    locked: !!r.password_hash,
  };
}

/** Accept only a #rrggbb hex colour; fall back to the accent tan otherwise. */
function normalizeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test((c ?? "").trim()) ? c.trim() : "#C4A47C";
}
