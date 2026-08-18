// TMDB API client + local image cache. Images are downloaded once into
// <dataDir>/cache/images and referenced by cache-relative path afterwards —
// the UI never hotlinks TMDB's CDN.
import { getSetting, type DB } from "../db";
import { pickBestMatch } from "./matchScore";
import { cacheImageFromUrl } from "./images";
import { appFetch } from "./http";

const API = "https://api.themoviedb.org/3";
// The canonical image CDN (image.tmdb.org) is DNS-poisoned/intermittently
// blocked by some ISPs while the main site's domains — same images, same
// paths — stay reachable. Try mirrors and stick with whichever works.
const IMG_HOSTS = [
  "https://image.tmdb.org/t/p",
  "https://media.themoviedb.org/t/p",
  "https://www.themoviedb.org/t/p",
];
let preferredImgHost = 0;

export class TmdbError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface TmdbSearchResult {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterPath: string | null; // TMDB path, not yet cached
  mediaType: "movie" | "tv";
  popularity: number;
}

const DEFAULT_TMDB_PROXY_URL = "https://locality.madebymanara.workers.dev";

export class Tmdb {
  /** `imagesDir` must be the SAME directory express serves at /api/images. */
  constructor(private db: DB, private imagesDir: string) {}

  private getProxyUrl(): string | null {
    const proxy = getSetting(this.db, "tmdbProxyUrl");
    return (proxy || DEFAULT_TMDB_PROXY_URL).trim().replace(/\/+$/, "");
  }

  hasKey(): boolean {
    return !!getSetting(this.db, "tmdbApiKey") || !!this.getProxyUrl();
  }

  private async get(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    const key = (getSetting(this.db, "tmdbApiKey") || "").trim();
    const proxy = this.getProxyUrl();

    let baseUrl: string;
    const headers: Record<string, string> = {};

    if (key) {
      baseUrl = API + endpoint;
      const isV4 = key.startsWith("ey") && key.length > 100;
      if (isV4) headers["Authorization"] = `Bearer ${key}`;
    } else if (proxy) {
      baseUrl = (proxy.endsWith("/3") ? proxy : `${proxy}/3`) + endpoint;
    } else {
      throw new TmdbError("No TMDB API key or proxy URL configured", 401);
    }

    const url = new URL(baseUrl);
    if (key && !key.startsWith("ey")) {
      url.searchParams.set("api_key", key);
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await appFetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new TmdbError(`TMDB ${endpoint} failed: ${res.status}`, res.status);
    }
    return res.json();
  }

  async search(query: string, type: "movie" | "tv", year?: number | null): Promise<TmdbSearchResult[]> {
    let cleanQuery = query.trim();
    let effectiveYear = year;
    const m = /\s+((?:19|20)\d{2})$/.exec(cleanQuery);
    if (m) {
      cleanQuery = cleanQuery.slice(0, m.index).trim();
      if (!effectiveYear) effectiveYear = parseInt(m[1], 10);
    }

    const runSearch = async (q: string, y?: number | null) => {
      const params: Record<string, string> = { query: q, include_adult: "false" };
      if (y) params[type === "movie" ? "year" : "first_air_date_year"] = String(y);
      let data = await this.get(`/search/${type}`, params);
      if ((!data.results || data.results.length === 0) && y) {
        data = await this.get(`/search/${type}`, { query: q, include_adult: "false" });
      }
      return data.results ?? [];
    };

    let results = await runSearch(cleanQuery, effectiveYear);
    if (results.length === 0 && cleanQuery !== query.trim()) {
      results = await runSearch(query.trim(), year);
    }

    return results.map((r: any) => ({
      tmdbId: r.id,
      title: type === "movie" ? r.title : r.name,
      year: dateYear(type === "movie" ? r.release_date : r.first_air_date),
      overview: r.overview ?? "",
      posterPath: r.poster_path ?? null,
      mediaType: type,
      popularity: r.popularity ?? 0,
    }));
  }

  /**
   * Pick the best match for a parsed title/year, or null if confidence is too
   * low (caller then flags the item "needs_match" for the manual Match dialog).
   *
   * Two passes. Files are often labeled a year off TMDB's listing ("Obsession
   * 2026" against a 2025 release date), and a year-restricted search can come
   * back as a NON-empty set of wrong-title candidates from that year — which
   * used to dead-end the match. So when the filtered pass picks nothing, search
   * again without the filter; the year still counts, but as a ranking bonus
   * instead of a hard gate.
   */
  async findBestMatch(title: string, type: "movie" | "tv", year?: number | null): Promise<TmdbSearchResult | null> {
    const filtered = await this.search(title, type, year);
    let best = pickBestMatch(filtered, title, year);
    // Empty-filtered searches already fell back inside search(), so those
    // results ARE the unfiltered set — only refetch when it was non-empty.
    if (!best && year && filtered.length > 0) {
      best = pickBestMatch(await this.search(title, type, null), title, year);
    }
    return best;
  }

  async movieDetails(tmdbId: number): Promise<any> {
    return this.get(`/movie/${tmdbId}`, { append_to_response: "credits,external_ids" });
  }

  async tvDetails(tmdbId: number): Promise<any> {
    return this.get(`/tv/${tmdbId}`, { append_to_response: "credits,external_ids" });
  }

  async tvSeason(tmdbId: number, season: number): Promise<any> {
    return this.get(`/tv/${tmdbId}/season/${season}`);
  }

  /**
   * Content certification (e.g. "TV-MA", "PG-13"), preferring the US rating and
   * falling back to any non-empty one. TMDB has the certification but not the
   * per-descriptor reason ("language, violence") — that's Netflix-specific.
   */
  async contentRating(tmdbId: number, type: "movie" | "tv", region = "US"): Promise<string | null> {
    try {
      if (type === "tv") {
        const data = await this.get(`/tv/${tmdbId}/content_ratings`);
        const rows: { iso_3166_1: string; rating: string }[] = data?.results ?? [];
        const pick = rows.find((r) => r.iso_3166_1 === region && r.rating) || rows.find((r) => r.rating);
        return pick?.rating || null;
      }
      const data = await this.get(`/movie/${tmdbId}/release_dates`);
      const rows: { iso_3166_1: string; release_dates: { certification: string }[] }[] = data?.results ?? [];
      const certOf = (r?: { release_dates: { certification: string }[] }) => r?.release_dates?.map((d) => d.certification).find((c) => c) || null;
      return certOf(rows.find((r) => r.iso_3166_1 === region)) || certOf(rows.find((r) => r.release_dates?.some((d) => d.certification))) || null;
    } catch {
      return null;
    }
  }

  async personDetails(tmdbId: number): Promise<any> {
    return this.get(`/person/${tmdbId}`);
  }

  /** TMDB ids of recommended titles for an item (movie|tv). */
  async recommendationIds(type: "movie" | "tv", tmdbId: number): Promise<number[]> {
    const d = await this.get(`/${type}/${tmdbId}/recommendations`);
    return (d.results ?? []).map((r: any) => r.id);
  }

  /** Box-set details: name + ordered parts (id, title, release_date). */
  async collectionDetails(collectionId: number): Promise<any> {
    return this.get(`/collection/${collectionId}`);
  }

  /**
   * Download a TMDB image into the local cache, returning the cache-relative
   * path (e.g. "poster/ab12cd.jpg"), or null. Existing files are reused.
   * Falls back across mirror hosts; remembers the one that worked.
   */
  async cacheImage(tmdbPath: string | null, kind: "poster" | "backdrop" | "still" | "season"): Promise<string | null> {
    if (!tmdbPath) return null;
    const size = kind === "backdrop" ? "w1280" : kind === "still" ? "w400" : "w500";
    const cacheKey = `tmdb:${size}${tmdbPath}`;
    for (let i = 0; i < IMG_HOSTS.length; i++) {
      const idx = (preferredImgHost + i) % IMG_HOSTS.length;
      const rel = await cacheImageFromUrl(this.imagesDir, `${IMG_HOSTS[idx]}/${size}${tmdbPath}`, kind, cacheKey);
      if (rel) {
        preferredImgHost = idx;
        return rel;
      }
    }
    return null;
  }
}

function dateYear(d?: string | null): number | null {
  if (!d) return null;
  const y = parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}
