// Subtitle handling: local sidecar detection, SRT->VTT conversion for the
// HTML5 fallback player, and OpenSubtitles REST API search/download.
import fs from "fs";
import path from "path";
import { getSetting, type DB } from "../db";
import { SUB_EXTS } from "./scanner";
import { appFetch } from "./http";

const OS_API = "https://api.opensubtitles.com/api/v1";

// ISO 639-1 hints commonly used as filename suffixes: Movie.en.srt / Movie.eng.srt
const LANG_HINTS: Record<string, string> = {
  en: "en", eng: "en", english: "en",
  ar: "ar", ara: "ar", arabic: "ar",
  es: "es", spa: "es", spanish: "es",
  fr: "fr", fre: "fr", fra: "fr", french: "fr",
  de: "de", ger: "de", deu: "de", german: "de",
  it: "it", ita: "it", italian: "it",
  pt: "pt", por: "pt",
  ru: "ru", rus: "ru",
  ja: "ja", jpn: "ja",
  ko: "ko", kor: "ko",
  zh: "zh", chi: "zh", zho: "zh",
  tr: "tr", tur: "tr",
  nl: "nl", dut: "nl",
  pl: "pl", pol: "pl",
  sv: "sv", swe: "sv",
  hi: "hi", hin: "hi",
};

export interface LocalSub {
  path: string;
  lang: string | null;
  label: string;
  format: string; // srt | ass | vtt | ssa
}

/** Sidecar subtitles: same-dir files sharing the video's basename, plus a Subs/ subfolder. */
export function findLocalSubtitles(videoPath: string): LocalSub[] {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const results: LocalSub[] = [];

  const scanDir = (d: string, requireBaseMatch: boolean) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (!SUB_EXTS.has(ext)) continue;
      const stem = path.basename(name, ext).toLowerCase();
      if (requireBaseMatch && !stem.startsWith(base)) continue;
      const suffix = stem.slice(base.length).replace(/^[\s._-]+/, "");
      const lang = guessLang(suffix || stem);
      results.push({
        path: path.join(d, name),
        lang,
        label: name,
        format: ext.slice(1),
      });
    }
  };

  scanDir(dir, true);
  for (const subdir of ["subs", "Subs", "subtitles", "Subtitles"]) {
    const d = path.join(dir, subdir);
    if (fs.existsSync(d)) scanDir(d, false);
  }
  return results;
}

function guessLang(s: string): string | null {
  const tokens = s.toLowerCase().split(/[\s._-]+/).filter(Boolean);
  for (const t of tokens.reverse()) {
    if (LANG_HINTS[t]) return LANG_HINTS[t];
  }
  return null;
}

/** Minimal SRT -> WebVTT conversion (HTML5 <track> only accepts VTT). */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r+/g, "")
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) return "";
      // Drop the numeric cue index if present.
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      if (lines.length === 0) return "";
      lines[0] = lines[0].replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return "WEBVTT\n\n" + body + "\n";
}

/** Very rough ASS -> VTT: strips styling, keeps dialogue text/timing. */
export function assToVtt(ass: string): string {
  const cues: string[] = [];
  for (const line of ass.split(/\r?\n/)) {
    const m = /^Dialogue:\s*[^,]*,(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/.exec(line);
    if (!m) continue;
    const toVtt = (t: string) => {
      const [h, mm, rest] = t.split(":");
      return `${h.padStart(2, "0")}:${mm}:${rest}0`;
    };
    const text = m[3]
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/gi, "\n")
      .trim();
    if (text) cues.push(`${toVtt(m[1])} --> ${toVtt(m[2])}\n${text}`);
  }
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- OpenSubtitles

export interface OsSearchResult {
  osFileId: number;
  language: string;
  release: string;
  downloadCount: number;
  hearingImpaired: boolean;
  fps: number | null;
}

export class OpenSubtitles {
  private token: string | null = null;
  private tokenTime = 0;

  constructor(private db: DB, private appVersion: string) {}

  private apiKey(): string {
    const k = getSetting(this.db, "osApiKey");
    if (!k) throw new Error("No OpenSubtitles API key configured (Settings)");
    return k.trim();
  }

  private headers(withAuth = false): Record<string, string> {
    const h: Record<string, string> = {
      "Api-Key": this.apiKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `Locality v${this.appVersion}`,
    };
    if (withAuth && this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /**
   * OpenSubtitles (or its CDN/Cloudflare) sometimes answers with an HTML error
   * page — parse defensively so the user sees a readable reason instead of
   * "Unexpected token <!DOCTYPE".
   */
  private async parseJson(res: Response, what: string): Promise<any> {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      const snippet = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(
        `OpenSubtitles ${what} answered HTTP ${res.status} with a non-JSON page` +
          (snippet ? ` ("${snippet}")` : "") +
          " — usually rate limiting or a key/login problem; try again in a minute"
      );
    }
  }

  async search(params: { query?: string; imdbId?: string | null; tmdbId?: number | null; languages?: string; season?: number; episode?: number }): Promise<OsSearchResult[]> {
    const url = new URL(OS_API + "/subtitles");
    if (params.imdbId) url.searchParams.set("imdb_id", params.imdbId.replace(/^tt/, ""));
    else if (params.tmdbId) url.searchParams.set("tmdb_id", String(params.tmdbId));
    if (params.query) url.searchParams.set("query", params.query);
    if (params.languages) url.searchParams.set("languages", params.languages);
    if (params.season !== undefined) url.searchParams.set("season_number", String(params.season));
    if (params.episode !== undefined) url.searchParams.set("episode_number", String(params.episode));
    url.searchParams.set("order_by", "download_count");

    const res = await appFetch(url, { headers: this.headers() });
    const data: any = await this.parseJson(res, "search");
    if (!res.ok) throw new Error(`OpenSubtitles search failed (${res.status}): ${data?.message ?? "unknown error"}`);
    const out: OsSearchResult[] = [];
    for (const item of data.data ?? []) {
      const a = item.attributes;
      const file = a?.files?.[0];
      if (!file) continue;
      out.push({
        osFileId: file.file_id,
        language: a.language ?? "?",
        release: a.release || file.file_name || "unknown release",
        downloadCount: a.download_count ?? 0,
        hearingImpaired: !!a.hearing_impaired,
        fps: a.fps ?? null,
      });
    }
    return out;
  }

  /** Download requires a logged-in JWT when credentials are configured; anonymous works with reduced quota. */
  private async ensureLogin(): Promise<void> {
    const user = getSetting(this.db, "osUsername");
    const pass = getSetting(this.db, "osPassword");
    if (!user || !pass) return; // anonymous
    if (this.token && Date.now() - this.tokenTime < 20 * 3600 * 1000) return;
    const res = await appFetch(OS_API + "/login", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data: any = await this.parseJson(res, "login");
    if (!res.ok) throw new Error(`OpenSubtitles login failed (${res.status}): ${data?.message ?? "check username/password"}`);
    this.token = data.token;
    this.tokenTime = Date.now();
  }

  /**
   * Download a subtitle next to the video (fallback: app subtitle cache when
   * the media folder is read-only). Returns the saved path.
   */
  async download(osFileId: number, videoPath: string, lang: string, cacheDir: string): Promise<string> {
    await this.ensureLogin();
    const res = await appFetch(OS_API + "/download", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ file_id: osFileId }),
    });
    const data: any = await this.parseJson(res, "download");
    if (!res.ok) {
      throw new Error(
        `OpenSubtitles download failed (${res.status}): ${data?.message ?? "unknown error"}` +
          (res.status === 406 || res.status === 429
            ? " — daily download quota may be exhausted; logging in with a free account in Settings raises it"
            : "")
      );
    }
    if (!data.link) throw new Error("OpenSubtitles returned no download link (quota exhausted?)");
    const subRes = await appFetch(data.link);
    if (!subRes.ok) throw new Error(`Subtitle file fetch failed: ${subRes.status}`);
    const content = Buffer.from(await subRes.arrayBuffer());
    // A web page instead of subtitle text means the link was intercepted
    // (expired link, Cloudflare, captive portal) — don't save garbage.
    const head = content.subarray(0, 200).toString("utf-8").trimStart().toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html")) {
      throw new Error("OpenSubtitles sent a web page instead of the subtitle file — try again, or log in with a free account in Settings");
    }

    const base = path.basename(videoPath, path.extname(videoPath));
    const fileName = `${base}.${lang}.srt`;
    const target = path.join(path.dirname(videoPath), fileName);
    try {
      fs.writeFileSync(target, content);
      return target;
    } catch {
      fs.mkdirSync(cacheDir, { recursive: true });
      const fallback = path.join(cacheDir, fileName);
      fs.writeFileSync(fallback, content);
      return fallback;
    }
  }
}
