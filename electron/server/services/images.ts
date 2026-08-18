// Shared helpers for metadata providers: local image caching (no hotlinking —
// every poster/backdrop/still is downloaded once into <dataDir>/cache/images)
// and small text utilities.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { appFetch } from "./http";

export type ImageKind = "poster" | "backdrop" | "still" | "season";

// Circuit breaker: when the CDN is down/blocked, stop burning ~30s of retries
// per image so a 200-item scan still finishes quickly (artwork heals on a
// later rescan). Reset at the start of every scan.
let consecutiveFailures = 0;
export function resetImageFailureBreaker() {
  consecutiveFailures = 0;
}

/**
 * Download any image URL into the local cache, returning the cache-relative
 * path (e.g. "poster/ab12cd.jpg") or null. Existing files are reused.
 * `cacheKey` overrides the dedupe key so the same logical image fetched from
 * mirror hosts lands in one file.
 */
export async function cacheImageFromUrl(
  imagesDir: string,
  url: string | null | undefined,
  kind: ImageKind,
  cacheKey?: string
): Promise<string | null> {
  if (!url) return null;
  const name = crypto.createHash("sha1").update(cacheKey ?? url).digest("hex").slice(0, 16) + ".jpg";
  const rel = path.posix.join(kind, name);
  const abs = path.join(imagesDir, kind, name);
  if (fs.existsSync(abs)) return rel;
  // Retry with backoff: flaky/intermittently-blocked CDNs shouldn't leave an
  // item permanently artless, and a hung socket must never stall a scan.
  const degraded = consecutiveFailures >= 5;
  const waits = degraded ? [0] : [0, 1500, 5000];
  const timeoutMs = degraded ? 8000 : 20000;
  let lastError = "";
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise((r) => setTimeout(r, waits[attempt]));
    try {
      const res = await appFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        if (res.status >= 500 || res.status === 429) continue; // retryable
        break;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      consecutiveFailures = 0;
      return rel;
    } catch (e: any) {
      lastError = String(e?.cause ?? e?.message ?? e);
    }
  }
  consecutiveFailures++;
  console.error(`image download failed (${lastError})${degraded ? " [degraded mode]" : ""}: ${url}`);
  return null;
}

/** TVmaze/AniList summaries arrive as HTML fragments. */
export function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  return text || null;
}

export function yearOfDate(d?: string | null): number | null {
  if (!d) return null;
  const y = parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}
