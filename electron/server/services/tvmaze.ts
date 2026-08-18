// TVmaze provider — free, no API key. TV series (including most broadcast
// anime) with per-episode titles/summaries/images. Used as automatic fallback
// when TMDB has no key or no match, and selectable in the Match dialog.
// Data licensed CC BY-SA; attribution shown in the UI.
import { pickBestMatch } from "./matchScore";
import { yearOfDate } from "./images";
import { appFetch } from "./http";

const API = "https://api.tvmaze.com";

export interface MetaSearchResult {
  providerId: number;
  title: string;
  year: number | null;
  overview: string;
}

async function getJson(url: string): Promise<any> {
  const res = await appFetch(url, {
    headers: { "User-Agent": "Locality" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TVmaze request failed: ${res.status} ${url}`);
  return res.json();
}

export class TvMaze {
  async search(query: string): Promise<MetaSearchResult[]> {
    const data = await getJson(`${API}/search/shows?q=${encodeURIComponent(query)}`);
    return (data ?? []).map((r: any) => ({
      providerId: r.show.id,
      title: r.show.name,
      year: yearOfDate(r.show.premiered),
      overview: (r.show.summary ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
  }

  async findBestMatch(title: string, year?: number | null): Promise<MetaSearchResult | null> {
    // TVmaze search has no year filter, so year only influences ranking here —
    // the retry dance TMDB needs doesn't apply.
    return pickBestMatch(await this.search(title), title, year);
  }

  /** Full show payload with cast + all episodes embedded. */
  async showDetails(id: number): Promise<any> {
    return getJson(`${API}/shows/${id}?embed[]=cast&embed[]=episodes`);
  }

  /** Exact show lookup by IMDb id (e.g. "tt0903747"), or null. */
  async lookupByImdb(imdbId: string): Promise<any | null> {
    try {
      return await getJson(`${API}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
    } catch {
      return null;
    }
  }

  /** Season records (posters). */
  async seasons(id: number): Promise<any[]> {
    return getJson(`${API}/shows/${id}/seasons`);
  }

  /** Show image gallery — used to find a background/fanart image. */
  async images(id: number): Promise<any[]> {
    try {
      return await getJson(`${API}/shows/${id}/images`);
    } catch {
      return [];
    }
  }
}
