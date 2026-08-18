// Deciding whether a request came from this machine.
//
// This used to be a plain socket-address check, which is correct only while the
// server is reachable directly. Once a Cloudflare tunnel is in front of it that
// assumption breaks in the worst possible direction: cloudflared runs ON this PC
// and connects over loopback, so every request from the public internet would
// have arrived with remoteAddress 127.0.0.1 and been waved through with no token
// AND handed the redacted-for-remote settings (TMDB key, OpenSubtitles password,
// access token) by /state.
//
// So a request only counts as local if the socket is loopback *and* it carries
// no proxy/forwarding headers. Note the failure direction: a LAN client that
// forges these headers only makes the check STRICTER (it gets asked for a
// token), so they can't be used to gain access.
import type { Request } from "express";
import type { DB } from "../db";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Any of these means the request passed through a proxy — i.e. our tunnel. */
const FORWARD_HEADERS = [
  "cf-ray",
  "cf-connecting-ip",
  "cf-ipcountry",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
] as const;

export function isLocalRequest(req: Request): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  return !FORWARD_HEADERS.some((h) => req.headers[h]);
}

// ---- per-library sharing --------------------------------------------------------
//
// A library can be marked Private (libraries.shared = 0), which must hide it from
// every request that isn't the PC itself: listings, detail, streams, subtitles,
// thumbnails and the offline export alike. The PC (local) always sees everything.

/** Is this library exposed to remote/LAN clients? Missing/unknown counts as NOT shared. */
export function libraryShared(db: DB, libraryId: number | null | undefined): boolean {
  if (libraryId == null) return false;
  const row = db.prepare("SELECT shared FROM libraries WHERE id = ?").get(libraryId) as { shared?: number } | undefined;
  return !!row && row.shared !== 0;
}

/** The library a file belongs to (files.library_id), or null when the file is unknown. */
export function fileLibraryId(db: DB, fileId: number): number | null {
  const row = db.prepare("SELECT library_id FROM files WHERE id = ?").get(fileId) as { library_id?: number } | undefined;
  return row?.library_id ?? null;
}

/** Guard a file-scoped request: allowed if it's the PC, or the file's library is shared. */
export function fileVisibleTo(db: DB, req: Request, fileId: number): boolean {
  if (isLocalRequest(req)) return true;
  return libraryShared(db, fileLibraryId(db, fileId));
}

/** Guard an item-scoped request: allowed if it's the PC, or the item's library is shared. */
export function itemVisibleTo(db: DB, req: Request, itemId: number): boolean {
  if (isLocalRequest(req)) return true;
  const row = db.prepare("SELECT library_id FROM media_items WHERE id = ?").get(itemId) as { library_id?: number } | undefined;
  return libraryShared(db, row?.library_id ?? null);
}

/**
 * Best-effort identity for rate limiting. Through the tunnel the socket address
 * is always 127.0.0.1, so prefer the edge's view of the real client.
 */
export function clientKey(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}
