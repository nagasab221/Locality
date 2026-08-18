// Keeping two players on the same frame.
//
// The server does all the Supabase talking (see services/party.ts) and pushes a
// snapshot on the "party" SSE event; this is the player-side half:
//
//   in  — someone else paused/seeked, so match them
//   out — the local user paused/seeked, so tell everyone
//
// Only explicit ACTIONS are exchanged, never the ordinary tick of playback. Two
// players streaming the same file drift by milliseconds; publishing every tick
// would instead have each side constantly correcting the other.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFrom, subscribe } from "./api";

// Pinned to the LOCAL server, never the active source. A guest streaming from
// the host is browsing with ?src=party, so a plain get()/post() would send these
// to the host's machine — which rightly rejects them, since every /party route
// is local-only. (The SSE stream is already local-only by construction.)
export const partyGet = <T = any,>(path: string) => apiFrom<T>("local", path);
export const partyPost = <T = any,>(path: string, body?: unknown) =>
  apiFrom<T>("local", path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Mirrors PARTY_MAX in services/party.ts, which is what actually enforces it. */
export const PARTY_MAX = 6;

export type PartyMode = "local" | "stream";

export interface PartyMember {
  userId: string;
  username: string;
  status: "invited" | "joined" | "declined" | "left";
  isHost: boolean;
  hasFile: boolean;
  lastSeen: string | null;
  /** True when this member currently has the player open. */
  watching: boolean;
}
export interface PartyPlayback {
  position: number;
  paused: boolean;
  seq: number;
  updatedBy: string | null;
  updatedAt: string | null;
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
  hostServer: { url: string; token: string } | null;
  localFileId: number | null;
}
export interface PartySnapshot {
  configured: boolean;
  signedIn: boolean;
  userId: string | null;
  username: string | null;
  lastInvite: string;
  party: ActiveParty | null;
  invites: { partyId: string; title: string; mode: PartyMode; hostUsername: string; hasFile: boolean }[];
  contacts: { userId: string; username: string; email: string; lastUsed: string | null }[];
  error: string | null;
}

/** Content difference worth correcting. Below this, seeking is more jarring than the drift. */
export const SYNC_TOLERANCE_S = 1;
/** How often we re-check that we're still where the party is (see below). */
const RECONCILE_MS = 1000;
/**
 * Minimum gap between two corrective seeks. Seeking a stream costs buffering,
 * and correcting again mid-buffer would chase its own tail.
 */
const RESEEK_COOLDOWN_MS = 4000;
/**
 * Assumed age of an action when it reaches us: about half the 700ms poll plus a
 * little network. Everything after receipt is measured with the LOCAL clock.
 */
const ACTION_LATENCY_S = 0.4;
/**
 * How long after applying a remote action we stay quiet.
 *
 * Applying it makes the player fire its own play/pause/seeked events, which
 * would publish straight back out and ping-pong between the two machines.
 */
const ECHO_QUIET_MS = 900;
/**
 * Grace period after a player opens.
 *
 * Autoplay fires `play`, and a resume fires `seeked`, before the user has
 * touched anything — publishing those would mean the last person to open their
 * player drags everyone else to wherever they started.
 */
const SETTLE_MS = 1800;

/**
 * Where the party actually is *right now*, measured from when WE received the
 * action rather than from the publisher's timestamp.
 *
 * `updatedAt` is the other machine's wall clock, and a PC and a phone are
 * routinely a second or two apart — which is the same size as the error we're
 * trying to correct, so trusting it made sync worse, not better. `receivedAt`
 * is stamped with our own clock, so the elapsed time below is real regardless
 * of how wrong either machine's idea of "now" is.
 */
export function partyPositionNow(pb: PartyPlayback, receivedAt: number): number {
  if (pb.paused) return pb.position;
  const elapsed = Math.max(0, (Date.now() - receivedAt) / 1000);
  return pb.position + ACTION_LATENCY_S + elapsed;
}

/** m:ss, or h:mm:ss once past an hour — for "seeked to 1:30:21" notices. */
function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

/** Subscribe to the party snapshot. Used by the players and by the Party tab. */
export function usePartySnapshot(): PartySnapshot | null {
  const [snap, setSnap] = useState<PartySnapshot | null>(null);
  useEffect(() => {
    partyGet<PartySnapshot>("/party/status").then(setSnap).catch(() => {});
    return subscribe("party", (s: PartySnapshot) => setSnap(s));
  }, []);
  return snap;
}

export interface PartySyncOptions {
  /** The file this player is showing; sync is off unless it's the party's file. */
  fileId: number;
  /** Read the current playhead, in whole-file seconds. */
  position: () => number;
  /** Read whether the player is paused. */
  paused: () => boolean;
  /** Jump to a position, in whole-file seconds. */
  seek: (to: number) => void;
  /** Play or pause to match everyone else. */
  setPaused: (paused: boolean) => void;
}

/**
 * Two-way playback sync for a player.
 *
 * Returns `{ active, publish }` — call `publish()` from the player's play,
 * pause and seeked handlers. It's a no-op when no party is running, so callers
 * don't need to branch.
 */
export function usePartySync(opts: PartySyncOptions): { active: boolean; party: ActiveParty | null; publish: () => void; notice: string | null } {
  const snap = usePartySnapshot();
  const party = snap?.party ?? null;

  // A party only drives THIS player when it's about the file on screen: in
  // "local" mode that's our own copy of the fingerprint, in "stream" mode the
  // host's file id, which is what a guest addresses remotely.
  const active =
    !!party &&
    (party.localFileId === opts.fileId ||
      (party.mode === "stream" && party.hostFileId === opts.fileId));

  // The handlers change every render; refs keep the effect below from
  // re-subscribing (and re-applying) on each one.
  const ref = useRef(opts);
  ref.current = opts;

  const quietUntil = useRef(0);
  const appliedSeq = useRef(-1);
  /** Opening a player fires play/seeked on its own; nothing before this is a user action. */
  const settledAt = useRef(0);
  const announced = useRef(false);

  // A short-lived "John has paused / seeked to 1:30:21" line for the player to
  // show top-right. Only ever set for OTHER people's actions (see the guard in
  // the apply effect); it clears itself after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  useEffect(() => {
    if (!active) return;
    settledAt.current = Date.now() + SETTLE_MS;
  }, [active, opts.fileId]);

  /** When we saw the current action, on OUR clock — the anchor everything below measures from. */
  const receivedAt = useRef(0);
  const lastCorrection = useRef(0);

  useEffect(() => {
    if (!active || !party) return;
    const pb = party.playback;
    // seq 0 is a party nobody has acted in yet. Applying it would yank whoever
    // opens the player first back to 0:00 and pause them.
    if (pb.seq <= 0 || pb.seq <= appliedSeq.current) return;
    appliedSeq.current = pb.seq;
    receivedAt.current = Date.now();
    // Our own action, echoed back by the poll. Nothing to do — acting on it
    // would seek us to where we already are.
    if (pb.updatedBy && pb.updatedBy === snap?.userId) return;

    quietUntil.current = Date.now() + ECHO_QUIET_MS;
    const target = partyPositionNow(pb, receivedAt.current);
    // Decide what changed BEFORE applying, so the comparison isn't reading state
    // we just moved ourselves.
    const didSeek = Math.abs(ref.current.position() - target) > SYNC_TOLERANCE_S;
    const didPauseChange = ref.current.paused() !== pb.paused;
    if (didSeek) {
      ref.current.seek(target);
      lastCorrection.current = Date.now();
    }
    if (didPauseChange) ref.current.setPaused(pb.paused);

    // Name who did it, top-right. Their own actions are filtered out above, so
    // this only ever names someone else. A pause/resume reads better than the
    // seek that rides along with it, so it wins when both changed.
    const who = party.members.find((m) => m.userId === pb.updatedBy)?.username || "Someone";
    if (didPauseChange) showNotice(`${who} has ${pb.paused ? "paused" : "resumed"}`);
    else if (didSeek) showNotice(`${who} has seeked to ${clock(target)}`);
  }, [active, party, snap?.userId, showNotice]);

  /**
   * Keep matching the party after the action has been applied.
   *
   * Applying once isn't enough. Seeking costs buffering — seconds of it on a
   * remote stream — and the others don't wait, so the gap that opens while we
   * catch up would otherwise never close. This also re-asserts play/pause, so
   * anything that resumes playback locally is pulled back within a second.
   *
   * Purely local: it never publishes, so correcting ourselves can't drag anyone
   * else around.
   */
  useEffect(() => {
    if (!active || !party) return;
    const pb = party.playback;
    if (pb.seq <= 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now < quietUntil.current || now < settledAt.current) return;
      if (ref.current.paused() !== pb.paused) {
        ref.current.setPaused(pb.paused);
        return;
      }
      if (pb.paused || now - lastCorrection.current < RESEEK_COOLDOWN_MS) return;
      const expected = partyPositionNow(pb, receivedAt.current);
      if (Math.abs(ref.current.position() - expected) > SYNC_TOLERANCE_S) {
        ref.current.seek(expected);
        lastCorrection.current = now;
      }
    }, RECONCILE_MS);
    return () => window.clearInterval(timer);
  }, [active, party]);

  const send = useCallback(() => {
    partyPost("/party/state", {
      position: ref.current.position(),
      paused: ref.current.paused(),
    }).catch(() => {});
  }, []);

  const publish = useCallback(() => {
    if (!active) return;
    if (Date.now() < quietUntil.current) return; // this was us applying someone else's action
    if (Date.now() < settledAt.current) return; // the player's own start-up, not the user
    send();
  }, [active, send]);

  /**
   * Someone has to put a position on the board, or a guest who joins mid-film
   * sits at seq 0 with nothing to sync to. That's the host's job: if guests
   * announced too, whoever opened their player last would drag everyone to
   * wherever they happened to be.
   */
  useEffect(() => {
    if (!active || !party?.isHost || announced.current) return;
    announced.current = true;
    const t = setTimeout(send, SETTLE_MS);
    return () => clearTimeout(t);
  }, [active, party?.isHost, send]);

  // Presence: while this player is open, tell the party so everyone sees a live
  // "in the player" dot. Ping on a short interval; clear it when the player closes.
  useEffect(() => {
    if (!active) return;
    partyPost("/party/presence", { watching: true }).catch(() => {});
    const t = setInterval(() => partyPost("/party/presence", { watching: true }).catch(() => {}), 6000);
    return () => {
      clearInterval(t);
      partyPost("/party/presence", { watching: false }).catch(() => {});
    };
  }, [active]);

  return { active, party, publish, notice };
}
