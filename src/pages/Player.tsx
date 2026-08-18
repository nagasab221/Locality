import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { get, post, put, fmtTime, imgUrl, subscribe, lp, sourceBase, sourceToken, isRemoteActive } from "../api";
import type { Progress, Subtitle } from "../types";
import { btnGhost, btnPrimary, Modal, PlayIcon, selectCls } from "../components/ui";
import { usePartySync, type PartyMember } from "../partySync";

interface AudioStreamInfo {
  index: number;
  lang: string | null;
  codec: string;
  layout: string | null;
  isDefault: boolean;
  playable: boolean;
}

interface PrepareData {
  file: { id: number; filename: string; size: number; path: string };
  progress: Progress | null;
  subtitles: Subtitle[];
  title: string;
  streamUrl: string;
  mime: string;
  markers: { introStart: number | null; introEnd: number | null; creditsStart: number | null } | null;
  next: { fileId: number; season: number; episode: number; title: string; still: string | null } | null;
  itemId: number | null;
  playback: {
    autoplayNext: boolean;
    upNextSeconds: number;
    skipIntro: boolean;
    defaultSubLang: string;
    prefAudioLang: string | null;
    prefSubLang: string | null;
    /** "mpv" routes local playback through the embedded mpv engine. */
    engine?: "builtin" | "mpv";
  };
  /** Server-probed audio tracks; compose mode picks between them via ffmpeg. */
  audio: AudioStreamInfo[];
  durationSec: number | null;
  composeRequired: boolean;
  /** Video codec Chromium can't decode at all -> transcode from the start. */
  videoTranscodeRequired: boolean;
  defaultAudioIndex: number;
}

/**
 * Skip-intro + Up Next overlays, shared by both player modes.
 * - Skip intro: when the playhead crosses intro_start a "Skipping intro"
 *   button shows for exactly 3s; if NOT clicked we jump to intro_end; clicking
 *   it cancels the skip (intentionally inverted).
 * - Up Next: appears at credits_start (or the last ~18s as fallback); counts
 *   down and auto-plays the next episode unless dismissed.
 */
function MarkerLayer({
  prep,
  position,
  duration,
  onSeek,
  onNext,
}: {
  prep: PrepareData;
  position: number;
  duration: number;
  onSeek: (s: number) => void;
  onNext: () => void;
}) {
  const m = prep.markers;
  const pb = prep.playback;
  const [skipPhase, setSkipPhase] = useState<"idle" | "offered" | "done" | "cancelled">("idle");
  const skipDeadline = useRef(0);
  const [skipLeft, setSkipLeft] = useState(3);
  const [upPhase, setUpPhase] = useState<"idle" | "shown" | "cancelled">("idle");
  const [upLeft, setUpLeft] = useState(0);

  // --- skip intro -------------------------------------------------------------
  useEffect(() => {
    if (!pb?.skipIntro || !m || m.introStart == null || m.introEnd == null) return;
    if (skipPhase === "idle" && position >= m.introStart && position < m.introEnd - 2) {
      skipDeadline.current = Date.now() + 3000;
      setSkipLeft(3);
      setSkipPhase("offered");
    }
  }, [position, skipPhase, m, pb]);

  useEffect(() => {
    if (skipPhase !== "offered") return;
    const t = window.setInterval(() => {
      const left = skipDeadline.current - Date.now();
      setSkipLeft(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0) {
        window.clearInterval(t);
        setSkipPhase("done");
        if (m?.introEnd != null) onSeek(m.introEnd);
      }
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipPhase]);

  // --- up next ------------------------------------------------------------------
  const trigger = m?.creditsStart ?? (duration > 40 ? duration - 18 : Infinity);
  useEffect(() => {
    if (!prep.next || !pb?.autoplayNext) return;
    if (upPhase === "idle" && position > 0 && position >= trigger) {
      setUpLeft(Math.max(3, pb.upNextSeconds));
      setUpPhase("shown");
    }
  }, [position, upPhase, trigger, prep.next, pb]);

  useEffect(() => {
    if (upPhase !== "shown") return;
    const t = window.setInterval(() => {
      setUpLeft((s) => {
        if (s <= 1) {
          window.clearInterval(t);
          onNext();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upPhase]);

  const total = Math.max(3, pb?.upNextSeconds ?? 10);
  const ring = 2 * Math.PI * 16;

  return (
    <>
      {skipPhase === "offered" && (
        <button
          onClick={() => setSkipPhase("cancelled")}
          className="toast-in fixed bottom-28 right-6 z-40 px-4 py-2.5 rounded-lg bg-raised/95 border border-accent text-sm text-heading shadow-xl hover:bg-hov"
          title="Click to keep watching the intro"
        >
          Skipping intro in {skipLeft}… <span className="text-muted">(click to watch it)</span>
        </button>
      )}

      {upPhase === "shown" && prep.next && (
        <div className="toast-in fixed bottom-24 right-6 z-40 w-80 rounded-xl bg-raised/95 border border-cardborder shadow-2xl overflow-hidden">
          <div className="relative aspect-video bg-surface">
            {prep.next.still && <img src={imgUrl(prep.next.still) ?? undefined} alt="" className="w-full h-full object-cover" />}
            <button
              className="absolute top-2 right-2 w-7 h-7 rounded-full bg-bg/80 text-body hover:text-heading flex items-center justify-center"
              onClick={() => setUpPhase("cancelled")}
              title="Cancel autoplay"
            >
              ×
            </button>
          </div>
          <div className="p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-widest text-muted mb-0.5">Up next</div>
              <div className="text-sm text-heading truncate">
                S{String(prep.next.season).padStart(2, "0")}E{String(prep.next.episode).padStart(2, "0")} · {prep.next.title}
              </div>
            </div>
            <div className="relative w-10 h-10 shrink-0" title={`Auto-playing in ${upLeft}s`}>
              <svg viewBox="0 0 40 40" className="w-10 h-10 -rotate-90">
                <circle cx="20" cy="20" r="16" fill="none" className="stroke-track" strokeWidth="3" />
                <circle
                  cx="20" cy="20" r="16" fill="none" className="stroke-accent" strokeWidth="3"
                  strokeDasharray={ring} strokeDashoffset={ring * (1 - upLeft / total)} strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s linear" }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xs text-body">{upLeft}</span>
            </div>
            <button className={btnPrimary + " !px-3 !py-1.5"} onClick={onNext}>
              <PlayIcon className="w-3.5 h-3.5" /> Now
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Shown while the subtitle list is being resolved, just before playback. Stays
 * plain black for a moment first, so the common (already-extracted) case doesn't
 * flash a message on screen.
 */
/** Watch-party badge that reveals, on hover, who is here and who has the player open. */
function PartyPresenceBadge({ members }: { members: PartyMember[] }) {
  const joined = members.filter((m) => m.status === "joined");
  const invited = members.filter((m) => m.status === "invited");
  const watching = joined.filter((m) => m.watching).length;
  return (
    <div className="relative group">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-accent border border-accent/40 rounded-full px-2 py-0.5 cursor-default">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        Watch party
        <span className="normal-case tracking-normal text-muted">{watching}/{joined.length} in player</span>
      </span>
      <div className="absolute left-0 top-full mt-2 hidden group-hover:block z-50 w-60 rounded-lg bg-raised border border-cardborder p-2 shadow-2xl">
        <div className="text-[10px] uppercase tracking-wider text-muted px-1.5 pb-1">Party ({joined.length})</div>
        {joined.map((m) => (
          <div key={m.userId} className="flex items-center gap-2 px-1.5 py-1 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.watching ? "bg-accent" : "bg-muted"}`} />
            <span className="text-body truncate">{m.username}</span>
            {m.isHost && <span className="text-[9px] uppercase tracking-wider text-muted">host</span>}
            <span className="ml-auto text-[10px] text-muted shrink-0">{m.watching ? "in player" : "in app"}</span>
          </div>
        ))}
        {invited.length > 0 && (
          <>
            <div className="my-1 border-t border-cardborder" />
            {invited.map((m) => (
              <div key={m.userId} className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-muted shrink-0" />
                <span className="truncate">{m.username}</span>
                <span className="ml-auto text-[10px]">invited</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PlayerLoading({ label = "Loading…" }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 150);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="h-full bg-black flex items-center justify-center">
      {show && (
        <div className="flex items-center gap-2.5 text-muted modal-in">
          <span className="w-4 h-4 rounded-full border-2 border-inborder border-t-accent animate-spin" />
          <span className="text-sm">{label}</span>
        </div>
      )}
    </div>
  );
}

function ScrubberTooltip({
  hover,
  thumbAt,
  thumbUrl,
  containerWidth,
}: {
  hover: { x: number; t: number };
  thumbAt: number | null;
  thumbUrl: (t: number) => string;
  containerWidth: number;
}) {
  const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);
  const targetUrl = thumbAt !== null ? thumbUrl(thumbAt) : null;

  useEffect(() => {
    if (!targetUrl) return;
    let active = true;
    const img = new Image();
    img.src = targetUrl;
    img.onload = () => {
      if (active) setDisplayedUrl(targetUrl);
    };
    return () => {
      active = false;
    };
  }, [targetUrl]);

  const clampedX = containerWidth > 0 ? Math.max(84, Math.min(hover.x, containerWidth - 84)) : hover.x;

  return (
    <div
      className="absolute bottom-full mb-3 -translate-x-1/2 flex flex-col items-center pointer-events-none z-30"
      style={{ left: clampedX }}
    >
      <div className="w-40 h-[90px] rounded-lg border border-white/15 shadow-2xl bg-black/90 overflow-hidden relative backdrop-blur-md">
        {displayedUrl ? (
          <img
            src={displayedUrl}
            alt=""
            draggable={false}
            className="w-full h-full object-cover transition-opacity duration-150"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-zinc-900/80">
            <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-accent animate-spin" />
          </div>
        )}
      </div>
      <span className="mt-1.5 text-[11px] font-mono font-medium text-white bg-black/80 backdrop-blur-sm border border-white/10 px-2 py-0.5 rounded shadow-lg">
        {fmtTime(hover.t)}
      </span>
    </div>
  );
}

export default function Player() {
  const { fileId } = useParams();
  const navigate = useNavigate();
  const [prep, setPrep] = useState<PrepareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ask-resume" | "waiting-subs" | "playing">("loading");
  const [startAt, setStartAt] = useState(0);
  const [subsLoaded, setSubsLoaded] = useState(false);
  // Held separately from `prep` and merged at render, because this fetch can
  // resolve before prepare does — writing into prep here would drop the list.
  const [subsList, setSubsList] = useState<Subtitle[] | null>(null);
  // Stable fullscreen container: it lives on the Player (which stays mounted
  // across episodes) rather than the per-episode Html5Player (which remounts),
  // so auto-advancing to the next episode doesn't drop out of fullscreen.
  const fsRef = useRef<HTMLDivElement>(null);
  // Leaving the player entirely (not just switching episodes) exits fullscreen
  // and stops mpv. Episode changes keep this Player mounted, so mpv stays alive
  // and is simply told to load the next file.
  useEffect(
    () => () => {
      void (document.fullscreenElement && document.exitFullscreen().catch(() => {}));
      void window.locality.mpv.stop();
    },
    []
  );

  useEffect(() => {
    get<PrepareData>(`/player/prepare/${fileId}`)
      .then((p) => {
        setPrep(p);
        const resumable = p.progress && !p.progress.watched && p.progress.position_seconds > 30;
        if (resumable) setPhase("ask-resume");
        else start(false, p);
      })
      .catch((e) => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Resolve the full subtitle list BEFORE playback starts, so the track menu is
  // complete the moment the video appears. Embedded tracks need a one-off ffmpeg
  // pass per file, and a movie has no next-episode prefetch to lean on. Runs in
  // parallel with prepare (and with the resume prompt), so it's usually already
  // done by the time playback would begin.
  useEffect(() => {
    if (!fileId) return;
    setSubsList(null);
    setSubsLoaded(false);
    let settled = false;
    const finish = (list?: Subtitle[]) => {
      if (settled) return;
      settled = true;
      if (list) setSubsList(list);
      setSubsLoaded(true);
    };
    get<{ local: Subtitle[] }>(`/files/${fileId}/subtitles?wait=1`)
      .then((r) => finish(r.local))
      .catch(() => finish());
    // Safety valve: never hold playback hostage — start anyway and let in-player refresh fill the menu.
    const bail = window.setTimeout(() => finish(), 5000);
    return () => {
      settled = true;
      window.clearTimeout(bail);
    };
  }, [fileId]);

  useEffect(() => {
    if (phase === "waiting-subs" && subsLoaded) setPhase("playing");
  }, [phase, subsLoaded]);

  const start = (resume: boolean, p?: PrepareData) => {
    const data = p ?? prep;
    if (!data) return;
    const startPos = resume && data.progress && !data.progress.watched ? data.progress.position_seconds : 0;
    setStartAt(startPos);
    // Held here until the subtitle list resolves (usually already done).
    setPhase("waiting-subs");
  };

  if (error)
    return (
      <div className="p-8 space-y-4">
        <p className="text-danger">{error}</p>
        <button className={btnGhost} onClick={() => navigate(-1)}>
          ← Back
        </button>
      </div>
    );
  if (!prep || phase === "loading") return <PlayerLoading label="Loading…" />;
  if (phase === "waiting-subs") return <PlayerLoading label="Loading subtitles…" />;

  if (phase === "ask-resume") {
    return (
      <Modal onClose={() => navigate(-1)}>
        <div className="p-6 text-center space-y-4">
          <h3 className="font-display text-xl text-heading">{prep.title}</h3>
          <p className="text-sm text-muted">
            You stopped at <span className="text-hint">{fmtTime(prep.progress!.position_seconds)}</span>.
          </p>
          <div className="flex gap-3 justify-center">
            <button className={btnPrimary} onClick={() => start(true)}>
              <PlayIcon /> Resume from {fmtTime(prep.progress!.position_seconds)}
            </button>
            <button className={btnGhost} onClick={() => start(false)}>
              Start over
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const goNext = () => {
    if (prep.next) navigate(lp(`/play/${prep.next.fileId}`), { replace: true });
  };

  // Experimental mpv engine, local playback only (remote still streams to the
  // built-in <video>). mpv opens the file itself and renders into the window.
  const useMpv = prep.playback.engine === "mpv" && !isRemoteActive();

  // key= forces a clean remount (fresh overlay/skip state) when advancing
  // episodes; fsRef stays stable so fullscreen survives the remount.
  return (
    <div ref={fsRef} className="h-full bg-black">
      {useMpv ? (
        <MpvPlayerView key={prep.file.id} prep={prep} startAt={startAt} onExit={() => navigate(-1)} onNext={goNext} />
      ) : (
        <Html5Player
          key={prep.file.id}
          prep={subsList ? { ...prep, subtitles: subsList } : prep}
          startAt={startAt}
          fsRef={fsRef}
          onExit={() => navigate(-1)}
          onNext={goNext}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ mpv player
/**
 * Experimental: hand playback to the embedded mpv process (main-process側). mpv
 * renders into the window and shows its own on-screen controls; the React UI is
 * covered while it plays, so exit is via mpv (press q or Esc). This is the
 * first real integration — a transparent controls overlay comes later.
 */
function MpvPlayerView({
  prep,
  startAt,
  onExit,
  onNext,
}: {
  prep: PrepareData;
  startAt: number;
  onExit: () => void;
  onNext: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const posRef = useRef(0);
  const durRef = useRef(prep.durationSec ?? 0);

  useEffect(() => {
    const fileId = prep.file.id;
    let disposed = false;
    const save = () => {
      if (posRef.current > 0) {
        post("/player/progress", { fileId, position: posRef.current, duration: durRef.current }).catch(() => {});
      }
    };
    const unsub = window.locality.mpv.onEvent((d) => {
      if (disposed) return;
      if (d.type === "prop" && d.name === "time-pos" && typeof d.value === "number") posRef.current = d.value;
      else if (d.type === "prop" && d.name === "duration" && typeof d.value === "number") durRef.current = d.value;
      else if (d.type === "error") setErr(d.message ?? "mpv error");
      else if (d.type === "ended") {
        save();
        // Advance only when autoplay is on (the overlay's Up Next countdown is the
        // primary trigger; this is the fallback). Autoplay off with a next episode
        // stays on the end frame, where the Up Next card offers a manual advance.
        if (prep.next && prep.playback.autoplayNext) onNext();
        else if (!prep.next) onExit();
      } else if (d.type === "next") {
        // "Next" pressed on the overlay bar (a separate window).
        save();
        if (prep.next) onNext();
      } else if (d.type === "exit") {
        save();
        onExit();
      }
    });
    // Auto-pick the preferred audio/subtitle language (per-show override wins,
    // else the global default). "off" means the show's subs were turned off.
    const pb = prep.playback;
    const alang = pb.prefAudioLang || "";
    const slang = pb.prefSubLang === "off" ? "off" : pb.prefSubLang || pb.defaultSubLang || "";
    window.locality.mpv.start(fileId, startAt, prep.title, !!prep.next, alang, slang).then((res) => {
      if (!disposed && res?.error) setErr(res.error);
    });
    const timer = window.setInterval(save, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      save();
      unsub();
      // NOTE: deliberately do NOT stop mpv here. Advancing to the next episode
      // remounts this view (key change) but keeps the same Player; stopping would
      // kill mpv and its exit event would bounce the next episode back out. mpv is
      // stopped only when the whole Player unmounts (see the Player-level cleanup)
      // or when the user explicitly exits (Back/Esc -> mpv:stop).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prep.file.id]);

  // Keyboard control. mpv's own window never takes focus, so key events land on
  // the Electron window and we relay them to mpv over IPC. This is the stopgap
  // until the reskinned on-top control bar lands.
  useEffect(() => {
    const cmd = window.locality.mpv.command;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          cmd(["cycle", "pause"]);
          break;
        case "ArrowRight":
          e.preventDefault();
          cmd(["seek", e.shiftKey ? 60 : 10, "relative"]);
          break;
        case "ArrowLeft":
          e.preventDefault();
          cmd(["seek", e.shiftKey ? -60 : -10, "relative"]);
          break;
        case "ArrowUp":
          e.preventDefault();
          cmd(["add", "volume", 5]);
          break;
        case "ArrowDown":
          e.preventDefault();
          cmd(["add", "volume", -5]);
          break;
        case "m":
          cmd(["cycle", "mute"]);
          break;
        case "f":
          void window.locality.mpv.fullscreen();
          break;
        case "Escape":
        case "q":
          e.preventDefault();
          void window.locality.mpv.stop(); // -> exit event -> onExit
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (err) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
        <h2 className="font-display text-xl text-heading">mpv couldn't play this</h2>
        <p className="text-sm text-muted max-w-md break-words">{err}</p>
        <p className="text-xs text-muted">Turn off the mpv engine in Settings → Playback to use the built-in player.</p>
        <button className={btnGhost} onClick={onExit}>
          ← Back
        </button>
      </div>
    );
  }
  // mpv paints over this once it starts; shown only during the brief handoff.
  // The double-click handler catches clicks that fall through to the DOM (the
  // other path is mpv's own double-click binding) to toggle fullscreen.
  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center gap-3 text-center"
      onDoubleClick={() => void window.locality.mpv.fullscreen()}
    >
      <PlayerLoading label="Starting mpv…" />
      <p className="text-xs text-muted">Press q or Esc to exit</p>
    </div>
  );
}

// ---------------------------------------------------------------- HTML5 player

/** Vertical presets for the custom subtitle overlay (CSS offsets within the player). */
const SUB_POSITIONS = {
  bottom: { label: "Bottom", style: { bottom: "4%" } },
  raised: { label: "Raised", style: { bottom: "14%" } },
  high: { label: "High", style: { bottom: "28%" } },
  top: { label: "Top", style: { top: "6%" } },
} as const;
type SubPos = keyof typeof SUB_POSITIONS;

const SUB_POS_LS_KEY = "locality.subPos";

// Subtitle appearance — size multiplier, text colour, and how the text is set
// off from the picture. Each persists across sessions like the position preset.
const SUB_SIZES = { s: { label: "S", scale: 0.8 }, m: { label: "M", scale: 1 }, l: { label: "L", scale: 1.25 }, xl: { label: "XL", scale: 1.55 } } as const;
type SubSize = keyof typeof SUB_SIZES;
const SUB_COLORS = { white: "#FFFFFF", soft: "#E8E1D0", yellow: "#F5E050" } as const;
type SubColor = keyof typeof SUB_COLORS;
const SUB_BG = {
  shadow: { label: "Shadow", box: "transparent", shadow: "0 1px 3px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.8)" },
  box: { label: "Box", box: "rgba(0,0,0,.6)", shadow: "none" },
  none: { label: "None", box: "transparent", shadow: "none" },
} as const;
type SubBg = keyof typeof SUB_BG;

const readLS = <T extends string>(key: string, valid: Record<string, unknown>, fallback: T): T => {
  const v = localStorage.getItem(key);
  return v && v in valid ? (v as T) : fallback;
};


/** Serialize a cue's WebVTT payload to safe HTML (keeps <i>/<b> styling, no scripts). */
interface Cue {
  start: number;
  end: number;
  html: string;
}

/** Parse a WebVTT payload into cues we render ourselves (reliable even when the
 *  track is added mid-playback, which native <track> loading is not). */
function parseVtt(text: string): Cue[] {
  const tc = (s: string): number => {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s.trim());
    return m ? (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + +("0." + m[4]) : 0;
  };
  const out: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split("\n\n")) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
    if (!m) continue;
    const raw = lines.slice(i + 1).join("\n");
    const html = raw
      .replace(/<[^>]*>/g, "") // drop styling/karaoke tags; keep it safe + simple
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>");
    out.push({ start: tc(m[1]), end: tc(m[2]), html });
  }
  return out;
}

function Html5Player({ prep, startAt, fsRef, onExit, onNext }: { prep: PrepareData; startAt: number; fsRef: React.RefObject<HTMLDivElement>; onExit: () => void; onNext: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [pos, setPos] = useState(startAt);
  const [duration, setDuration] = useState(0);
  const [dragPos, setDragPos] = useState<number | null>(null);
  // Volume & speed survive between sessions (and across composed-stream reloads).
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem("locality.volume"));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
  });
  const [speed, setSpeed] = useState(() => {
    const s = Number(localStorage.getItem("locality.speed"));
    return [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(s) ? s : 1;
  });
  const lastVolRef = useRef(volume || 1);

  const applyVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolume(clamped);
    if (clamped > 0) lastVolRef.current = clamped;
    localStorage.setItem("locality.volume", String(clamped));
    if (videoRef.current) videoRef.current.volume = clamped;
  }, []);

  const applySpeed = useCallback((s: number) => {
    setSpeed(s);
    localStorage.setItem("locality.speed", String(s));
    if (videoRef.current) videoRef.current.playbackRate = s;
  }, []);

  const toggleMute = useCallback(() => {
    applyVolume(volume > 0 ? 0 : lastVolRef.current || 1);
  }, [volume, applyVolume]);

  // Night Mode (Audio Normalization + Dialogue Boost)
  const [nightMode, setNightMode] = useState(() => localStorage.getItem("locality.nightMode") === "true");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const compressorNodeRef = useRef<DynamicsCompressorNode | null>(null);
  const eqNodeRef = useRef<BiquadFilterNode | null>(null);

  const toggleNightMode = useCallback(() => {
    setNightMode((prev) => {
      const next = !prev;
      localStorage.setItem("locality.nightMode", String(next));
      return next;
    });
  }, []);

  // Build the Web Audio graph lazily the first time Night Mode is switched on.
  // A media element can only be routed through Web Audio ONCE, and once routed
  // it stays routed — so "off" means bypassing the filters (source -> speakers),
  // NOT suspending the context. Suspending stops all audio and plays the video
  // silent, which is the trap the first version fell into.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    try {
      if (!audioCtxRef.current) {
        if (!nightMode) return; // never enabled — element still plays natively
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx: AudioContext = new AudioContextClass();
        audioCtxRef.current = ctx;
        sourceNodeRef.current = ctx.createMediaElementSource(v);

        const eq = ctx.createBiquadFilter(); // dialogue boost: +3.5 dB @ 2.5 kHz
        eq.type = "peaking";
        eq.frequency.value = 2500;
        eq.Q.value = 1.0;
        eq.gain.value = 3.5;
        eqNodeRef.current = eq;

        const comp = ctx.createDynamicsCompressor(); // tame loud peaks
        comp.threshold.value = -24;
        comp.knee.value = 30;
        comp.ratio.value = 12;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        compressorNodeRef.current = comp;

        eq.connect(comp).connect(ctx.destination);
      }

      const ctx = audioCtxRef.current;
      const source = sourceNodeRef.current!;
      source.disconnect();
      source.connect(nightMode ? eqNodeRef.current! : ctx.destination);
      if (ctx.state === "suspended") void ctx.resume();
    } catch (e) {
      console.warn("Night Mode audio graph warning:", e);
    }
  }, [nightMode]);

  // Release the AudioContext when leaving the player; null the refs so a later
  // remount rebuilds the graph on a fresh context instead of a closed one.
  useEffect(
    () => () => {
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      sourceNodeRef.current = null;
    },
    []
  );
  const [subs, setSubs] = useState<Subtitle[]>(prep.subtitles);
  const [activeSub, setActiveSub] = useState<number | "off">("off");
  const [subsOpen, setSubsOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number>();
  const [failed, setFailed] = useState<string | null>(null);
  // Subtitle rendering is ours (tracks stay hidden): offset in seconds
  // (+ shows subs later, like VLC's delay), position preset persists.
  const [subOffset, setSubOffset] = useState(0);
  const [subPos, setSubPos] = useState<SubPos>(() => {
    const saved = localStorage.getItem(SUB_POS_LS_KEY);
    return saved && saved in SUB_POSITIONS ? (saved as SubPos) : "bottom";
  });
  const [subSize, setSubSize] = useState<SubSize>(() => readLS("locality.subSize", SUB_SIZES, "m"));
  const [subColor, setSubColor] = useState<SubColor>(() => readLS("locality.subColor", SUB_COLORS, "white"));
  const [subBg, setSubBg] = useState<SubBg>(() => readLS("locality.subBg", SUB_BG, "shadow"));
  const [subTuneOpen, setSubTuneOpen] = useState(false);
  const [cueHtml, setCueHtml] = useState("");
  // Parsed cues for the active subtitle (fetched from the server as WebVTT).
  const [cues, setCues] = useState<Cue[]>([]);

  // Seek preview: the server extracts the single frame we're hovering, on demand.
  // Nothing is processed up front, so this works the moment an episode opens.
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [barWidth, setBarWidth] = useState<number>(0);
  // The frame actually requested: snapped to 5s (matching the server's cache
  // buckets) and settled briefly, so sweeping the bar doesn't fire a request per
  // pixel. The time label still tracks the cursor instantly.
  const [thumbAt, setThumbAt] = useState<number | null>(null);
  const hoverT = hover?.t ?? null;
  useEffect(() => {
    if (hoverT === null) return;
    const bucket = Math.max(0, Math.floor(hoverT / 5) * 5);
    const id = window.setTimeout(() => setThumbAt(bucket), 90);
    return () => window.clearTimeout(id);
  }, [hoverT]);
  const thumbUrl = (t: number) => {
    const tok = sourceToken();
    const q = new URLSearchParams({ t: String(t) });
    if (tok) q.set("token", tok);
    return `${sourceBase()}/player/thumb/${prep.file.id}?${q.toString()}`;
  };

  // ---- composed-stream mode -------------------------------------------------
  // Chromium can't decode AC-3/E-AC-3/DTS audio and can't switch tracks in-place
  // reliably, so those cases stream through the server's ffmpeg (?audio=&start=).
  // Composed streams have no byte ranges: seeking reloads at ?start=S and the
  // real position is streamBase + video.currentTime everywhere below.
  // Remembered audio track for this show (matched by language); falls back to
  // the file's own default track. Picking a non-default track needs the ffmpeg
  // compose path, so it also decides the initial streaming mode.
  const initialAudioIdx = (() => {
    const want = (prep.playback.prefAudioLang || "").toLowerCase();
    if (want) {
      const m = prep.audio.find((a) => (a.lang || "").toLowerCase().startsWith(want));
      if (m) return m.index;
    }
    return prep.defaultAudioIndex;
  })();
  const startComposed = prep.composeRequired || initialAudioIdx !== prep.defaultAudioIndex;
  const [composed, setComposed] = useState<boolean>(startComposed);
  const [audioIdx, setAudioIdx] = useState<number>(initialAudioIdx);
  const [streamBase, setStreamBase] = useState<number>(startComposed ? startAt : 0);
  const streamBaseRef = useRef(startComposed ? startAt : 0);
  // Server-side video transcode (H.264). On from the start for codecs Chromium
  // can't decode; also switched on if a direct/HEVC play fails (no HW decoder).
  const [videoTranscode, setVideoTranscode] = useState<boolean>(prep.videoTranscodeRequired);
  /** Where the NEXT plain (range-based) load should seek to once metadata is in. */
  const resumeAtRef = useRef(startComposed ? 0 : startAt);

  /** Persist the remembered audio/subtitle language for this show/movie. */
  const savePref = useCallback(
    (body: { audioLang?: string | null; subLang?: string | null }) => {
      if (prep.itemId == null) return;
      put(`/player/prefs/${prep.itemId}`, body).catch(() => {});
    },
    [prep.itemId]
  );

  const setBase = (s: number) => {
    streamBaseRef.current = s;
    setStreamBase(s);
  };

  const totalDuration = prep.durationSec || duration;

  const streamSrc = (() => {
    // prep.streamUrl is "/api/stream/<id>"; route it to the active source
    // (local or the connected server) and carry the token for remote.
    const path = prep.streamUrl.replace(/^\/api/, "");
    const params = new URLSearchParams();
    if (composed) {
      params.set("audio", String(audioIdx));
      params.set("start", String(streamBase));
      if (videoTranscode) params.set("vt", "1");
    }
    const tok = sourceToken();
    if (tok) params.set("token", tok);
    const qs = params.toString();
    return sourceBase() + path + (qs ? `?${qs}` : "");
  })();

  /** Seek in the displayed (whole-file) timeline, whichever mode is active. */
  const seekTo = useCallback(
    (target: number) => {
      const v = videoRef.current;
      if (!v) return;
      const clamped = Math.max(0, totalDuration ? Math.min(target, totalDuration - 0.5) : target);
      if (composed) {
        const relTarget = clamped - streamBaseRef.current;
        // Seek in place ONLY when the element can actually seek there. The
        // composed stream is a live, range-less fragmented MP4, so its
        // `seekable` range is [0-0] even though `buffered` looks populated —
        // assigning currentTime then snaps to the stream start, which surfaced
        // as jumping to the resume point (and every later seek snapping back to
        // it). `buffered` is not `seekable`; check the latter. When it can't
        // seek in place, reload the stream so it restarts exactly at the target.
        let canSeekInPlace = false;
        if (relTarget >= 0 && v.seekable) {
          for (let i = 0; i < v.seekable.length; i++) {
            if (relTarget >= v.seekable.start(i) && relTarget <= v.seekable.end(i)) {
              canSeekInPlace = true;
              break;
            }
          }
        }
        if (canSeekInPlace) {
          v.currentTime = relTarget;
          setPos(clamped);
        } else {
          setBase(clamped);
          setPos(clamped);
        }
      } else {
        v.currentTime = clamped;
      }
    },
    [composed, totalDuration]
  );

  // Assigned once usePartySync has run (it needs seekTo, declared above it).
  // A composed-stream seek RELOADS the element rather than moving currentTime,
  // so no "seeked" event fires — this is how those seeks still reach the party.
  const publishRef = useRef<() => void>(() => {});

  const commitSeek = useCallback(
    (target: number) => {
      seekTo(target);
      setDragPos(null);
      publishRef.current();
    },
    [seekTo]
  );

  const switchAudio = (n: number) => {
    const here = streamBaseRef.current + (videoRef.current?.currentTime ?? 0);
    setAudioIdx(n);
    savePref({ audioLang: prep.audio.find((a) => a.index === n)?.lang ?? null });
    if (n === prep.defaultAudioIndex && !prep.composeRequired) {
      // Back to the plain byte-range stream (native seeking again).
      resumeAtRef.current = here;
      setComposed(false);
      setBase(0);
    } else {
      setComposed(true);
      setBase(here);
    }
  };

  const report = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = prep.durationSec || (v.duration && isFinite(v.duration) ? v.duration : 0);
    if (!dur) return;
    post("/player/progress", { fileId: prep.file.id, position: streamBaseRef.current + v.currentTime, duration: dur }).catch(() => {});
  }, [prep.file.id, prep.durationSec]);

  useEffect(() => {
    const t = window.setInterval(report, 5000);
    return () => {
      window.clearInterval(t);
      report();
    };
  }, [report]);

  // Auto-enable a subtitle in the user's preferred language as soon as one is
  // available, so subs appear without the user hunting through the menu.
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (autoPickedRef.current || activeSub !== "off") return;
    // A remembered choice for this show wins over the global default language.
    const pref = prep.playback.prefSubLang;
    if (pref === "off") {
      autoPickedRef.current = true; // user turned subs off for this title
      return;
    }
    const want = (pref || prep.playback.defaultSubLang || "").toLowerCase();
    if (!want || subs.length === 0) return;
    const match = subs.find((s) => (s.lang || "").toLowerCase().startsWith(want));
    if (match) {
      autoPickedRef.current = true;
      setActiveSub(match.id);
    }
  }, [subs, activeSub, prep.playback.prefSubLang, prep.playback.defaultSubLang]);

  // Embedded subtitles extract server-side in the background on first play. The
  // "subs-updated" push can be missed (it may fire while the resume prompt is up,
  // before this component mounts), which used to leave an empty menu until the
  // episode was reopened. So we also re-poll for a while: whichever lands first
  // fills the menu, no reload needed.
  useEffect(() => {
    let cancelled = false;
    const apply = (r: { local: Subtitle[] }) => {
      if (!cancelled && r.local.length > 0) setSubs(r.local);
    };
    const refetch = () =>
      get<{ local: Subtitle[] }>(`/files/${prep.file.id}/subtitles`).then(apply).catch(() => {});

    refetch(); // catch extraction that finished before we mounted
    const timers = [1500, 3000, 6000, 10000, 15000, 22000, 30000].map((ms) =>
      window.setTimeout(refetch, ms)
    );
    const unsub = subscribe("subs-updated", (d: { fileId: number }) => {
      if (d.fileId === prep.file.id) refetch();
    });
    return () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
      unsub();
    };
  }, [prep.file.id]);

  // Fetch + parse the active subtitle ourselves. Doing this in JS (rather than a
  // native <track>) means a subtitle selected right after it's extracted shows
  // immediately, instead of needing the episode reopened.
  useEffect(() => {
    if (activeSub === "off") {
      setCues([]);
      return;
    }
    const tok = sourceToken();
    const url = `${sourceBase()}/subtitles/${activeSub}/vtt${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
    let cancelled = false;
    setCues([]);
    // The server extracts embedded tracks on demand, so the first request can
    // 404 briefly while ffmpeg runs. Check the status and retry instead of
    // treating a not-ready response as "no subtitles".
    void (async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            const txt = await r.text();
            if (!cancelled) setCues(parseVtt(txt));
            return;
          }
        } catch {
          /* transient — fall through to retry */
        }
        await new Promise((res) => setTimeout(res, 800));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSub]);

  // Cue picker: which cues are on screen at (currentTime − offset).
  useEffect(() => {
    if (activeSub === "off") {
      setCueHtml("");
      return;
    }
    let last = "";
    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      const t = streamBaseRef.current + v.currentTime - subOffset;
      const html = cues
        .filter((c) => c.start <= t && t < c.end)
        .map((c) => c.html)
        .join("<br/>");
      if (html !== last) {
        last = html;
        setCueHtml(html);
      }
    };
    tick();
    const timer = window.setInterval(tick, 150);
    return () => window.clearInterval(timer);
  }, [activeSub, subOffset, cues]);

  const nudgeSubs = useCallback((delta: number) => {
    setSubOffset((o) => Math.round((o + delta) * 10) / 10);
  }, []);

  const pickSubPos = (p: SubPos) => {
    setSubPos(p);
    localStorage.setItem(SUB_POS_LS_KEY, p);
  };
  const pickSubSize = (s: SubSize) => {
    setSubSize(s);
    localStorage.setItem("locality.subSize", s);
  };
  const pickSubColor = (c: SubColor) => {
    setSubColor(c);
    localStorage.setItem("locality.subColor", c);
  };
  const pickSubBg = (b: SubBg) => {
    setSubBg(b);
    localStorage.setItem("locality.subBg", b);
  };

  // Watch party. Only explicit actions are exchanged, so this hangs off the
  // element's play/pause/seeked events rather than the position tick.
  const { active: partyActive, publish: partyPublish, notice: partyNotice, party: partyInfo } = usePartySync({
    fileId: prep.file.id,
    position: () => streamBaseRef.current + (videoRef.current?.currentTime ?? 0),
    paused: () => videoRef.current?.paused ?? true,
    seek: (to) => seekTo(to),
    setPaused: (p) => {
      const v = videoRef.current;
      if (!v) return;
      if (p) v.pause();
      else void v.play();
    },
  });
  publishRef.current = partyPublish;

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void fsRef.current?.requestFullscreen().catch(() => {});
  }, [fsRef]);

  // Track fullscreen so the button flips its icon. Initialised from the document
  // because this component remounts per episode (key=file.id) — an auto-advance
  // mid-fullscreen mounts a fresh instance while the document is still full.
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") seekTo(streamBaseRef.current + v.currentTime + 10);
      else if (e.key === "ArrowLeft") seekTo(streamBaseRef.current + v.currentTime - 10);
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        applyVolume(v.volume + 0.05);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        applyVolume(v.volume - 0.05);
      } else if (e.key === "m") toggleMute();
      else if (e.key === "g") nudgeSubs(-0.5); // VLC-style subtitle delay keys
      else if (e.key === "h") nudgeSubs(+0.5);
      else if (e.key === "Escape") {
        // In fullscreen, Esc just leaves fullscreen (browser handles it) —
        // only exit the player when already windowed.
        if (!document.fullscreenElement) onExit();
      } else if (e.key === "f") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, toggleFullscreen, onExit, nudgeSubs, seekTo, applyVolume, toggleMute]);

  const poke = () => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 3000);
  };

  const shownPos = dragPos ?? pos;
  const controlsHidden = idle && !paused;

  return (
    <div
      ref={wrapRef}
      className={`h-full bg-black relative select-none ${controlsHidden ? "cursor-none" : ""}`}
      onMouseMove={poke}
      onClick={poke}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        src={streamSrc}
        autoPlay
        preload="auto"
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.duration && isFinite(v.duration)) setDuration(v.duration);
          if (!composed && resumeAtRef.current > 0) v.currentTime = resumeAtRef.current;
          resumeAtRef.current = 0;
          // Every (re)load resets these on the element — reapply the saved values.
          v.volume = volume;
          v.playbackRate = speed;
        }}
        onTimeUpdate={(e) => setPos(streamBaseRef.current + e.currentTarget.currentTime)}
        onPlay={() => {
          setPaused(false);
          partyPublish();
        }}
        onPause={() => {
          setPaused(true);
          report();
          partyPublish();
        }}
        onSeeked={partyPublish}
        onEnded={() => {
          report();
          // Episodes with a next episode stay on the end frame — the Up Next
          // overlay (unless dismissed) decides whether to advance.
          if (!prep.next) onExit();
        }}
        onError={() => {
          // First failure on a direct/copy play (usually HEVC with no hardware
          // decoder): retry through the server transcode, resuming where we were.
          if (!videoTranscode) {
            const here = streamBaseRef.current + (videoRef.current?.currentTime ?? 0);
            setVideoTranscode(true);
            setComposed(true);
            setBase(here > 1 ? here : startAt);
          } else {
            setFailed("This file couldn't be played.");
          }
        }}
        onDoubleClick={toggleFullscreen}
      />
      {/* subtitles are fetched + rendered by us (see the cue picker), not native <track> */}

      {/* custom subtitle overlay — replaces native cue rendering */}
      {cueHtml && activeSub !== "off" && (
        <div
          className="absolute inset-x-0 flex justify-center pointer-events-none z-10"
          style={SUB_POSITIONS[subPos].style}
        >
          <div
            className="max-w-[85%] text-center px-3 py-1 rounded"
            style={{
              fontSize: `calc(clamp(16px, 2.8vh, 30px) * ${SUB_SIZES[subSize].scale})`,
              lineHeight: 1.35,
              color: SUB_COLORS[subColor],
              background: SUB_BG[subBg].box,
              textShadow: SUB_BG[subBg].shadow,
            }}
            dangerouslySetInnerHTML={{ __html: cueHtml }}
          />
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/90 p-8">
          <div className="max-w-md text-center space-y-4">
            <p className="text-danger text-sm leading-relaxed">{failed}</p>
            <button className={btnGhost} onClick={onExit}>
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* top bar */}
      <div className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${controlsHidden ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
        <div className="flex items-center gap-4">
          <button className="text-body hover:text-heading text-sm" onClick={onExit}>
            ← Back
          </button>
          <span className="font-display text-heading">{prep.title}</span>
          {partyActive && partyInfo && <PartyPresenceBadge members={partyInfo.members} />}
        </div>
      </div>

      {/* Watch-party action toast: "John has paused / seeked to 1:30:21". Top-right,
          shown regardless of whether the controls are hidden. */}
      {partyNotice && (
        <div className="absolute top-4 right-5 z-50 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-black/80 border border-white/15 px-3.5 py-1.5 text-sm text-white shadow-xl backdrop-blur-md">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            {partyNotice}
          </div>
        </div>
      )}

      {/* control bar */}
      <div
        className={`absolute bottom-0 inset-x-0 px-5 pb-4 pt-10 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
          controlsHidden ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <div
          className="relative cursor-pointer"
          onMouseMove={(e) => {
            if (totalDuration <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setBarWidth(rect.width);
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            setHover({ x: e.clientX - rect.left, t: frac * totalDuration });
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (totalDuration <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setBarWidth(rect.width);
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            commitSeek(frac * totalDuration);
          }}
        >
          {hover && (
            <ScrubberTooltip
              hover={hover}
              thumbAt={thumbAt}
              thumbUrl={thumbUrl}
              containerWidth={barWidth}
            />
          )}
          <input
            type="range"
            className="w-full cursor-pointer"
            min={0}
            max={Math.max(1, totalDuration)}
            step={0.5}
            value={shownPos}
            onChange={(e) => setDragPos(+e.target.value)}
            onPointerUp={(e) => commitSeek(+e.currentTarget.value)}
            onMouseUp={(e) => commitSeek(+e.currentTarget.value)}
            onKeyUp={(e) => commitSeek(+e.currentTarget.value)}
          />
        </div>
        <div className="flex items-center gap-4 mt-2 text-sm">
          <button className="text-heading" onClick={togglePlay}>
            {paused ? <PlayIcon className="w-6 h-6" /> : <PauseIcon className="w-6 h-6" />}
          </button>
          <span className="text-xs text-muted tabular-nums">
            {fmtTime(shownPos)} / {fmtTime(totalDuration)}
          </span>
          {prep.next && (
            <button
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-inborder text-body hover:border-accent hover:text-accent transition-colors"
              title={`Next: S${String(prep.next.season).padStart(2, "0")}E${String(prep.next.episode).padStart(2, "0")} ${prep.next.title}`}
              onClick={onNext}
            >
              <SkipNextIcon className="w-3.5 h-3.5" /> Next
            </button>
          )}
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-muted text-xs" title="Volume">
            <VolumeIcon muted={volume === 0} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              className="w-24"
              aria-label="Volume"
              onChange={(e) => applyVolume(+e.target.value)}
            />
          </label>
          <button
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              nightMode
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "text-muted hover:text-heading hover:bg-raised"
            }`}
            onClick={toggleNightMode}
            title="Night Mode: Boosts dialogue clarity and normalizes volume to tame loud explosions"
          >
            🌙 {nightMode ? "Night Mode On" : "Night Mode"}
          </button>
          <PlayerSelect
            title="Playback speed"
            value={String(speed)}
            onChange={(v) => applySpeed(+v)}
            options={[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((x) => ({ value: String(x), label: `${x}×` }))}
          />
          {prep.audio.length > 1 && (
            <PlayerSelect
              title="Audio track"
              value={String(audioIdx)}
              onChange={(v) => switchAudio(+v)}
              className="max-w-36"
              options={prep.audio.map((a) => ({
                value: String(a.index),
                label: `Audio: ${a.lang ?? `Track ${a.index + 1}`} · ${a.codec}${a.layout ? ` ${a.layout}` : ""}`,
              }))}
            />
          )}
          <PlayerSelect
            title="Subtitles"
            className="max-w-40"
            value={String(activeSub)}
            onChange={(v) => {
              if (v === "__search") {
                setSubsOpen(true);
                return;
              }
              if (v === "off") {
                setActiveSub("off");
                savePref({ subLang: "off" });
              } else {
                setActiveSub(+v);
                savePref({ subLang: subs.find((s) => s.id === +v)?.lang ?? null });
              }
            }}
            options={[
              { value: "off", label: "Subs: off" },
              ...subs.map((s) => ({ value: String(s.id), label: s.label })),
              { value: "__search", label: "Search online…" },
            ]}
          />
          {activeSub !== "off" && (
            <div className="relative">
              <button
                className={`text-xs px-1.5 py-1 rounded border ${subTuneOpen || subOffset !== 0 ? "text-accent border-accent/60" : "text-muted border-inborder hover:text-body"}`}
                title="Subtitle timing & position"
                onClick={() => setSubTuneOpen((o) => !o)}
              >
                Subs ⚙
              </button>
              {subTuneOpen && (
                <div className="absolute bottom-9 right-0 w-64 rounded-lg border border-cardborder bg-raised p-3 shadow-xl space-y-3 z-20">
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Timing (g / h)</div>
                    <div className="flex items-center gap-2">
                      <button className={btnGhost + " !px-2 !py-0.5 text-xs"} onClick={() => nudgeSubs(-0.5)}>
                        −0.5s
                      </button>
                      <span className="flex-1 text-center tabular-nums text-body text-xs">
                        {subOffset > 0 ? "+" : ""}
                        {subOffset.toFixed(1)}s
                      </span>
                      <button className={btnGhost + " !px-2 !py-0.5 text-xs"} onClick={() => nudgeSubs(+0.5)}>
                        +0.5s
                      </button>
                      {subOffset !== 0 && (
                        <button className="text-muted hover:text-body text-xs" title="Reset timing" onClick={() => setSubOffset(0)}>
                          ✕
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-1">+ shows subtitles later, − earlier</p>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Position</div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(Object.keys(SUB_POSITIONS) as SubPos[]).map((p) => (
                        <button
                          key={p}
                          className={`text-[11px] px-1 py-1 rounded border ${
                            subPos === p ? "bg-accent text-accenttext border-accent" : "text-body border-inborder hover:bg-hov"
                          }`}
                          onClick={() => pickSubPos(p)}
                        >
                          {SUB_POSITIONS[p].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Size</div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(Object.keys(SUB_SIZES) as SubSize[]).map((s) => (
                        <button
                          key={s}
                          className={`text-[11px] px-1 py-1 rounded border ${
                            subSize === s ? "bg-accent text-accenttext border-accent" : "text-body border-inborder hover:bg-hov"
                          }`}
                          onClick={() => pickSubSize(s)}
                        >
                          {SUB_SIZES[s].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Colour</div>
                    <div className="flex gap-2">
                      {(Object.keys(SUB_COLORS) as SubColor[]).map((c) => (
                        <button
                          key={c}
                          className={`w-6 h-6 rounded-full border ${subColor === c ? "ring-2 ring-accent border-accent" : "border-inborder"}`}
                          style={{ background: SUB_COLORS[c] }}
                          onClick={() => pickSubColor(c)}
                          aria-label={`Subtitle colour ${c}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Background</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(Object.keys(SUB_BG) as SubBg[]).map((b) => (
                        <button
                          key={b}
                          className={`text-[11px] px-1 py-1 rounded border ${
                            subBg === b ? "bg-accent text-accenttext border-accent" : "text-body border-inborder hover:bg-hov"
                          }`}
                          onClick={() => pickSubBg(b)}
                        >
                          {SUB_BG[b].label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            className="text-muted hover:text-body"
            title={isFullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
            aria-label="Toggle fullscreen"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>

      {subsOpen && (
        <SubtitleSearch
          fileId={prep.file.id}
          onClose={() => setSubsOpen(false)}
          onDownloaded={(sub) => {
            setSubs((prev) => [...prev.filter((x) => x.id !== sub.id), sub]);
            setActiveSub(sub.id);
            setSubsOpen(false);
          }}
        />
      )}

      <MarkerLayer prep={prep} position={pos} duration={totalDuration} onSeek={seekTo} onNext={onNext} />
    </div>
  );
}

// ---------------------------------------------------------------- subtitle search dialog

function SubtitleSearch({ fileId, onClose, onDownloaded }: { fileId: number; onClose: () => void; onDownloaded: (sub: Subtitle) => void }) {
  const [lang, setLang] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(
    (language?: string) => {
      setBusy(true);
      setErr(null);
      get(`/files/${fileId}/os-search${language ? `?lang=${language}` : ""}`)
        .then(setResults)
        .catch((e) => setErr(String(e.message ?? e)))
        .finally(() => setBusy(false));
    },
    [fileId]
  );

  useEffect(() => search(), [search]);

  const download = (r: any) => {
    setBusy(true);
    post<Subtitle>(`/files/${fileId}/os-download`, { osFileId: r.osFileId, lang: r.language, label: r.release })
      .then(onDownloaded)
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-5">
        <h3 className="font-display text-xl text-heading mb-4">Search subtitles</h3>
        <div className="flex gap-2 mb-4">
          <input
            className={selectCls + " flex-1"}
            placeholder="Language code (empty = default)"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search(lang)}
          />
          <button className={btnPrimary} onClick={() => search(lang)} disabled={busy}>
            Search
          </button>
        </div>
        {err && <p className="text-danger text-sm mb-3">{err}</p>}
        {results === null ? (
          <p className="text-muted text-sm">Searching…</p>
        ) : results.length === 0 ? (
          <p className="text-muted text-sm">No results (an OpenSubtitles API key must be set in Settings).</p>
        ) : (
          <div className="space-y-1.5">
            {results.map((r) => (
              <button
                key={r.osFileId}
                disabled={busy}
                onClick={() => download(r)}
                className="w-full text-left px-3 py-2 rounded-md border border-cardborder hover:border-accent hover:bg-raised transition-colors flex items-center gap-3"
              >
                <span className="px-1.5 py-0.5 rounded bg-raised border border-inborder text-[10px] uppercase text-hint shrink-0">{r.language}</span>
                <span className="text-sm text-body truncate flex-1">{r.release}</span>
                <span className="text-[11px] text-muted shrink-0">{r.downloadCount}↓{r.hearingImpaired ? " · HI" : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function PauseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function VolumeIcon({ muted = false, className = "w-4 h-4" }: { muted?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="m15 9 5 6m0-6-5 6" />
      ) : (
        <>
          <path d="M14.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M17 6.8a7.5 7.5 0 0 1 0 10.4" />
        </>
      )}
    </svg>
  );
}

function FullscreenIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </svg>
  );
}

function ExitFullscreenIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
    </svg>
  );
}

function SkipNextIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5.5v13l9-6.5-9-6.5z" />
      <rect x="16.5" y="5" width="2.2" height="14" rx="1" />
    </svg>
  );
}

function ChevronIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Themed dropdown for the control bar (replaces native <select>, whose open
 * list is painted blue by the OS). Rendered INLINE (not portaled) so it still
 * shows when the player is in fullscreen. Opens upward since it sits at the
 * bottom of the screen.
 */
function PlayerSelect({
  value,
  options,
  onChange,
  title,
  className = "",
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-raised border text-xs transition-colors ${
          open ? "border-accent text-heading" : "border-inborder text-body hover:border-accent/60"
        } ${className}`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronIcon className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 min-w-full max-h-60 overflow-y-auto py-1 rounded-lg bg-raised border border-cardborder shadow-2xl z-30">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setOpen(false);
                onChange(o.value);
              }}
              className={`block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
                o.value === value ? "bg-accent text-accenttext font-medium" : "text-body hover:bg-hov hover:text-heading"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
