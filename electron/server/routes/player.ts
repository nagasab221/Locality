// Playback + streaming + subtitle routes.
// Everything plays in the app's own <video> element, fed by the range-supporting
// /stream endpoint. When the file's audio or video codec isn't one Chromium can
// decode, the server re-wraps (and if needed transcodes) it on the fly via
// ffmpeg — see the compose path below. No external player, no separate window.
import { Router } from "express";
import type { Request } from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import type { Ctx } from "../context";
import type { Episode, MediaFile, MediaItem, ShowPrefs, SubtitleRecord } from "../types";
import { getSetting } from "../db";
import { findLocalSubtitles, srtToVtt, assToVtt } from "../services/subtitles";
import { events } from "../services/events";
import { ffmpegPath } from "../services/introDetect";
import { extractFrame } from "../services/ffthumb";
import { getHwAccelConfig } from "../services/hwaccel";
import { fileVisibleTo, itemVisibleTo, libraryShared, isLocalRequest } from "../services/requestOrigin";

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
  ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
};

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".flv": "video/x-flv",
};

// ---- container probing --------------------------------------------------------
//
// Chromium's <video> can't decode AC-3/E-AC-3/DTS/TrueHD and can't switch audio
// tracks reliably, so the server probes each file once (ffmpeg -i stderr) and,
// when needed, re-wraps the stream on the fly (see /stream compose mode below).

/** Audio codecs Chromium plays natively; anything else needs an AAC transcode. */
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/**
 * Video codecs Chromium (Electron build) can decode. h264/vp8/vp9/av1 always
 * work; hevc only where the GPU + OS provide a hardware decoder, so we try it
 * direct and let the client fall back to a transcode on failure. Anything NOT
 * in this set (mpeg2, xvid/divx, vc1, wmv…) is transcoded from the start.
 */
const COPY_SAFE_VIDEO = new Set(["h264", "vp8", "vp9", "av1", "hevc"]);

export interface AudioStreamInfo {
  /** Ordinal among audio streams (ffmpeg -map 0:a:N). */
  index: number;
  lang: string | null;
  codec: string;
  layout: string | null; // "stereo", "5.1(side)", …
  isDefault: boolean;
  playable: boolean;
}

export interface SubStreamInfo {
  /** Ordinal among subtitle streams (ffmpeg -map 0:s:N). */
  index: number;
  lang: string | null;
  codec: string;
  sdh: boolean;
  forced: boolean;
}

interface ProbeResult {
  durationSec: number | null;
  videoCodec: string | null;
  audio: AudioStreamInfo[];
  subs: SubStreamInfo[];
}

/** Text-based subtitle codecs ffmpeg can convert to WebVTT (bitmap PGS/VobSub can't be). */
const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

const probeCache = new Map<string, ProbeResult>();

function probeFile(filePath: string, mtime: number): Promise<ProbeResult> {
  const key = `${filePath}|${mtime}`;
  const hit = probeCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-i", filePath]);
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    // ffmpeg -i with no output always exits non-zero; the stream list is on stderr.
    proc.on("close", () => {
      const result: ProbeResult = { durationSec: null, videoCodec: null, audio: [], subs: [] };
      const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
      if (dur) result.durationSec = +dur[1] * 3600 + +dur[2] * 60 + +dur[3] + +("0." + dur[4]);
      const streamRe = /Stream #0:\d+(?:\[[^\]]*\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (\w+)([^\n]*)/g;
      let m: RegExpExecArray | null;
      while ((m = streamRe.exec(stderr)) !== null) {
        const [, lang, kind, codec, rest] = m;
        if (kind === "Video") {
          // Skip attached pictures (cover art shows up as an mjpeg video stream).
          if (!result.videoCodec && !rest.includes("attached pic")) result.videoCodec = codec;
        } else if (kind === "Audio") {
          const layout = /\d+ Hz, ([^,]+)/.exec(rest)?.[1]?.trim() ?? null;
          result.audio.push({
            index: result.audio.length,
            lang: lang ?? null,
            codec,
            layout,
            isDefault: rest.includes("(default)"),
            playable: PLAYABLE_AUDIO.has(codec),
          });
        } else {
          result.subs.push({
            index: result.subs.length,
            lang: lang ?? null,
            codec,
            sdh: rest.includes("hearing impaired"),
            forced: rest.includes("forced"),
          });
        }
      }
      probeCache.set(key, result);
      resolve(result);
    });
  });
}

export function playerRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, ledger } = ctx;

  // Progress reads/writes go through the active profile (X-Locality-Profile
  // header or ?profile=); absent → the default profile, which is the ledger.
  const storeFor = (req: Request) =>
    ctx.profiles.store(ctx.profiles.resolve(req.header("x-locality-profile") ?? req.query.profile));

  const getFile = (id: number) =>
    db.prepare("SELECT * FROM files WHERE id = ?").get(id) as MediaFile | undefined;

  // ---- embedded subtitles ---------------------------------------------------
  //
  // Container-embedded text subtitles (MKV subrip/ass — VLC shows them, Chromium
  // can't demux them) are registered instantly upon probing, and extracted on
  // demand (or in the background).
  const subExtractInFlight = new Map<number, Promise<number>>();
  const singleSubExtractInFlight = new Map<string, Promise<void>>();

  /** Instantly register metadata records for all embedded text subtitle streams in SQLite. */
  async function registerEmbeddedSubMetadata(file: any): Promise<void> {
    const probe = await probeFile(file.path, file.mtime).catch(() => null);
    const text = (probe?.subs ?? []).filter((s) => TEXT_SUB_CODECS.has(s.codec));
    if (text.length === 0) return;

    const langSeq = new Map<string, number>();
    const jobs = text.map((s) => {
      const base = s.lang ?? "und";
      const seq = (langSeq.get(base) ?? 0) + 1;
      langSeq.set(base, seq);
      const label = `${base}${s.sdh ? " SDH" : ""}${s.forced ? " forced" : ""}${seq > 1 && !s.sdh && !s.forced ? ` #${seq}` : ""} (embedded)`;
      return { ...s, label, out: path.join(ctx.subsCacheDir, `embedded_${file.id}_${s.index}.vtt`) };
    });

    const upsert = db.prepare(
      `INSERT INTO subtitles (file_id, path, lang, source, label) VALUES (?, ?, ?, 'embedded', ?)
       ON CONFLICT(file_id, path) DO UPDATE SET lang = excluded.lang, label = excluded.label`
    );
    for (const j of jobs) {
      upsert.run(file.id, j.out, j.lang, j.label);
    }
  }

  /** Extract a single embedded subtitle track on demand when requested. */
  function extractSingleSub(file: any, targetPath: string): Promise<void> {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      return Promise.resolve();
    }
    const running = singleSubExtractInFlight.get(targetPath);
    if (running) return running;

    const m = /embedded_\d+_(\d+)\.vtt$/.exec(targetPath);
    if (!m) return Promise.resolve();
    const streamIndex = parseInt(m[1], 10);

    const job = new Promise<void>((resolve) => {
      fs.mkdirSync(ctx.subsCacheDir, { recursive: true });
      const args = [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", file.path,
        "-map", `0:s:${streamIndex}`,
        "-c:s", "webvtt",
        targetPath,
      ];
      const proc = spawn(ffmpegPath(), args);
      const timeout = setTimeout(() => proc.kill(), 60 * 1000);
      let errTail = "";
      proc.stderr.on("data", (c: Buffer) => (errTail = (errTail + c.toString()).slice(-300)));
      proc.on("error", (e) => {
        clearTimeout(timeout);
        console.error(`single subtitle extract error (stream ${streamIndex}):`, e);
        resolve();
      });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) console.error(`single subtitle extract exited ${code} (stream ${streamIndex}): ${errTail}`);
        resolve();
      });
    }).finally(() => singleSubExtractInFlight.delete(targetPath));

    singleSubExtractInFlight.set(targetPath, job);
    return job;
  }

  function ensureEmbeddedSubs(file: any): Promise<number> {
    const running = subExtractInFlight.get(file.id);
    if (running) return running;
    const job = (async () => {
      await registerEmbeddedSubMetadata(file);

      const rows = db.prepare("SELECT * FROM subtitles WHERE file_id = ? AND source = 'embedded'").all(file.id) as SubtitleRecord[];
      const todo = rows.filter((r) => !fs.existsSync(r.path) || fs.statSync(r.path).size === 0);
      if (todo.length === 0) return 0;

      const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", file.path];
      for (const r of todo) {
        const m = /embedded_\d+_(\d+)\.vtt$/.exec(r.path);
        if (m) {
          args.push("-map", `0:s:${m[1]}`, "-c:s", "webvtt", r.path);
        }
      }
      if (args.length <= 7) return 0;

      fs.mkdirSync(ctx.subsCacheDir, { recursive: true });
      await new Promise<void>((resolve) => {
        const proc = spawn(ffmpegPath(), args);
        const timeout = setTimeout(() => proc.kill(), 5 * 60 * 1000);
        let errTail = "";
        proc.stderr.on("data", (c: Buffer) => (errTail = (errTail + c.toString()).slice(-300)));
        proc.on("error", (e) => {
          clearTimeout(timeout);
          console.error(`embedded subtitle extract error:`, e);
          resolve();
        });
        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) console.error(`embedded subtitle extract exited ${code} (${file.filename}): ${errTail}`);
          resolve();
        });
      });

      let n = 0;
      for (const r of todo) {
        if (fs.existsSync(r.path) && fs.statSync(r.path).size > 0) n++;
      }
      return n;
    })()
      .catch((e) => {
        console.error(`embedded subtitle extraction failed (${file.filename}):`, e);
        return 0;
      })
      .finally(() => subExtractInFlight.delete(file.id));
    subExtractInFlight.set(file.id, job);
    return job;
  }

  /** Kick extraction in the background; notify clients when new tracks appear. */
  function extractEmbeddedSubsAsync(file: any) {
    void ensureEmbeddedSubs(file).then((n) => {
      if (n > 0) events.broadcast("subs-updated", { fileId: file.id });
    });
  }

  /** Register sidecar subs in the DB and return them with stable ids. */
  function registeredSubs(file: any) {
    const found = findLocalSubtitles(file.path);
    const upsert = db.prepare(
      `INSERT INTO subtitles (file_id, path, lang, source, label) VALUES (?, ?, ?, 'local', ?)
       ON CONFLICT(file_id, path) DO UPDATE SET lang = excluded.lang, label = excluded.label`
    );
    for (const s of found) upsert.run(file.id, s.path, s.lang, s.label);
    const rows = db.prepare("SELECT * FROM subtitles WHERE file_id = ?").all(file.id) as SubtitleRecord[];
    const out = [];
    for (const row of rows) {
      // Drop local sidecar registrations if the file was deleted from disk
      if (row.source === "local" && !fs.existsSync(row.path)) {
        db.prepare("DELETE FROM subtitles WHERE id = ?").run(row.id);
        continue;
      }
      out.push({ ...row, format: path.extname(row.path).slice(1).toLowerCase() || "vtt" });
    }
    return out;
  }

  /** Next episode (with a file) after the given one, or null. */
  function nextEpisodeInfo(episodeId: number | null) {
    if (!episodeId) return null;
    const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId) as Episode | undefined;
    if (!ep) return null;
    const next = db
      .prepare(
        `SELECT e.*, f.id AS file_id FROM episodes e
         JOIN files f ON f.episode_id = e.id AND f.missing = 0
         WHERE e.show_id = ? AND (e.season > ? OR (e.season = ? AND e.episode > ?))
         ORDER BY e.season, e.episode LIMIT 1`
      )
      .get(ep.show_id, ep.season, ep.season, ep.episode) as any;
    if (!next) return null;
    return {
      fileId: next.file_id,
      season: next.season,
      episode: next.episode,
      title: next.title ?? `Episode ${next.episode}`,
      still: next.still ?? null,
    };
  }

  /** Everything the renderer needs before starting playback (resume dialog etc.). */
  r.get("/player/prepare/:fileId", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "No such file" });
    if (!fs.existsSync(file.path)) return res.status(410).json({ error: "File is missing on disk" });
    const store = storeFor(req);
    const progress = store.get(file.fingerprint);
    const probe = await probeFile(file.path, file.mtime).catch(() => null);
    const defaultAudio = probe?.audio.find((a) => a.isDefault) ?? probe?.audio[0] ?? null;
    // Video transcode needed up front only for codecs Chromium can never play.
    const videoTranscodeRequired = !!probe?.videoCodec && !COPY_SAFE_VIDEO.has(probe.videoCodec);
    const audioTranscodeRequired = defaultAudio ? !defaultAudio.playable : false;
    // Embedded text sub metadata is registered immediately (<20ms probe); extraction runs in the background.
    await registerEmbeddedSubMetadata(file).catch(() => {});
    extractEmbeddedSubsAsync(file);
    preloadThumbsAsync(file, probe?.durationSec ?? null);
    // Prefetch the NEXT episode's embedded subs now, so they're already
    // registered when it starts instead of making the user wait on ffmpeg again.
    const nextInfo = nextEpisodeInfo(file.episode_id);
    if (nextInfo) {
      const nextFile = getFile(nextInfo.fileId);
      if (nextFile) {
        await registerEmbeddedSubMetadata(nextFile).catch(() => {});
        extractEmbeddedSubsAsync(nextFile);
      }
    }
    const ep = file.episode_id
      ? (db.prepare("SELECT intro_start, intro_end, credits_start FROM episodes WHERE id = ?").get(file.episode_id) as Pick<Episode, "intro_start" | "intro_end" | "credits_start"> | undefined)
      : null;
    // Remembered audio/subtitle language for this show/movie (see show_prefs).
    const itemId = ownerItemId(file);
    const prefs = itemId
      ? (db.prepare("SELECT audio_lang, sub_lang FROM show_prefs WHERE item_id = ?").get(itemId) as Pick<ShowPrefs, "audio_lang" | "sub_lang"> | undefined)
      : null;
    res.json({
      itemId,
      // Audio tracks + whether the default one needs the composed (ffmpeg) stream.
      audio: probe?.audio ?? [],
      durationSec: probe?.durationSec ?? null,
      composeRequired: audioTranscodeRequired || videoTranscodeRequired,
      videoTranscodeRequired,
      defaultAudioIndex: defaultAudio?.index ?? 0,
      file: { id: file.id, filename: file.filename, size: file.size, path: file.path, fingerprint: file.fingerprint },
      progress,
      subtitles: registeredSubs(file),
      title: playbackTitle(file),
      streamUrl: `/api/stream/${file.id}`,
      mime: MIME[path.extname(file.path).toLowerCase()] ?? "video/mp4",
      markers: ep
        ? { introStart: ep.intro_start, introEnd: ep.intro_end, creditsStart: ep.credits_start }
        : null,
      next: nextInfo,
      playback: {
        autoplayNext: getSetting(db, "autoplayNext") !== "0", // default on
        upNextSeconds: Number(getSetting(db, "upNextSeconds")) || 10,
        skipIntro: getSetting(db, "skipIntro") !== "0", // default on
        defaultSubLang: getSetting(db, "defaultSubLang") || "", // auto-enable subs in this language
        // "mpv" routes local playback through the embedded mpv engine instead of
        // the built-in <video>. Default is mpv on Windows (where the embedding
        // works); an explicit setting overrides. Remote playback ignores this and
        // always uses the built-in player (see useMpv in Player.tsx).
        engine: ((): "mpv" | "builtin" => {
          const pe = getSetting(db, "playbackEngine");
          if (pe === "mpv" || pe === "builtin") return pe;
          // Default to mpv wherever it can embed: Windows, or Linux under X11
          // (not Wayland — no --wid there). Keep in sync with mpvEmbedSupported().
          const linuxX11 = process.platform === "linux" && process.env.XDG_SESSION_TYPE !== "wayland" && !process.env.WAYLAND_DISPLAY;
          return process.platform === "win32" || linuxX11 ? "mpv" : "builtin";
        })(),
        // Per-show overrides (win over the global defaults above when present).
        prefAudioLang: prefs?.audio_lang ?? null,
        prefSubLang: prefs?.sub_lang ?? null,
      },
    });
  });

  /** Show/movie id that owns a file, used to key remembered track prefs. */
  function ownerItemId(file: any): number | null {
    if (file.episode_id) {
      const ep = db.prepare("SELECT show_id FROM episodes WHERE id = ?").get(file.episode_id) as Pick<Episode, "show_id"> | undefined;
      return ep?.show_id ?? null;
    }
    return file.media_item_id ?? null;
  }

  /** Remember the audio and/or subtitle language for a show/movie. Fields are
   *  independent: send only audioLang, only subLang, or both. subLang 'off'
   *  means the user deliberately wants no subtitles for this title. */
  r.put("/player/prefs/:itemId", (req, res) => {
    const itemId = +req.params.itemId;
    if (!db.prepare("SELECT id FROM media_items WHERE id = ?").get(itemId))
      return res.status(404).json({ error: "No such item" });
    const existing = db.prepare("SELECT audio_lang, sub_lang FROM show_prefs WHERE item_id = ?").get(itemId) as Pick<ShowPrefs, "audio_lang" | "sub_lang"> | undefined;
    const nextAudio = req.body?.audioLang !== undefined ? req.body.audioLang : existing?.audio_lang ?? null;
    const nextSub = req.body?.subLang !== undefined ? req.body.subLang : existing?.sub_lang ?? null;
    db.prepare(
      `INSERT INTO show_prefs (item_id, audio_lang, sub_lang) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET audio_lang = excluded.audio_lang, sub_lang = excluded.sub_lang`
    ).run(itemId, nextAudio, nextSub);
    res.json({ ok: true, audioLang: nextAudio, subLang: nextSub });
  });

  /** Same as above but keyed by file — the mpv overlay knows its file id, not the
   *  owning show/movie. Loose files (no owner) are a no-op. */
  r.put("/player/prefs-by-file/:fileId", (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    const itemId = ownerItemId(file);
    if (itemId == null) return res.json({ ok: true, skipped: true });
    const existing = db.prepare("SELECT audio_lang, sub_lang FROM show_prefs WHERE item_id = ?").get(itemId) as Pick<ShowPrefs, "audio_lang" | "sub_lang"> | undefined;
    const nextAudio = req.body?.audioLang !== undefined ? req.body.audioLang : existing?.audio_lang ?? null;
    const nextSub = req.body?.subLang !== undefined ? req.body.subLang : existing?.sub_lang ?? null;
    db.prepare(
      `INSERT INTO show_prefs (item_id, audio_lang, sub_lang) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET audio_lang = excluded.audio_lang, sub_lang = excluded.sub_lang`
    ).run(itemId, nextAudio, nextSub);
    res.json({ ok: true, itemId, audioLang: nextAudio, subLang: nextSub });
  });

  /** Rich metadata for the mpv "paused" title card: show/episode names, synopsis,
   *  genres, and the content certification (fetched once from TMDB, then cached). */
  r.get("/player/meta/:fileId", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "No such file" });

    let item: MediaItem | undefined;
    let ep: Episode | undefined;
    if (file.episode_id) {
      ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(file.episode_id) as Episode | undefined;
      if (ep) item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(ep.show_id) as MediaItem | undefined;
    } else if (file.media_item_id) {
      item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(file.media_item_id) as MediaItem | undefined;
    }
    if (!item) return res.json({ showTitle: file.filename, genres: [] }); // loose/unmatched file

    // Certification: use the cached column, else fetch once from TMDB and store.
    let contentRating: string | null = (item as { content_rating?: string | null }).content_rating ?? null;
    if (!contentRating && item.tmdb_id) {
      contentRating = await ctx.tmdb.contentRating(item.tmdb_id, item.type === "show" ? "tv" : "movie").catch(() => null);
      if (contentRating) db.prepare("UPDATE media_items SET content_rating = ? WHERE id = ?").run(contentRating, item.id);
    }
    let genres: string[] = [];
    try {
      genres = JSON.parse(item.genres || "[]");
    } catch {}

    const nextInfo = file.episode_id ? nextEpisodeInfo(file.episode_id) : null;
    res.json({
      showTitle: item.title,
      episodeTitle: ep?.title ?? null,
      season: ep?.season ?? null,
      episode: ep?.episode ?? null,
      overview: ep?.overview || item.overview || null,
      year: item.year ?? null,
      runtime: ep?.runtime ?? item.runtime ?? null,
      genres,
      voteRating: item.rating ?? null,
      contentRating: contentRating ?? null,
      // Skip Intro / Skip Credits markers (from fingerprint detection).
      introStart: ep?.intro_start ?? null,
      introEnd: ep?.intro_end ?? null,
      creditsStart: ep?.credits_start ?? null,
      // Up Next card.
      next: nextInfo ? { title: nextInfo.title, season: nextInfo.season, episode: nextInfo.episode } : null,
      autoplayNext: getSetting(db, "autoplayNext") !== "0",
      upNextSeconds: Number(getSetting(db, "upNextSeconds")) || 10,
    });
  });

  // ---- seek-preview thumbnails (on demand) ----------------------------------
  //
  // One frame, extracted when the user hovers — nothing is processed up front,
  // so previews work instantly on a file that's never been opened. `-ss` BEFORE
  // `-i` is a keyframe seek (tens of ms), which is what makes this viable per
  // hover; being within a GOP of the exact time is fine for a preview.
  // Times snap to 5s buckets so hovering reuses one cached jpg (and the
  // browser's own cache) instead of re-extracting on every pixel of movement.
  const THUMB_BUCKET = 5;
  const THUMB_WIDTH = 160;
  const THUMB_CACHE_CAP = 300 * 1024 * 1024; // prune the oldest beyond this
  const MAX_CONCURRENT_THUMBS = 6;
  const thumbInFlight = new Map<string, Promise<string | null>>();
  const thumbQueue: (() => void)[] = [];

  const thumbPath = (file: any, bucket: number) =>
    path.join(ctx.thumbsDir, `th_${file.id}_${file.mtime}_${bucket}.jpg`);

  async function makeThumb(file: any, bucket: number): Promise<string | null> {
    const out = thumbPath(file, bucket);
    if (fs.existsSync(out)) return out;
    const running = thumbInFlight.get(out);
    if (running) return running;

    if (thumbInFlight.size >= MAX_CONCURRENT_THUMBS) {
      await new Promise<void>((r) => {
        thumbQueue.push(r);
        setTimeout(r, 8000); // 8s queue timeout
      });
      if (fs.existsSync(out)) return out;
      if (thumbInFlight.size >= MAX_CONCURRENT_THUMBS) return null;
    }

    const job = new Promise<string | null>((resolve) => {
      fs.mkdirSync(ctx.thumbsDir, { recursive: true });
      const proc = spawn(ffmpegPath(), [
        "-hide_banner", "-nostdin",
        "-noaccurate_seek",
        "-ss", String(bucket),
        "-i", file.path,
        "-frames:v", "1",
        "-vf", `scale=${THUMB_WIDTH}:-2`,
        "-q:v", "5",
        "-y", out,
      ]);
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => resolve(code === 0 && fs.existsSync(out) ? out : null));
    }).finally(() => {
      thumbInFlight.delete(out);
      const next = thumbQueue.shift();
      if (next) next();
    });

    thumbInFlight.set(out, job);
    return job;
  }

  /** Background pre-extract keyframe thumbnails for an active file */
  function preloadThumbsAsync(file: any, durationSec: number | null) {
    if (!durationSec || durationSec <= 0) return;
    void (async () => {
      const step = 10;
      for (let t = 0; t < durationSec; t += step) {
        const bucket = Math.floor(t / THUMB_BUCKET) * THUMB_BUCKET;
        if (!fs.existsSync(thumbPath(file, bucket))) {
          await makeThumb(file, bucket).catch(() => {});
          await new Promise((r) => setTimeout(r, 100)); // low priority pacing
        }
      }
    })();
  }

  /** Keep the thumb cache bounded; drops the least-recently-modified files. */
  function pruneThumbs() {
    try {
      if (!fs.existsSync(ctx.thumbsDir)) return;
      const files = fs
        .readdirSync(ctx.thumbsDir)
        .map((n) => {
          const p = path.join(ctx.thumbsDir, n);
          const st = fs.statSync(p);
          return { p, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (total <= THUMB_CACHE_CAP) break;
        fs.rmSync(f.p, { force: true });
        total -= f.size;
      }
    } catch {
      /* cache pruning is best-effort */
    }
  }

  // Startup housekeeping: bound the cache and drop the old sprite-sheet cache
  // from the previous (whole-file) implementation.
  pruneThumbs();
  try {
    const legacy = path.join(path.dirname(ctx.thumbsDir), "trickplay");
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  r.get("/player/thumb/:fileId", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).end();
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).end();
    const bucket = Math.max(0, Math.floor((Number(req.query.t) || 0) / THUMB_BUCKET) * THUMB_BUCKET);
    const out = await makeThumb(file, bucket).catch(() => null);
    if (!out) return res.status(503).end(); // busy or unextractable; client just shows the time
    res.type("image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    fs.createReadStream(out).pipe(res);
  });

  function playbackTitle(file: any): string {
    if (file.episode_id) {
      const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(file.episode_id) as Episode | undefined;
      const show = ep && (db.prepare("SELECT title FROM media_items WHERE id = ?").get(ep.show_id) as Pick<MediaItem, "title"> | undefined);
      if (ep && show) {
        return `${show.title} · S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
      }
    }
    if (file.media_item_id) {
      const item = db.prepare("SELECT title, year FROM media_items WHERE id = ?").get(file.media_item_id) as Pick<MediaItem, "title" | "year"> | undefined;
      if (item) return item.year ? `${item.title} (${item.year})` : item.title;
    }
    return file.filename;
  }


  /** Offline sync from companion apps: ledger-shaped entries recorded while the
   *  phone was away. Merged newest-wins (same rules as locality.json), so stale
   *  offline data can never clobber fresher desktop progress. */
  r.post("/player/progress-batch", (req, res) => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries)) return res.status(400).json({ error: "Body must be { entries: [...] }" });
    const changed = ledger.mergeEntries(entries);
    if (changed > 0) events.broadcast("ledger-merged", { changed });
    res.json({ ok: true, changed, received: entries.length });
  });

  // ---- offline export (companion apps) ------------------------------------------
  //
  // Manifest for "Download Movie" / "Download Season": one JSON with every file,
  // subtitle and marker a phone needs. Actual bytes go through the existing
  // range-supporting /stream/:fileId (resumable) and /subtitles/:subId/vtt.
  r.get("/export/items/:id", (req, res) => {
    const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(+req.params.id) as MediaItem | undefined;
    if (!item) return res.status(404).json({ error: "No such item" });
    if (!itemVisibleTo(db, req, item.id)) return res.status(404).json({ error: "No such item" });
    const seasonFilter = req.query.season !== undefined ? Number(req.query.season) : null;
    const store = storeFor(req);

    const fileEntry = (f: any) => {
      // Fire-and-forget: embedded subs extracted now are picked up by the
      // phone's next download of this item (manifest stays fast).
      extractEmbeddedSubsAsync(f);
      return fileEntryOf(f);
    };
    const fileEntryOf = (f: any) => ({
      id: f.id,
      filename: f.filename,
      size: f.size,
      fingerprint: f.fingerprint,
      mime: MIME[path.extname(f.path).toLowerCase()] ?? "application/octet-stream",
      streamPath: `/api/stream/${f.id}`,
      subtitles: registeredSubs(f).map((s: any) => ({
        id: s.id,
        lang: s.lang,
        label: s.label,
        format: s.format,
        vttPath: `/api/subtitles/${s.id}/vtt`,
      })),
      progress: store.get(f.fingerprint),
    });

    const out: any = {
      generatedAt: new Date().toISOString(),
      item: {
        id: item.id,
        type: item.type,
        title: item.title,
        year: item.year,
        overview: item.overview,
        poster: item.poster,
        backdrop: item.backdrop,
        genres: JSON.parse(item.genres ?? "[]"),
      },
    };

    if (item.type === "movie") {
      const files = db
        .prepare("SELECT * FROM files WHERE media_item_id = ? AND episode_id IS NULL AND missing = 0")
        .all(item.id) as MediaFile[];
      out.files = files.filter((f) => fs.existsSync(f.path)).map(fileEntry);
    } else {
      const eps = (
        seasonFilter !== null
          ? db.prepare("SELECT * FROM episodes WHERE show_id = ? AND season = ? ORDER BY season, episode").all(item.id, seasonFilter)
          : db.prepare("SELECT * FROM episodes WHERE show_id = ? ORDER BY season, episode").all(item.id)
      ) as Episode[];
      out.episodes = [];
      for (const ep of eps) {
        const f = db.prepare("SELECT * FROM files WHERE episode_id = ? AND missing = 0 LIMIT 1").get(ep.id) as MediaFile | undefined;
        if (!f || !fs.existsSync(f.path)) continue;
        out.episodes.push({
          id: ep.id,
          season: ep.season,
          episode: ep.episode,
          title: ep.title,
          overview: ep.overview,
          still: ep.still,
          runtime: ep.runtime,
          airDate: ep.air_date,
          markers: {
            introStart: ep.intro_start ?? null,
            introEnd: ep.intro_end ?? null,
            creditsStart: ep.credits_start ?? null,
          },
          file: fileEntry(f),
        });
      }
    }
    res.json(out);
  });

  /**
   * Resolve a party's fingerprint against THIS library.
   *
   * A watch party in "local" mode carries only the path-independent fingerprint
   * (see services/party.ts), so every member finds their own copy. The desktop
   * looks it up in its own SQLite; a phone has no library of its own and asks
   * the server it's connected to through here.
   */
  r.get("/files/by-fingerprint/:fp", (req, res) => {
    const file = db
      .prepare("SELECT * FROM files WHERE fingerprint = ? AND missing = 0 LIMIT 1")
      .get(String(req.params.fp)) as MediaFile | undefined;
    if (!file) return res.status(404).json({ error: "Not in this library" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "Not in this library" });
    const ep = file.episode_id
      ? (db.prepare("SELECT show_id, season, episode FROM episodes WHERE id = ?").get(file.episode_id) as any)
      : null;
    res.json({
      fileId: file.id,
      title: playbackTitle(file),
      itemId: ep?.show_id ?? file.media_item_id ?? null,
      season: ep?.season ?? null,
      episode: ep?.episode ?? null,
    });
  });

  /** Watched toggle addressed by FILE (Continue Watching cards only know the fileId). */
  r.post("/files/:fileId/watched", (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    storeFor(req).setWatched(file.fingerprint, file.filename, file.size, !!req.body?.watched);
    res.json({ ok: true });
  });

  /** Periodic position reports from the player (desktop and phone alike). */
  r.post("/player/progress", (req, res) => {
    const { fileId, position, duration } = req.body ?? {};
    const file = getFile(+fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    storeFor(req).update(file.fingerprint, file.filename, file.size, Number(position) || 0, Number(duration) || 0);
    res.json({ ok: true });
  });

  // ---- streaming (HTML5 fallback) ---------------------------------------------

  /**
   * Composed stream: ffmpeg re-wraps the file into fragmented MP4 on the fly.
   * Video is copied untouched unless ?vt=1 (then transcoded to H.264, for codecs
   * Chromium can't decode). The chosen audio track is copied, or transcoded to
   * AAC when Chromium can't play its codec. No byte ranges: seeking reloads with
   * ?start=S; timestamps restart at 0, so the client keeps
   * `displayed = start + currentTime`.
   */
  async function composeStream(req: any, res: any, file: any) {
    const audioIdx = Math.max(0, Number(req.query.audio) || 0);
    const start = Math.max(0, Number(req.query.start) || 0);
    const probe = await probeFile(file.path, file.mtime).catch(() => null);
    const copySafeVideo = probe?.videoCodec && COPY_SAFE_VIDEO.has(probe.videoCodec);
    // Copy the video untouched for instant start, EXCEPT re-encode when the
    // client asks (?vt=1), when the codec can't be copied into MP4 for Chromium,
    // OR when starting at an offset. A copied stream can only begin on a
    // keyframe, so a copy-seek lands BEFORE the requested point and the player
    // then believes it's further along than it is — that mismatch is what saved
    // resume positions (and fired "ended") in the wrong place. Re-encoding seeks
    // frame-accurately so audio and video both land exactly on `start`; the GPU
    // encoder keeps that fast.
    const videoTranscode = req.query.vt === "1" || !copySafeVideo || start > 0;
    const track = probe?.audio[audioIdx];
    const hwConfig = videoTranscode ? await getHwAccelConfig(db) : null;
    const audioArgs = track && track.playable
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];
    const videoArgs = videoTranscode && hwConfig
      ? hwConfig.videoArgs
      : ["-c:v", "copy", ...(probe?.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : [])];
    const inputHwArgs = videoTranscode && hwConfig ? hwConfig.inputArgs : [];
    // Fast + accurate seek: a coarse keyframe seek to ~12s before the target
    // (cheap, before -i) then an accurate decode seek for the remainder (after
    // -i), so both streams start exactly on `start` and the timeline stays true.
    const coarse = start > 12 ? start - 12 : 0;
    const preInput = start > 0 ? ["-ss", String(coarse)] : [];
    const postInput = start > 0 ? ["-ss", String(start - coarse)] : [];
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      ...inputHwArgs,
      ...preInput,
      "-i", file.path,
      ...postInput,
      "-map", "0:v:0", "-map", `0:a:${audioIdx}?`,
      ...videoArgs, ...audioArgs,
      "-sn", "-dn",
      "-avoid_negative_ts", "make_zero",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-",
    ];
    res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
    const proc = spawn(ffmpegPath(), args);
    let errTail = "";
    proc.stderr.on("data", (c: Buffer) => (errTail = (errTail + c.toString()).slice(-400)));
    proc.stdout.pipe(res);
    proc.on("error", (e) => {
      console.error("compose stream spawn failed:", e);
      res.end();
    });
    proc.on("close", (code) => {
      if (code && errTail) console.error(`compose stream ffmpeg exited ${code}: ${errTail}`);
      if (!res.writableEnded) res.end();
    });
    res.on("close", () => proc.kill());
  }

  r.get("/stream/:fileId", (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file || !fs.existsSync(file.path)) return res.status(404).end();
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).end();
    // ?audio= / ?start= / ?vt= switch to the ffmpeg-composed path; the plain
    // route below stays byte-range static (untouched fast path).
    if (req.query.audio !== undefined || req.query.start !== undefined || req.query.vt !== undefined) {
      void composeStream(req, res, file);
      return;
    }
    const stat = fs.statSync(file.path);
    const mime = MIME[path.extname(file.path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(file.path, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
      fs.createReadStream(file.path, { highWaterMark: 1024 * 1024 }).pipe(res);
    }
  });

  // ---- subtitles ----------------------------------------------------------------

  r.get("/files/:fileId/subtitles", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "No such file" });
    // Instantly register metadata for embedded tracks (<20ms probe, no blocking)
    await registerEmbeddedSubMetadata(file).catch(() => {});
    // Kick background extraction for any unextracted tracks
    extractEmbeddedSubsAsync(file);
    res.json({
      local: registeredSubs(file),
      embedded: [],
    });
  });

  /** Serve any registered subtitle converted to VTT (for the HTML5 <track>). */
  r.get("/subtitles/:subId/vtt", async (req, res) => {
    const sub = db.prepare("SELECT * FROM subtitles WHERE id = ?").get(+req.params.subId) as SubtitleRecord | undefined;
    if (!sub) return res.status(404).end();
    if (!fileVisibleTo(db, req, sub.file_id)) return res.status(404).end();

    // On-demand extraction for embedded tracks that haven't landed on disk yet.
    if (sub.source === "embedded" && (!fs.existsSync(sub.path) || fs.statSync(sub.path).size === 0)) {
      const file = getFile(sub.file_id);
      if (file && fs.existsSync(file.path)) {
        // A background batch pass (kicked at /player/prepare) may already be
        // extracting THIS file's tracks. Wait for it before spawning our own
        // ffmpeg on the same output file — two writers race, and on Windows the
        // second hits a sharing violation, which left the first selection blank
        // until the episode was reopened. Only extract solo if the batch didn't
        // produce this track.
        const batch = subExtractInFlight.get(file.id);
        if (batch) await batch.catch(() => {});
        if (!fs.existsSync(sub.path) || fs.statSync(sub.path).size === 0) {
          await extractSingleSub(file, sub.path).catch(() => {});
        }
      }
    }

    if (!fs.existsSync(sub.path) || fs.statSync(sub.path).size === 0) return res.status(404).end();
    const raw = fs.readFileSync(sub.path, "utf-8");
    const ext = path.extname(sub.path).toLowerCase();
    const vtt = ext === ".vtt" ? raw : ext === ".srt" ? srtToVtt(raw) : assToVtt(raw);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.send(vtt);
  });

  r.get("/files/:fileId/os-search", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "No such file" });
    const lang = (req.query.lang as string) || getSetting(db, "defaultSubLang") || "en";
    try {
      const params: any = { languages: lang };
      if (file.episode_id) {
        const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(file.episode_id) as Episode | undefined;
        const show = ep && (db.prepare("SELECT * FROM media_items WHERE id = ?").get(ep.show_id) as MediaItem | undefined);
        if (show?.imdb_id) params.imdbId = show.imdb_id;
        else if (show?.tmdb_id) params.tmdbId = show.tmdb_id;
        else params.query = show?.title ?? file.filename;
        if (ep) {
          params.season = ep.season;
          params.episode = ep.episode;
        }
      } else if (file.media_item_id) {
        const item = db.prepare("SELECT * FROM media_items WHERE id = ?").get(file.media_item_id) as MediaItem | undefined;
        if (item?.imdb_id) params.imdbId = item.imdb_id;
        else if (item?.tmdb_id) params.tmdbId = item.tmdb_id;
        else params.query = item?.title ?? file.filename;
      } else {
        params.query = file.filename.replace(/\.[^.]+$/, "");
      }
      res.json(await ctx.osubs.search(params));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/files/:fileId/os-download", async (req, res) => {
    const file = getFile(+req.params.fileId);
    if (!file) return res.status(404).json({ error: "No such file" });
    if (!fileVisibleTo(db, req, file.id)) return res.status(404).json({ error: "No such file" });
    const { osFileId, lang, label } = req.body ?? {};
    if (!osFileId) return res.status(400).json({ error: "osFileId required" });
    try {
      const saved = await ctx.osubs.download(+osFileId, file.path, lang || "en", ctx.subsCacheDir);
      db.prepare(
        `INSERT INTO subtitles (file_id, path, lang, source, label) VALUES (?, ?, ?, 'opensubtitles', ?)
         ON CONFLICT(file_id, path) DO UPDATE SET lang = excluded.lang, label = excluded.label`
      ).run(file.id, saved, lang || "en", label || path.basename(saved));
      const sub = db.prepare("SELECT * FROM subtitles WHERE file_id = ? AND path = ?").get(file.id, saved) as SubtitleRecord | undefined;
      // The player picks the new track up from the response (it's added to the menu).
      res.json({ ...sub, format: path.extname(saved).slice(1).toLowerCase() });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // ---- gallery (photos + short clips) ---------------------------------------

  const galleryThumbsDir = path.join(path.dirname(ctx.thumbsDir), "gallery-thumbs");
  const galleryItem = (id: number) =>
    db.prepare("SELECT * FROM gallery_items WHERE id = ?").get(id) as
      | { id: number; path: string; filename: string; kind: string; mtime: number; library_id: number }
      | undefined;

  /** All items in a gallery library, oldest-folder/name first for the grid. */
  r.get("/gallery/:libId", (req, res) => {
    if (!isLocalRequest(req) && !libraryShared(db, +req.params.libId)) return res.status(404).json({ error: "No such library" });
    const items = db
      .prepare("SELECT id, filename, kind, folder, taken_at FROM gallery_items WHERE library_id = ? AND missing = 0 ORDER BY folder, filename")
      .all(+req.params.libId);
    res.json(items);
  });

  /** Cached, ffmpeg-scaled thumbnail (works for both photos and clips). */
  r.get("/gallery/thumb/:id", async (req, res) => {
    const it = galleryItem(+req.params.id);
    if (!it || !fs.existsSync(it.path)) return res.status(404).end();
    if (!isLocalRequest(req) && !libraryShared(db, it.library_id)) return res.status(404).end();
    fs.mkdirSync(galleryThumbsDir, { recursive: true });
    const cache = path.join(galleryThumbsDir, `g_${it.id}_${it.mtime}.jpg`);
    if (!fs.existsSync(cache)) {
      // Clips: grab a frame a moment in; photos: `at` is ignored by ffmpeg.
      const ok = await extractFrame(it.path, cache, { at: it.kind === "video" ? 1 : 0, width: 360 });
      if (!ok) return res.status(415).end();
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/jpeg");
    fs.createReadStream(cache).pipe(res);
  });

  /** The original photo/video, with range support so clips seek. */
  r.get("/gallery/full/:id", (req, res) => {
    const it = galleryItem(+req.params.id);
    if (!it || !fs.existsSync(it.path)) return res.status(404).end();
    if (!isLocalRequest(req) && !libraryShared(db, it.library_id)) return res.status(404).end();
    const ext = path.extname(it.path).toLowerCase();
    const mime = MIME[ext] ?? IMAGE_MIME[ext] ?? "application/octet-stream";
    const stat = fs.statSync(it.path);
    const range = req.headers.range;
    if (range && it.kind === "video") {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(it.path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
      fs.createReadStream(it.path).pipe(res);
    }
  });

  return r;
}
