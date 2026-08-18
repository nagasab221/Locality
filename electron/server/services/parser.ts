// Filename parser: turns messy release names + folder context into
// { title, year, season, episode, confidence }. Regex-based, guessit-flavored.
//
// Handles: "Movie (2023)", "Show - S01E01", "1x01", "Season 1/Episode 01"
// folder layouts, dotted release names, and anime conventions like
// "[SubsPlease] Frieren - 28 (1080p).mkv" (absolute numbering, no season).
import type { ParsedName } from "../types";

// Tokens that mark the end of the "title" part of a release name.
const NOISE = [
  "480p", "576p", "720p", "1080p", "1440p", "2160p", "4k", "uhd", "8k",
  "bluray", "blu-ray", "bdrip", "brrip", "webrip", "web-dl", "webdl", "web",
  "hdtv", "dvdrip", "dvd", "hdrip", "camrip", "cam", "ts", "telesync", "remux",
  "x264", "x265", "h264", "h265", "h.264", "h.265", "hevc", "avc", "av1", "xvid", "divx",
  "aac", "ac3", "eac3", "ddp", "dd5", "dts", "dts-hd", "truehd", "atmos", "flac", "mp3", "opus",
  "5.1", "7.1", "2.0", "10bit", "8bit", "hdr", "hdr10", "dv", "dolby",
  "proper", "repack", "extended", "unrated", "remastered", "limited", "internal",
  "multi", "dual", "subbed", "dubbed", "hardsub", "batch", "uncensored",
];

const NOISE_RE = new RegExp(
  `\\b(${NOISE.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})\\b`,
  "i"
);

/** "Show.Name_S01E01" -> "Show Name S01E01"; strips brackets/release-group cruft. */
function cleanTokens(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, " ") // [ReleaseGroup] / [1080p] / [Dual-Audio]
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseIfShouty(s: string): string {
  if (s.length > 3 && (s === s.toUpperCase() || s === s.toLowerCase())) {
    return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  return s;
}

function extractYear(s: string): { year: number | null; index: number } {
  // Prefer a parenthesized year, else last standalone 19xx/20xx.
  const paren = /[([](19\d{2}|20\d{2})[)\]]/.exec(s);
  if (paren) return { year: parseInt(paren[1], 10), index: paren.index };
  let year: number | null = null;
  let index = -1;
  const re = /(?:^|[\s.])((?:19|20)\d{2})(?=[\s.)\]]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    // Skip if it's the very first token (title probably IS a year, e.g. "2012")
    if (m.index === 0 && s.trim().startsWith(m[1]) && s.trim().length <= 6) continue;
    year = parseInt(m[1], 10);
    index = m.index;
  }
  return { year, index };
}

interface EpisodeHit {
  season: number | null; // null = not stated (folder context or S1 assumed)
  episode: number;
  index: number;
}

/**
 * Find an episode marker. `loose` additionally enables season-less patterns
 * ("E05", "Ep 5", "Show - 28") that are safe only inside TV libraries.
 */
function extractEpisode(name: string, loose: boolean): EpisodeHit | null {
  // S01E01, s1e1, S01E01v2 (release revision), S01E01E02 / S01E01-E02 (take first ep)
  let m = /\bS(\d{1,2})[\s._-]*E(\d{1,3})(?:v\d+)?(?:[-E]\d{1,3})*\b/i.exec(name);
  if (m) return { season: +m[1], episode: +m[2], index: m.index };
  // S01SP1 — specials; map to season 0 (the Plex/TMDB "Specials" convention)
  m = /\bS\d{1,2}[\s._-]*SP(\d{1,3})\b/i.exec(name);
  if (m) return { season: 0, episode: +m[1], index: m.index };
  // 1x01
  m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(name);
  if (m) return { season: +m[1], episode: +m[2], index: m.index };
  // "Season 1 Episode 2"
  m = /season[\s._-]*(\d{1,2}).{0,12}?episode[\s._-]*(\d{1,3})/i.exec(name);
  if (m) return { season: +m[1], episode: +m[2], index: m.index };
  if (loose) {
    // "Episode 5", "Ep05", "E05", "E1045" (long-running anime) — no season stated
    m = /\b(?:episode|ep|e)[\s._-]*(\d{1,4})\b/i.exec(name);
    if (m) return { season: null, episode: +m[1], index: m.index };
    // Anime absolute numbering: "Show - 28", "Show - 1045", "Show - 28v2".
    // Requires the " - " separator; 4-digit numbers that look like years are
    // rejected so "Show - 2012" stays a title.
    m = /[\s._]-[\s._]+(\d{1,4})(?:v\d+)?\b/.exec(name);
    if (m && !(m[1].length === 4 && +m[1] >= 1900 && +m[1] <= 2099)) {
      return { season: null, episode: +m[1], index: m.index };
    }
  }
  return null;
}

/** Folder-aware helpers for "Show Name/Season 1/Episode 01.mkv" layouts. */
function seasonFromFolder(folder: string): number | null {
  const m = /^(?:season|series|s)[\s._-]*(\d{1,2})$/i.exec(folder.trim());
  if (m) return +m[1];
  const sp = /^specials$/i.exec(folder.trim());
  if (sp) return 0;
  return null;
}

function episodeFromLooseName(base: string): number | null {
  let m = /^(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i.exec(base.trim());
  if (m) return +m[1];
  // "01 - Pilot.mkv" / "01.mkv"
  m = /^(\d{1,3})\b(?![0-9])/.exec(base.trim());
  if (m && +m[1] <= 300) return +m[1];
  return null;
}

function stripToTitle(cleaned: string, cutIndexes: number[]): string {
  // Index 0 is a valid cut (marker at the very start -> empty title, so the
  // caller falls back to folder names); -1 means "not found".
  const validCuts = cutIndexes.filter((i) => i >= 0);
  let title = validCuts.length ? cleaned.slice(0, Math.min(...validCuts)) : cleaned;
  const noise = NOISE_RE.exec(title);
  if (noise && noise.index > 0) title = title.slice(0, noise.index);
  title = title
    .replace(/[([{\-–—:,\s]+$/g, "")
    .replace(/\((?=\s*$)/, "")
    .trim();
  return titleCaseIfShouty(title);
}

/** Nearest "Season N" ancestor folder, or null. */
function seasonFromFolders(folders: string[]): { season: number; folderIndex: number } | null {
  for (let i = folders.length - 1; i >= 0; i--) {
    const s = seasonFromFolder(folders[i]);
    if (s !== null) return { season: s, folderIndex: i };
  }
  return null;
}

/**
 * Parse a media file path (relative to its library root) into a best guess.
 * `libraryType` biases interpretation: files in a TV library get season-less
 * episode patterns and folder-based season/episode/show-title inference.
 */
export function parseMediaPath(relPath: string, libraryType: "movies" | "tv" | "gallery" | "other"): ParsedName {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const filename = parts[parts.length - 1] ?? relPath;
  const folders = parts.slice(0, -1);
  const base = filename.replace(/\.[^.]+$/, "");
  const cleanedBase = cleanTokens(base);

  const ep = extractEpisode(cleanedBase, libraryType === "tv");
  const { year, index: yearIdx } = extractYear(cleanedBase);
  const folderSeason = seasonFromFolders(folders);

  if (ep) {
    // Title = text before the episode marker; if empty, fall back to folders.
    let title = stripToTitle(cleanedBase, [ep.index, yearIdx]);
    let confidence = ep.season !== null ? 0.9 : 0.7;
    if (!title) {
      title = titleFromFolders(parts);
      confidence = title ? 0.7 : 0.2;
    }
    let season = ep.season ?? folderSeason?.season ?? 1;
    // "Vinland Saga S2 - 11" — season suffix in the title itself.
    if (ep.season === null) {
      const suffix = /\b(?:s|season)[\s._-]*(\d{1,2})$/i.exec(title);
      if (suffix) {
        season = +suffix[1];
        title = title.slice(0, suffix.index).replace(/[\s\-–—:,]+$/, "").trim() || title;
      }
    }
    return { kind: "episode", title, year, season, episode: ep.episode, confidence };
  }

  if (libraryType === "tv") {
    // Folder layout: Show Name/Season 1/01 - Pilot.mkv
    if (folderSeason) {
      const i = folderSeason.folderIndex;
      const episode = episodeFromLooseName(cleanedBase);
      const showFolder = i > 0 ? cleanTokens(folders[i - 1]) : "";
      const { year: fy, index: fyIdx } = extractYear(showFolder);
      const title = stripToTitle(showFolder, [fyIdx]) || stripToTitle(cleanedBase, [yearIdx]);
      return {
        kind: "episode",
        title,
        year: fy ?? year,
        season: folderSeason.season,
        episode,
        confidence: episode !== null && title ? 0.75 : 0.4,
      };
    }
    // No season folder: "Show Name/01 - Pilot.mkv" — file right inside the show folder.
    const looseEp = episodeFromLooseName(cleanedBase);
    if (looseEp !== null && folders.length > 0) {
      const title = titleFromFolders(parts);
      return { kind: "episode", title, year, season: 1, episode: looseEp, confidence: title ? 0.6 : 0.3 };
    }
    // TV library but no episode info at all
    const title = stripToTitle(cleanedBase, [yearIdx]) || titleFromFolders(parts);
    return { kind: "unknown", title, year, season: null, episode: null, confidence: 0.3 };
  }

  // Movie
  const title = stripToTitle(cleanedBase, [yearIdx]) || titleFromFolders(parts);
  let confidence = 0.5;
  if (year) confidence = 0.85;
  else if (title.split(" ").length >= 2) confidence = 0.65;
  if (!title) confidence = 0.1;
  return { kind: "movie", title, year, season: null, episode: null, confidence };
}

function titleFromFolders(parts: string[]): string {
  // Nearest ancestor folder that isn't a season/disc folder.
  for (let i = parts.length - 2; i >= 0; i--) {
    const f = parts[i];
    if (seasonFromFolder(f) !== null) continue;
    if (/^(subs|subtitles|extras|featurettes|sample)$/i.test(f)) continue;
    const cleaned = cleanTokens(f);
    const { index } = extractYear(cleaned);
    const t = stripToTitle(cleaned, [index]);
    if (t) return t;
  }
  return "";
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
