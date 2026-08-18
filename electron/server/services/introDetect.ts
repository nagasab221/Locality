// Automatic intro / end-credits detection via audio fingerprinting.
//
// For each show we pick a reference episode, then compare every other
// episode's audio against it: the longest run of near-identical fingerprint
// frames in the head (first ~10 min) is the intro; in the tail (last ~5 min)
// it's the end credits. Results are stored PER EPISODE (recap/cold-open
// lengths shift the intro's absolute position between episodes).
//
// Fingerprint: Haitsma–Kalker style — per ~0.37s window, 16 log-spaced
// spectral band energies -> 15 sign bits of the band-difference derivative.
// Frames are compared by Hamming distance with a sliding lag, exactly the
// Chromaprint comparison model, but self-contained (no fpcalc binary needed;
// ffmpeg-static supplies the PCM).
import { spawn } from "child_process";
import { EventEmitter } from "events";
import type { DB } from "../db";
import { events } from "./events";

const SAMPLE_RATE = 11025;
const FRAME = 4096; // ~0.372 s
const HOP = 1024; // ~0.093 s
const HOP_SEC = HOP / SAMPLE_RATE;
const BANDS = 16; // -> 15 bits per frame
const HEAD_SECONDS = 600; // intro search window
const TAIL_SECONDS = 300; // credits search window
const MIN_RUN_SEC = 10; // discard shorter matches (incidental music)
const MAX_INTRO_RUN_SEC = 240; // longer = probably duplicate files, reject
const MAX_HAMMING = 3; // per-frame distance considered "matching"

export function ffmpegPath(): string {
  // ffmpeg-static resolves to a real binary; inside an asar package the
  // binary lives in app.asar.unpacked.
  const p = require("ffmpeg-static") as string;
  return p.replace("app.asar", "app.asar.unpacked");
}

interface Clip {
  pcm: Int16Array;
  /** Position of the clip's first sample in the file, in seconds. */
  offsetSec: number;
  durationSec: number | null; // whole-file duration if ffmpeg reported it
}

/** Extract mono low-rate PCM. tail=true grabs the last TAIL_SECONDS instead of the head. */
function extractPcm(file: string, tail: boolean): Promise<Clip> {
  return new Promise((resolve, reject) => {
    const args = tail
      ? ["-sseof", String(-TAIL_SECONDS), "-i", file]
      : ["-i", file, "-t", String(HEAD_SECONDS)];
    const proc = spawn(ffmpegPath(), [
      "-hide_banner", "-nostdin",
      ...args,
      "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(SAMPLE_RATE),
      "-f", "s16le", "-",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 && buf.length < SAMPLE_RATE * 2 * 20) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      }
      const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
      const duration = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +("0." + m[4]) : null;
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      const clipSec = pcm.length / SAMPLE_RATE;
      resolve({
        pcm,
        durationSec: duration,
        offsetSec: tail && duration ? Math.max(0, duration - clipSec) : 0,
      });
    });
  });
}

/** Let the event loop breathe between CPU slices — detection runs in the main
 *  process, and blocking it is indistinguishable from a crash (learned live). */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Awaited at every yield point of the CPU-heavy passes. Lets the detector
 * suspend mid-episode (a single episode can take minutes — pausing only
 * between episodes would feel broken).
 */
export type Gate = () => Promise<void>;

/** Iterative radix-2 FFT with precomputed twiddles/bit-reversal.
 *  The per-bin Goertzel this replaced cost ~19 billion ops per 10-min clip
 *  and froze the whole app; the FFT computes the same DFT bins ~30× cheaper. */
class Fft {
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;

  constructor(readonly n: number) {
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place transform of (re, im). */
  transform(re: Float32Array, im: Float32Array) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
          const tim = im[j + half] * cos[k] - re[j + half] * sin[k];
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

const fft = new Fft(FRAME);

/** Haitsma–Kalker style fingerprint: one 15-bit word per hop.
 *  Async: yields to the event loop every few dozen frames. */
export async function fingerprint(pcm: Int16Array, gate?: Gate): Promise<Int32Array> {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP));
  const fp = new Int32Array(frames);
  // Log-spaced band edges 250–2200 Hz mapped to DFT bin indices.
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) {
    const f = 250 * Math.pow(2200 / 250, b / BANDS);
    edges.push(Math.round((f * FRAME) / SAMPLE_RATE));
  }
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

  let prev = new Float32Array(BANDS);
  const cur = new Float32Array(BANDS);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[base + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    cur.fill(0);
    for (let b = 0; b < BANDS; b++) {
      for (let k = edges[b]; k < edges[b + 1]; k++) cur[b] += re[k] * re[k] + im[k] * im[k];
    }
    let word = 0;
    for (let b = 0; b < BANDS - 1; b++) {
      const d = cur[b] - cur[b + 1] - (prev[b] - prev[b + 1]);
      if (d > 0) word |= 1 << b;
    }
    fp[f] = word;
    prev = Float32Array.from(cur);
    if (f % 64 === 63) {
      await breathe();
      if (gate) await gate();
    }
  }
  return fp;
}

function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

export interface MatchRun {
  startSec: number; // in the "probe" clip's timeline
  endSec: number;
  lagSec: number;
  frames: number;
}

/**
 * Sliding-lag comparison: for every alignment of probe vs reference, find the
 * longest run of frames whose Hamming distance stays low (small gaps allowed).
 * Returns the best run in the probe's timeline.
 */
export async function bestMatchRun(ref: Int32Array, probe: Int32Array, gate?: Gate): Promise<MatchRun | null> {
  const minFrames = Math.round(MIN_RUN_SEC / HOP_SEC);
  let best: MatchRun | null = null;
  let sinceYield = 0;
  for (let lag = -(ref.length - minFrames); lag < probe.length - minFrames; lag++) {
    if (++sinceYield >= 512) {
      sinceYield = 0;
      await breathe();
      if (gate) await gate();
    }
    let runStart = -1;
    let misses = 0;
    const from = Math.max(0, lag);
    const to = Math.min(probe.length, ref.length + lag);
    for (let i = from; i <= to; i++) {
      const matching =
        i < to && popcount(probe[i] ^ ref[i - lag]) <= MAX_HAMMING;
      if (matching) {
        if (runStart < 0) runStart = i;
        misses = 0;
      } else if (runStart >= 0 && ++misses > 8) {
        const len = i - misses - runStart + 1;
        if (len >= minFrames && (!best || len > best.frames)) {
          best = { startSec: runStart * HOP_SEC, endSec: (runStart + len) * HOP_SEC, lagSec: lag * HOP_SEC, frames: len };
        }
        runStart = -1;
        misses = 0;
      }
    }
    if (runStart >= 0) {
      const len = to - runStart;
      if (len >= minFrames && (!best || len > best.frames)) {
        best = { startSec: runStart * HOP_SEC, endSec: (runStart + len) * HOP_SEC, lagSec: lag * HOP_SEC, frames: len };
      }
    }
  }
  return best;
}

export interface DetectStatus {
  active: boolean;
  paused: boolean;
  showId: number | null;
  showTitle: string | null;
  /** Episode currently being analyzed. */
  season: number | null;
  episode: number | null;
  done: number;
  total: number;
  /** Shows still waiting behind this one. */
  queued: number;
}

/** Background per-show detection queue — one comparison at a time. */
export class MarkerDetector extends EventEmitter {
  private queue: number[] = []; // show ids
  private running = false;
  private paused = false;
  private waiters: (() => void)[] = [];
  private cur: {
    showId: number;
    showTitle: string;
    done: number;
    total: number;
    season: number | null;
    episode: number | null;
  } | null = null;

  constructor(private db: DB) {
    super();
  }

  /** Passed into the CPU passes so a pause takes effect mid-episode. */
  private gate: Gate = async () => {
    while (this.paused) await new Promise<void>((resolve) => this.waiters.push(resolve));
  };

  getStatus(): DetectStatus {
    return {
      active: this.running,
      paused: this.paused,
      showId: this.cur?.showId ?? null,
      showTitle: this.cur?.showTitle ?? null,
      season: this.cur?.season ?? null,
      episode: this.cur?.episode ?? null,
      done: this.cur?.done ?? 0,
      total: this.cur?.total ?? 0,
      queued: this.queue.length,
    };
  }

  /** Broadcast the whole status; `phase` keeps the per-show listeners working. */
  private emit2(phase?: string, extra: Record<string, unknown> = {}) {
    events.broadcast("detect", { ...this.getStatus(), phase, ...extra });
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) for (const resume of this.waiters.splice(0)) resume();
    console.log(`marker detection ${paused ? "paused" : "resumed"}`);
    this.emit2();
  }

  /** Enqueue every show in a library that has undetected episodes + >=2 files. */
  enqueueLibrary(libraryId: number) {
    const shows = this.db
      .prepare(
        `SELECT DISTINCT mi.id FROM media_items mi
         JOIN episodes e ON e.show_id = mi.id
         JOIN files f ON f.episode_id = e.id AND f.missing = 0
         WHERE mi.library_id = ? AND mi.type = 'show'
         GROUP BY mi.id
         HAVING count(DISTINCT e.id) >= 2 AND sum(e.markers_done = 0) > 0`
      )
      .all(libraryId) as { id: number }[];
    for (const s of shows) this.enqueueShow(s.id, false);
  }

  enqueueShow(showId: number, force: boolean) {
    if (force) {
      this.db.prepare("UPDATE episodes SET markers_done = 0 WHERE show_id = ?").run(showId);
    }
    if (!this.queue.includes(showId)) this.queue.push(showId);
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    this.emit2();
    try {
      while (this.queue.length > 0) {
        const showId = this.queue.shift()!;
        await this.detectShow(showId).catch((e) => console.error(`marker detection for show ${showId} failed:`, e));
      }
    } finally {
      this.running = false;
      this.cur = null;
      this.emit2("idle");
    }
  }

  private episodesWithFiles(showId: number) {
    return this.db
      .prepare(
        `SELECT e.id, e.season, e.episode, e.markers_done, f.path FROM episodes e
         JOIN files f ON f.episode_id = e.id AND f.missing = 0
         WHERE e.show_id = ? GROUP BY e.id ORDER BY e.season, e.episode`
      )
      .all(showId) as { id: number; season: number; episode: number; markers_done: number; path: string }[];
  }

  private async detectShow(showId: number) {
    const eps = this.episodesWithFiles(showId);
    if (eps.length < 2) return;
    const pending = eps.filter((e) => !e.markers_done);
    if (pending.length === 0) return;

    const title =
      (this.db.prepare("SELECT title FROM media_items WHERE id = ?").get(showId) as { title: string } | undefined)
        ?.title ?? `Show ${showId}`;
    this.cur = { showId, showTitle: title, done: 0, total: pending.length, season: null, episode: null };
    this.emit2("start", { episodes: pending.length });
    console.log(`marker detection: show ${showId} "${title}", ${pending.length} episode(s)`);
    await this.gate(); // honour a pause requested before this show started

    // Multiple reference episodes, not one. A single reference is fragile:
    // if its own intro sits at an odd offset, or an OP version differs, every
    // episode that doesn't line up with it gets no markers (the "works on some
    // episodes, not others" problem). Comparing each episode against a couple
    // of references and keeping the best match covers far more of a show.
    // References are regular episodes (season >= 1) spread across the run;
    // specials/recaps (season 0) share no intro and are never used.
    const regulars = eps.filter((e) => e.season >= 1);
    const pool = regulars.length >= 2 ? regulars : eps;
    const refPick =
      pool.length <= 2 ? pool : [pool[0], pool[Math.floor(pool.length / 2)]];

    interface RefFp { id: number; head: Int32Array; tail: Int32Array; tailOffset: number }
    const refs: RefFp[] = [];
    for (const r of refPick) {
      try {
        const head = await extractPcm(r.path, false);
        const tail = await extractPcm(r.path, true);
        refs.push({
          id: r.id,
          head: await fingerprint(head.pcm, this.gate),
          tail: await fingerprint(tail.pcm, this.gate),
          tailOffset: tail.offsetSec,
        });
      } catch (e) {
        console.error(`marker detection: reference extract failed (${r.path}):`, e);
      }
    }
    if (refs.length === 0) {
      this.emit2("done");
      return;
    }

    for (const ep of pending) {
      try {
        await this.gate();
        if (this.cur) {
          this.cur.season = ep.season;
          this.cur.episode = ep.episode;
        }
        this.emit2("progress");

        const head = await extractPcm(ep.path, false);
        const tail = await extractPcm(ep.path, true);
        const headFp = await fingerprint(head.pcm, this.gate);
        const tailFp = await fingerprint(tail.pcm, this.gate);

        // Match against every reference except this episode itself, keeping the
        // longest run for intro and credits independently.
        let introRun: MatchRun | null = null;
        let creditsRun: MatchRun | null = null;
        for (const ref of refs) {
          if (ref.id === ep.id) continue;
          const i = await bestMatchRun(ref.head, headFp, this.gate);
          if (i && (!introRun || i.frames > introRun.frames)) introRun = i;
          const c = await bestMatchRun(ref.tail, tailFp, this.gate);
          if (c && (!creditsRun || c.frames > creditsRun.frames)) creditsRun = c;
        }

        let introStart: number | null = null;
        let introEnd: number | null = null;
        if (introRun && introRun.endSec - introRun.startSec <= MAX_INTRO_RUN_SEC) {
          introStart = Math.max(0, Math.round(introRun.startSec));
          introEnd = Math.round(introRun.endSec);
        }
        const creditsStart = creditsRun ? Math.round(tail.offsetSec + creditsRun.startSec) : null;

        this.db
          .prepare("UPDATE episodes SET intro_start=?, intro_end=?, credits_start=?, markers_done=1 WHERE id=?")
          .run(introStart, introEnd, creditsStart, ep.id);
        if (this.cur) this.cur.done++;
        this.emit2("episode", { episodeId: ep.id, introStart, introEnd, creditsStart });
        console.log(
          `markers S${ep.season}E${ep.episode}: intro=${introStart ?? "-"}..${introEnd ?? "-"} credits=${creditsStart ?? "-"}`
        );
      } catch (e) {
        console.error(`marker detection failed for episode ${ep.id}:`, e);
        this.db.prepare("UPDATE episodes SET markers_done=1 WHERE id=?").run(ep.id);
        if (this.cur) this.cur.done++;
      }
    }
    this.emit2("done");
    events.broadcast("item-changed", { itemId: showId });
  }
}
