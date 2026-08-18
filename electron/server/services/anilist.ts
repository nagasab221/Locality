// AniList provider — free GraphQL API, no key. Anime-first metadata (covers,
// banners, descriptions, genres) for both series and anime movies. No
// per-episode data (episode numbers keep their file-derived titles).
import { normalizeTitle } from "./parser";
import type { MetaSearchResult } from "./tvmaze";
import { appFetch } from "./http";

const API = "https://graphql.anilist.co";

const MEDIA_FIELDS = `
  id
  title { romaji english }
  description(asHtml: false)
  startDate { year }
  coverImage { extraLarge large }
  bannerImage
  genres
  averageScore
  episodes
  duration
  format
  characters(perPage: 12, sort: ROLE) {
    edges { role node { name { full } } }
  }
`;

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  // AniList rate-limits aggressively (~30 req/min degraded) — during a bulk
  // library scan a 429 is routine, so honor Retry-After instead of failing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await appFetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 5, 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`AniList request failed: ${res.status} ${await res.text().catch(() => "")}`);
    const data: any = await res.json();
    if (data.errors?.length) throw new Error(`AniList: ${data.errors[0].message}`);
    return data.data;
  }
  throw new Error("AniList rate limit persisted after retries");
}

export function anilistTitle(media: any): string {
  return media.title?.english || media.title?.romaji || "Unknown";
}

export class AniList {
  private async searchRaw(query: string, movieOnly: boolean): Promise<any[]> {
    const data = await gql(
      `query ($search: String, $formats: [MediaFormat]) {
         Page(perPage: 8) {
           media(search: $search, type: ANIME, format_in: $formats) {
             id title { romaji english } synonyms description(asHtml: false)
             startDate { year } format
           }
         }
       }`,
      {
        search: query,
        formats: movieOnly ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL", "MOVIE"],
      }
    );
    return data.Page?.media ?? [];
  }

  async search(query: string, movieOnly = false): Promise<MetaSearchResult[]> {
    return (await this.searchRaw(query, movieOnly)).map((m: any) => ({
      providerId: m.id,
      title: anilistTitle(m),
      year: m.startDate?.year ?? null,
      overview: (m.description ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
  }

  async findBestMatch(title: string, year?: number | null, movieOnly = false): Promise<MetaSearchResult | null> {
    const media = await this.searchRaw(title, movieOnly);
    if (media.length === 0) return null;
    const wanted = normalizeTitle(title);
    // Anime files are named by romaji, English or fan synonyms interchangeably
    // ("Sousou no Frieren" vs "Frieren: Beyond Journey's End") — score against
    // every known title, not just the display one.
    const scored = media.map((m: any) => {
      const names: string[] = [m.title?.romaji, m.title?.english, ...(m.synonyms ?? [])]
        .filter(Boolean)
        .map(normalizeTitle);
      let best = 0;
      for (const got of names) {
        let score = 0;
        if (got === wanted) score += 3;
        else if (got.startsWith(wanted) || wanted.startsWith(got)) score += 1.5;
        else if (got.includes(wanted) || wanted.includes(got)) score += 0.75;
        best = Math.max(best, score);
      }
      const y = m.startDate?.year ?? null;
      if (year && y === year) best += 1.5;
      if (year && y && Math.abs(y - year) === 1) best += 0.75;
      return { m, score: best };
    });
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score < 2) return null;
    const m = scored[0].m;
    return {
      providerId: m.id,
      title: anilistTitle(m),
      year: m.startDate?.year ?? null,
      overview: (m.description ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
    };
  }

  async details(id: number): Promise<any> {
    const data = await gql(`query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`, { id });
    return data.Media;
  }
}
