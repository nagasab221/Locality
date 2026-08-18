// Shared candidate scoring for metadata search results. TMDB and TVmaze use
// the same rules (AniList keeps its own copy — it scores against synonym
// lists). Pure so the unit tests can exercise the matching decisions without
// touching the network.
import { normalizeTitle } from "./parser";

export interface ScorableResult {
  title: string;
  year: number | null;
  /** TMDB has it, TVmaze doesn't — absent counts as 0. */
  popularity?: number;
}

/**
 * Pick the result that best corresponds to a parsed title/year, or null when
 * nothing clears the confidence bar. Some title resemblance is required: a
 * year hit plus popularity alone tops out below the threshold, so a set of
 * same-year wrong-title candidates picks nothing (the caller can then retry a
 * broader search) instead of matching a random film.
 */
export function pickBestMatch<T extends ScorableResult>(results: T[], title: string, year?: number | null): T | null {
  if (results.length === 0) return null;
  const wanted = normalizeTitle(title);
  const scored = results.map((r) => {
    const got = normalizeTitle(r.title);
    let score = 0;
    if (got === wanted) score += 3;
    else if (got.startsWith(wanted) || wanted.startsWith(got)) score += 1.5;
    else if (got.includes(wanted) || wanted.includes(got)) score += 0.75;
    if (year && r.year === year) score += 1.5;
    if (year && r.year && Math.abs(r.year - year) === 1) score += 0.75;
    score += Math.min((r.popularity ?? 0) / 100, 0.5);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score >= 2 ? scored[0].r : null;
}
