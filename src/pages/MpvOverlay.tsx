// Full-screen overlay for the mpv engine, styled after the built-in player. mpv
// paints over the page, so this runs in its own transparent, focusable, on-top
// window that covers the whole video (positioned by main.ts). Covering the video
// lets it (a) reveal/hide the controls from reliable DOM mouse events and (b)
// hide the OS cursor with `cursor: none` (it's focusable so Chromium honors that;
// mpv can't hide it itself when embedded). Controls are driven over the IPC
// bridge and mirror mpv's state from relayed property events; the subtitle/audio
// menus are themed React popovers fed by mpv's track-list.
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "../api";
import { PlayIcon } from "../components/ui";
import { usePartySync, type PartyMember } from "../partySync";

const params = new URLSearchParams(window.location.search);
const title = params.get("title") || "";
const hasNext = params.get("hasnext") === "1";
const fileId = params.get("file") || "";
const port = params.get("port") || "3777";
// Reuse the server's cached, bucketed thumbnail endpoint (same as the built-in
// player); mpv is local-only, so no token is needed.
const thumbUrl = (t: number) => `http://127.0.0.1:${port}/api/player/thumb/${fileId}?t=${Math.max(0, Math.floor(t / 5) * 5)}`;

// Subtitle styling presets → mpv properties. sub-scale is a font multiplier;
// sub-pos is 0 (top) … 100 (bottom). These persist as a user preference.
const SUB_SIZES: [string, number][] = [["S", 0.8], ["M", 1], ["L", 1.3], ["XL", 1.6]];
const SUB_POSITIONS: [string, number][] = [["Bottom", 100], ["Raised", 92], ["High", 80], ["Top", 5]];
const SUB_COLORS: [string, string][] = [["White", "#FFFFFF"], ["Yellow", "#FFEB3B"], ["Cyan", "#4DD0E1"], ["Green", "#7CFC00"]];
const SHORTCUTS: [string, string][] = [
  ["Space / K", "Play / pause"],
  ["← / →", "Seek 10s (Shift = 60s)"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["F / double-click", "Fullscreen"],
  ["Esc", "Exit fullscreen"],
  ["G / H", "Subtitle delay − / +"],
  ["Q", "Quit player"],
  ["?", "Show / hide this help"],
];
function lsNum(key: string, def: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}
// Night mode: dynamic loudness normalization — lifts quiet dialogue, tames loud
// peaks. mpv bridges this libavfilter filter automatically.
const NIGHT_MODE_AF = "dynaudnorm=g=5:f=250:r=0.9:p=0.5";

interface Track {
  id: number;
  type: string;
  lang?: string | null;
  title?: string | null;
  selected?: boolean;
}

interface Meta {
  showTitle: string;
  episodeTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  overview?: string | null;
  year?: number | null;
  runtime?: number | null;
  genres?: string[];
  voteRating?: number | null;
  contentRating?: string | null;
  introStart?: number | null;
  introEnd?: number | null;
  creditsStart?: number | null;
  next?: { title: string; season: number; episode: number } | null;
  autoplayNext?: boolean;
  upNextSeconds?: number;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

const IDLE_MS = 2800;

export default function MpvOverlay() {
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(false);
  const [vol, setVol] = useState(() => lsNum("locality.mpv.volume", 100));
  const [muted, setMuted] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<null | "sub" | "audio" | "speed">(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null); // scrubber preview
  const [barWidth, setBarWidth] = useState(0);
  const [thumbAt, setThumbAt] = useState<number | null>(null);
  const [subDelay, setSubDelay] = useState(0);
  const [subScale, setSubScale] = useState(() => lsNum("locality.mpv.subScale", 1));
  const [subPos, setSubPos] = useState(() => lsNum("locality.mpv.subPos", 100));
  const [subColor, setSubColor] = useState(() => localStorage.getItem("locality.mpv.subColor") || "#FFFFFF");
  const [subBg, setSubBg] = useState<"none" | "box">(() => (localStorage.getItem("locality.mpv.subBg") === "box" ? "box" : "none"));
  const [fs, setFs] = useState(false); // window fullscreen state (relayed from main)
  const [speed, setSpeed] = useState(() => lsNum("locality.mpv.speed", 1));
  const [helpOpen, setHelpOpen] = useState(false);
  const [audioDevice, setAudioDevice] = useState("auto");
  const [audioDeviceList, setAudioDeviceList] = useState<{ name: string; description?: string }[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [chapters, setChapters] = useState<{ title?: string | null; time: number }[]>([]);
  const [nightMode, setNightMode] = useState(() => localStorage.getItem("locality.mpv.nightMode") === "1");
  const [osd, setOsd] = useState<{ text: string; bar?: number } | null>(null);
  const cmd = window.locality.mpv.command;

  const advancedRef = useRef(false); // guards the Up Next auto-advance to one call
  // Conditions that pin the bar visible, read from inside the idle timer.
  const hoverRef = useRef(false); // pointer over a bar
  const pausedRef = useRef(false);
  const menuRef = useRef(false);
  pausedRef.current = paused;
  menuRef.current = menu !== null;
  const posRef = useRef(pos);
  posRef.current = pos;
  const fsRef = useRef(fs);
  fsRef.current = fs;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const helpRef = useRef(helpOpen);
  helpRef.current = helpOpen;
  // Last position we pushed to React, so the high-frequency time-pos stream can
  // be throttled to a few re-renders a second instead of one per mpv tick.
  const lastPosRef = useRef(0);

  // Watch party. This window loads the same bundle with ?port=, so the shared
  // hook's local-server calls and SSE subscription work here unchanged.
  const { active: partyActive, publish: partyPublish, notice: partyNotice, party: partyInfo } = usePartySync({
    fileId: Number(fileId) || -1,
    position: () => posRef.current,
    paused: () => pausedRef.current,
    seek: (to) => {
      cmd(["seek", to, "absolute"]);
      lastPosRef.current = to;
      setPos(to);
    },
    setPaused: (p) => cmd(["set_property", "pause", p]),
  });
  // Publish after mpv has actually moved. Arrow-key seeks are RELATIVE, so the
  // resulting position isn't known until mpv reports the next time-pos — reading
  // it immediately would broadcast the position we just left.
  const publishTimer = useRef<ReturnType<typeof setTimeout>>();
  const publishSoon = useCallback(() => {
    clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(partyPublish, 300);
  }, [partyPublish]);

  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!hoverRef.current && !pausedRef.current && !menuRef.current) setVisible(false);
    }, IDLE_MS);
  }, []);

  // Brief on-screen feedback (seek / volume) for keyboard actions.
  const volRef = useRef(vol);
  volRef.current = vol;
  const osdTimer = useRef<ReturnType<typeof setTimeout>>();
  const showOsd = useCallback((text: string, bar?: number) => {
    setOsd({ text, bar });
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 900);
  }, []);

  // Shift the subtitles earlier/later (mpv sub-delay, seconds). Local state is
  // the source of truth since only this overlay changes it.
  const adjustSubDelay = useCallback(
    (delta: number) => {
      setSubDelay((v) => {
        const nv = Math.round((v + delta) * 10) / 10;
        cmd(["set_property", "sub-delay", nv]);
        return nv;
      });
    },
    [cmd]
  );
  const applyScale = useCallback(
    (v: number) => {
      setSubScale(v);
      localStorage.setItem("locality.mpv.subScale", String(v));
      cmd(["set_property", "sub-scale", v]);
      cmd(["set_property", "sub-ass-override", "scale"]); // so size applies to ASS subs too
    },
    [cmd]
  );
  const applySubPos = useCallback(
    (v: number) => {
      setSubPos(v);
      localStorage.setItem("locality.mpv.subPos", String(v));
      cmd(["set_property", "sub-pos", v]);
    },
    [cmd]
  );
  const applySubColor = useCallback(
    (v: string) => {
      setSubColor(v);
      localStorage.setItem("locality.mpv.subColor", v);
      cmd(["set_property", "sub-color", v]);
    },
    [cmd]
  );
  const applySubBg = useCallback(
    (v: "none" | "box") => {
      setSubBg(v);
      localStorage.setItem("locality.mpv.subBg", v);
      // A translucent black box behind the text; "none" clears it (fully transparent).
      cmd(["set_property", "sub-back-color", v === "box" ? "#80000000" : "#00000000"]);
    },
    [cmd]
  );

  // Apply the persisted subtitle style + night mode once (mpv is playing by now).
  useEffect(() => {
    if (subScale !== 1) {
      cmd(["set_property", "sub-scale", subScale]);
      cmd(["set_property", "sub-ass-override", "scale"]);
    }
    if (subPos !== 100) cmd(["set_property", "sub-pos", subPos]);
    if (nightMode) cmd(["set_property", "af", NIGHT_MODE_AF]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleNight = () => {
    setNightMode((on) => {
      const nv = !on;
      localStorage.setItem("locality.mpv.nightMode", nv ? "1" : "0");
      cmd(["set_property", "af", nv ? NIGHT_MODE_AF : ""]);
      showOsd(nv ? "Night mode on" : "Night mode off");
      return nv;
    });
  };

  // A single click on the video does nothing (it only dismisses an open menu);
  // double-click toggles fullscreen. Click-to-pause was removed on purpose: it
  // fired an accidental pause when reaching for a control and made the overlay
  // feel unreliable.
  const onVideoClick = () => {
    if (menu) setMenu(null);
  };
  const onVideoDouble = () => {
    void window.locality.mpv.fullscreen();
  };

  // Rich metadata for the paused title card (title, episode, synopsis, rating).
  useEffect(() => {
    if (!fileId) return;
    fetch(`http://127.0.0.1:${port}/api/player/meta/${fileId}`)
      .then((r) => r.json())
      .then((m: Meta) => setMeta(m))
      .catch(() => {});
  }, []);

  // Remember the audio/subtitle language for this show so the next episode
  // auto-selects it (resolved to the owning show/movie server-side).
  const savePref = (body: { audioLang?: string; subLang?: string }) => {
    if (!fileId) return;
    fetch(`http://127.0.0.1:${port}/api/player/prefs-by-file/${fileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  const applySpeed = (v: number) => {
    setSpeed(v);
    localStorage.setItem("locality.mpv.speed", String(v));
    cmd(["set_property", "speed", v]);
    setMenu(null);
  };

  useEffect(() => {
    return window.locality.mpv.onEvent((d) => {
      if (d.type === "fullscreen") return void setFs(!!d.value);
      if (d.type !== "prop") return;
      if (d.name === "time-pos" && typeof d.value === "number") {
        // mpv streams time-pos many times a second; re-rendering the whole
        // overlay on each one is what made the controls feel laggy. A quarter-
        // second granularity is plenty for the clock and the scrubber.
        if (Math.abs(d.value - lastPosRef.current) >= 0.25) {
          lastPosRef.current = d.value;
          setPos(d.value);
        }
      } else if (d.name === "duration" && typeof d.value === "number") setDur(d.value);
      else if (d.name === "pause" && typeof d.value === "boolean") setPaused(d.value);
      else if (d.name === "volume" && typeof d.value === "number") setVol(Math.round(d.value));
      else if (d.name === "mute" && typeof d.value === "boolean") setMuted(d.value);
      else if (d.name === "track-list" && Array.isArray(d.value)) setTracks(d.value as Track[]);
      else if (d.name === "speed" && typeof d.value === "number") setSpeed(d.value);
      else if (d.name === "audio-device" && typeof d.value === "string") setAudioDevice(d.value);
      else if (d.name === "audio-device-list" && Array.isArray(d.value)) setAudioDeviceList(d.value as { name: string; description?: string }[]);
      else if (d.name === "chapter-list" && Array.isArray(d.value)) setChapters(d.value as { title?: string | null; time: number }[]);
    });
  }, []);

  // Push saved preferences (subtitle styling, volume, speed) to mpv once the
  // window is up, so they persist across sessions and carry to the next episode.
  useEffect(() => {
    cmd(["set_property", "sub-scale", subScale]);
    cmd(["set_property", "sub-pos", subPos]);
    cmd(["set_property", "sub-color", subColor]);
    cmd(["set_property", "sub-back-color", subBg === "box" ? "#80000000" : "#00000000"]);
    cmd(["set_property", "volume", vol]);
    cmd(["set_property", "speed", speed]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-arm the countdown (and reveal) whenever a pin condition flips.
  useEffect(() => reveal(), [paused, menu, reveal]);

  // The overlay window is focused, so key events land here — relay them to mpv.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      reveal();
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          cmd(["cycle", "pause"]);
          publishSoon();
          break;
        case "ArrowRight":
          e.preventDefault();
          cmd(["seek", e.shiftKey ? 60 : 10, "relative"]);
          showOsd(`⏩  +${e.shiftKey ? 60 : 10}s`);
          publishSoon();
          break;
        case "ArrowLeft":
          e.preventDefault();
          cmd(["seek", e.shiftKey ? -60 : -10, "relative"]);
          showOsd(`⏪  −${e.shiftKey ? 60 : 10}s`);
          publishSoon();
          break;
        case "ArrowUp": {
          e.preventDefault();
          cmd(["add", "volume", 5]);
          const nv = Math.min(200, volRef.current + 5); // boostable to 200% (VLC-style)
          localStorage.setItem("locality.mpv.volume", String(nv));
          showOsd(`Volume ${nv}%`, nv / 2);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          cmd(["add", "volume", -5]);
          const nv = Math.max(0, volRef.current - 5);
          localStorage.setItem("locality.mpv.volume", String(nv));
          showOsd(`Volume ${nv}%`, nv / 2);
          break;
        }
        case "?":
          e.preventDefault();
          setHelpOpen((h) => !h);
          break;
        case "m":
          cmd(["cycle", "mute"]);
          showOsd(mutedRef.current ? "Unmuted" : "Muted");
          break;
        case "g":
          adjustSubDelay(-0.5); // subtitles earlier
          break;
        case "h":
          adjustSubDelay(0.5); // subtitles later
          break;
        case "f":
          void window.locality.mpv.fullscreen();
          break;
        case "Escape":
          e.preventDefault();
          // Esc closes the help card, else leaves fullscreen. It no longer quits
          // the whole player; quitting is the back button (top-left) or "q".
          if (helpRef.current) setHelpOpen(false);
          else if (fsRef.current) void window.locality.mpv.fullscreen();
          break;
        case "q":
          e.preventDefault();
          void window.locality.mpv.stop();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cmd, reveal, adjustSubDelay, showOsd, publishSoon]);

  // Debounce + bucket the hovered time so sweeping the bar isn't a request per
  // pixel (the server caches thumbnails in 5s buckets anyway).
  const hoverT = hover?.t ?? null;
  useEffect(() => {
    if (hoverT === null) return;
    const id = window.setTimeout(() => setThumbAt(Math.max(0, Math.floor(hoverT / 5) * 5)), 90);
    return () => window.clearTimeout(id);
  }, [hoverT]);

  const shown = drag ?? pos;
  const seek = (v: number) => {
    cmd(["seek", v, "absolute"]);
    lastPosRef.current = v;
    setPos(v);
    setDrag(null);
    publishSoon();
  };
  const pinBar = (on: boolean) => {
    hoverRef.current = on;
    if (on) {
      setVisible(true);
      clearTimeout(hideTimer.current);
    } else reveal();
  };

  const subs = tracks.filter((t) => t.type === "sub");
  const audios = tracks.filter((t) => t.type === "audio");
  const barOpacity = visible ? "opacity-100" : "opacity-0 pointer-events-none";

  const isEpisode = meta != null && meta.season != null && meta.episode != null;
  const headerTitle = meta?.showTitle || title;
  const episodeLabel = isEpisode ? `S${pad2(meta!.season!)}:E${pad2(meta!.episode!)}` : "";
  const headerSub = isEpisode ? `${episodeLabel}${meta!.episodeTitle ? ` · ${meta!.episodeTitle}` : ""}` : "";

  // Skip Intro: while inside the detected intro range.
  const inIntro = meta?.introStart != null && meta?.introEnd != null && pos >= meta.introStart && pos < meta.introEnd - 1;
  // Up Next: the end zone starts at the credits marker, else a bit before the end.
  const upSecs = meta?.upNextSeconds || 10;
  const endZoneStart = meta?.creditsStart != null && meta.creditsStart > 0 ? meta.creditsStart : dur > 0 ? dur - Math.max(upSecs, 15) : Infinity;
  const inEndZone = hasNext && dur > 0 && pos >= endZoneStart;
  const upNextLeft = Math.max(0, Math.ceil(endZoneStart + upSecs - pos));

  // Auto-advance once the countdown elapses (mpv's eof handler is the fallback).
  useEffect(() => {
    if (inEndZone && meta?.autoplayNext && upNextLeft <= 0 && !advancedRef.current) {
      advancedRef.current = true;
      void window.locality.mpv.next();
    }
  }, [inEndZone, upNextLeft, meta]);

  // Skip Intro auto-skips 3s after it appears (clicking the button skips sooner).
  // Deps intentionally exclude `pos` so the timer isn't reset every second.
  useEffect(() => {
    if (!inIntro || meta?.introEnd == null) return;
    const id = setTimeout(() => cmd(["seek", meta.introEnd!, "absolute"]), 3000);
    return () => clearTimeout(id);
  }, [inIntro, meta, cmd]);

  return (
    <div
      className="fixed inset-0 text-white select-none"
      // The ~1% background is deliberate: Windows treats fully-transparent
      // (alpha 0) pixels of a transparent window as click-through, so without a
      // whisper of fill the overlay would receive no mouse events (bar never
      // reveals) and couldn't own the cursor (couldn't hide it). 1% black is
      // imperceptible over video but makes the whole layer hit-testable.
      style={{ cursor: visible ? "default" : "none", background: "rgba(0,0,0,0.01)" }}
      onMouseMove={reveal}
      onDoubleClick={onVideoDouble}
      onClick={onVideoClick}
    >
      {/* Dim the frame (stronger on the left) while paused so the card reads. */}
      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-500 bg-gradient-to-r from-black/95 via-black/65 to-black/25 ${paused ? "opacity-100" : "opacity-0"}`} />

      {/* On-screen feedback for keyboard seek/volume. */}
      {osd && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none">
          <div className="px-5 py-3 rounded-xl bg-black/70 backdrop-blur text-white text-lg font-medium flex flex-col items-center gap-2 min-w-[130px]">
            <span className="tabular-nums">{osd.text}</span>
            {osd.bar != null && (
              <div className="w-32 h-1.5 rounded-full bg-white/25 overflow-hidden">
                <div className="h-full rounded-full bg-white" style={{ width: `${osd.bar}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help (toggle with ?). */}
      {helpOpen && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setHelpOpen(false)}>
          <div className="w-[440px] max-w-[90%] rounded-xl bg-black/90 border border-white/15 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg text-white">Keyboard shortcuts</h3>
              <button className="text-white/50 hover:text-white text-lg leading-none" title="Close" onClick={() => setHelpOpen(false)}>✕</button>
            </div>
            <div className="space-y-2 text-sm">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <span className="text-white/60">{d}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-white/90 text-xs font-mono shrink-0">{k}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Watch-party action toast: "John has paused / seeked to 1:30:21". Top-right,
          independent of the auto-hiding bar so you always catch it. */}
      {partyNotice && (
        <div className="absolute top-4 right-6 z-50 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-black/80 border border-white/15 px-3.5 py-1.5 text-sm text-white shadow-xl backdrop-blur-md">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {partyNotice}
          </div>
        </div>
      )}

      {/* Netflix-style title card, shown while paused (not during the Up Next zone). */}
      <div
        className={`absolute left-8 sm:left-14 top-1/2 -translate-y-1/2 max-w-[46%] pointer-events-none transition-opacity duration-500 ${paused && meta && !inEndZone ? "opacity-100" : "opacity-0"}`}
        style={{ textShadow: "0 2px 10px rgba(0,0,0,0.75)" }}
      >
        {meta && (
          <>
            <div className="text-white/60 text-sm mb-2">{paused ? "You're watching" : ""}</div>
            {isEpisode ? (
              <>
                <div className="text-white/75 text-base sm:text-lg font-display">{meta.showTitle}</div>
                <h1 className="font-display font-bold text-white text-3xl sm:text-5xl leading-tight mt-0.5">{meta.episodeTitle || `Episode ${meta.episode}`}</h1>
                <div className="text-white/55 text-sm mt-1.5">{episodeLabel}</div>
              </>
            ) : (
              <h1 className="font-display font-bold text-white text-3xl sm:text-5xl leading-tight">{meta.showTitle}</h1>
            )}
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-3 text-white/80 text-sm">
              {meta.contentRating && <span className="px-1.5 py-0.5 border border-white/45 rounded text-xs font-semibold tracking-wide">{meta.contentRating}</span>}
              {meta.year && <span>{meta.year}</span>}
              {meta.runtime ? <span>{meta.runtime} min</span> : null}
              {meta.voteRating ? <span className="text-emerald-400 font-semibold">{Math.round(meta.voteRating * 10)}%</span> : null}
            </div>
            {meta.genres && meta.genres.length > 0 && <div className="text-white/55 text-xs mt-1.5">{meta.genres.slice(0, 3).join(" · ")}</div>}
            {meta.overview && <p className="text-white/85 text-sm leading-relaxed mt-3 line-clamp-4">{meta.overview}</p>}
          </>
        )}
      </div>

      {/* top bar: back + title */}
      <div
        className={`absolute top-0 inset-x-0 px-6 pt-4 pb-12 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${barOpacity}`}
        onMouseEnter={() => pinBar(true)}
        onMouseLeave={() => pinBar(false)}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <button
            className="w-9 h-9 -ml-1.5 shrink-0 rounded-full flex items-center justify-center text-white/90 hover:bg-white/15 hover:text-white transition-colors cursor-pointer"
            title="Back (Esc)"
            onClick={() => void window.locality.mpv.stop()}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="font-display text-white text-[15px] leading-tight truncate">{headerTitle}</div>
            {headerSub && <div className="text-white/55 text-xs leading-tight truncate">{headerSub}</div>}
          </div>
          {partyActive && partyInfo && <PartyPresenceBadge members={partyInfo.members} />}
        </div>
      </div>

      {/* bottom bar: scrubber + controls */}
      <div
        className={`absolute bottom-0 inset-x-0 px-6 pb-4 pt-16 bg-gradient-to-t from-black/95 via-black/60 to-transparent transition-opacity duration-300 ${barOpacity}`}
        onMouseEnter={() => pinBar(true)}
        onMouseLeave={() => pinBar(false)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative"
          onMouseMove={(e) => {
            if (dur <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setBarWidth(rect.width);
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            setHover({ x: e.clientX - rect.left, t: frac * dur });
          }}
          onMouseLeave={() => setHover(null)}
        >
          {hover && dur > 0 && fileId && <ScrubberTooltip hover={hover} thumbAt={thumbAt} containerWidth={barWidth} />}
          <input
            type="range"
            className="w-full cursor-pointer"
            min={0}
            max={Math.max(1, dur)}
            step={0.5}
            value={shown}
            aria-label="Seek"
            onChange={(e) => setDrag(+e.target.value)}
            onPointerUp={(e) => seek(+e.currentTarget.value)}
            onMouseUp={(e) => seek(+e.currentTarget.value)}
          />
          {/* Chapter dividers: track-height notches that read as small gaps, and
              hide under the playhead so they never clash with the moving thumb. */}
          {chapters.length > 1 && dur > 0 && (
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 pointer-events-none">
              {chapters.map((ch, i) => {
                if (i === 0 || ch.time <= 0) return null;
                const frac = ch.time / dur;
                if (Math.abs(frac - shown / dur) < 0.018) return null; // sits under the thumb
                return <span key={i} className="absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full bg-black/55" style={{ left: `${frac * 100}%` }} />;
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 mt-2 text-sm">
          <button className="text-white hover:text-white/80 cursor-pointer" title="Play / Pause (Space)" onClick={() => { cmd(["cycle", "pause"]); publishSoon(); }}>
            {paused ? <PlayIcon className="w-6 h-6" /> : <PauseIcon />}
          </button>
          <span className="text-xs text-white/70 tabular-nums">
            {fmtTime(shown)} / {fmtTime(dur)}
          </span>
          {hasNext && (
            <button
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-white/25 text-white/90 hover:border-white hover:text-white transition-colors cursor-pointer"
              title="Next episode"
              onClick={() => void window.locality.mpv.next()}
            >
              <SkipNextIcon /> Next
            </button>
          )}

          <div className="flex-1" />

          <label className="flex items-center gap-1.5 text-white/80" title="Volume (up to 200%)">
            <button
              type="button"
              className="hover:text-white cursor-pointer"
              title={muted ? "Unmute (m)" : "Mute (m)"}
              onClick={() => { cmd(["cycle", "mute"]); }}
            >
              <VolumeIcon muted={muted || vol === 0} />
            </button>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={muted ? 0 : vol}
              className="w-24 cursor-pointer"
              aria-label="Volume"
              onChange={(e) => {
                const v = +e.target.value;
                if (muted) cmd(["set_property", "mute", false]); // dragging the slider unmutes
                setVol(v);
                localStorage.setItem("locality.mpv.volume", String(v));
                cmd(["set_property", "volume", v]);
              }}
            />
            <span className="text-[11px] tabular-nums text-white/50 w-9 text-right">{muted ? 0 : vol}%</span>
          </label>

          <div className="relative">
            <button
              className={`px-2 h-7 rounded-md text-xs font-medium tabular-nums cursor-pointer transition-colors ${menu === "speed" ? "text-white bg-white/10" : "text-white/85 hover:text-white hover:bg-white/10"}`}
              title="Playback speed"
              onClick={() => setMenu(menu === "speed" ? null : "speed")}
            >
              {Math.round(speed * 100) / 100}×
            </button>
            {menu === "speed" && (
              <Popover heading="Speed">
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => (
                  <MenuItem key={v} selected={Math.abs(speed - v) < 0.001} onClick={() => applySpeed(v)}>
                    {v}×
                  </MenuItem>
                ))}
              </Popover>
            )}
          </div>

          <div className="relative">
            <IconButton active={menu === "sub"} title="Subtitles" onClick={() => setMenu(menu === "sub" ? null : "sub")}>
              <SubsIcon />
            </IconButton>
            {menu === "sub" && (
              <Popover heading="Subtitles">
                <MenuItem selected={!subs.some((s) => s.selected)} onClick={() => { cmd(["set_property", "sid", "no"]); savePref({ subLang: "off" }); setMenu(null); }}>
                  Off
                </MenuItem>
                {subs.map((s) => (
                  <MenuItem key={s.id} selected={!!s.selected} onClick={() => { cmd(["set_property", "sid", s.id]); if (s.lang) savePref({ subLang: s.lang }); setMenu(null); }}>
                    {trackLabel(s)}
                  </MenuItem>
                ))}
                <div className="my-1 border-t border-cardborder" />
                <div className="px-3 py-1.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] uppercase tracking-wider text-muted">Delay (g / h)</span>
                    {subDelay !== 0 && (
                      <button className="text-[11px] text-accent hover:underline" onClick={() => { setSubDelay(0); cmd(["set_property", "sub-delay", 0]); }}>
                        reset
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="w-7 h-7 rounded-md border border-cardborder text-body hover:bg-hov" onClick={() => adjustSubDelay(-0.1)}>−</button>
                    <span className="flex-1 text-center tabular-nums text-body text-xs">{subDelay > 0 ? "+" : ""}{subDelay.toFixed(1)}s</span>
                    <button className="w-7 h-7 rounded-md border border-cardborder text-body hover:bg-hov" onClick={() => adjustSubDelay(0.1)}>+</button>
                  </div>
                </div>
                <div className="my-1 border-t border-cardborder" />
                <div className="px-3 py-1.5 space-y-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Size</div>
                    <div className="grid grid-cols-4 gap-1">
                      {SUB_SIZES.map(([label, v]) => (
                        <StyleButton key={label} active={subScale === v} onClick={() => applyScale(v)}>{label}</StyleButton>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Position</div>
                    <div className="grid grid-cols-4 gap-1">
                      {SUB_POSITIONS.map(([label, v]) => (
                        <StyleButton key={label} active={subPos === v} onClick={() => applySubPos(v)}>{label}</StyleButton>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Colour</div>
                    <div className="grid grid-cols-4 gap-1">
                      {SUB_COLORS.map(([label, v]) => (
                        <button
                          key={label}
                          onClick={() => applySubColor(v)}
                          title={label}
                          className={`h-7 rounded-md border flex items-center justify-center transition-colors ${subColor.toUpperCase() === v.toUpperCase() ? "border-accent" : "border-cardborder hover:bg-hov"}`}
                        >
                          <span className="w-3.5 h-3.5 rounded-full border border-white/20" style={{ background: v }} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted mb-1">Background</div>
                    <div className="grid grid-cols-2 gap-1">
                      <StyleButton active={subBg === "none"} onClick={() => applySubBg("none")}>None</StyleButton>
                      <StyleButton active={subBg === "box"} onClick={() => applySubBg("box")}>Box</StyleButton>
                    </div>
                  </div>
                </div>
                <div className="my-1 border-t border-cardborder" />
                <MenuItem onClick={() => { void window.locality.mpv.subAddFile(); setMenu(null); }}>Add subtitle file…</MenuItem>
                <MenuItem onClick={() => { void window.locality.mpv.subSearch(); setMenu(null); }}>Search online…</MenuItem>
              </Popover>
            )}
          </div>

          <div className="relative">
            <IconButton active={menu === "audio"} title="Audio track" onClick={() => setMenu(menu === "audio" ? null : "audio")}>
              <AudioIcon />
            </IconButton>
            {menu === "audio" && (
              <Popover heading="Audio">
                <MenuItem selected={nightMode} onClick={toggleNight}>Night mode (boost dialogue)</MenuItem>
                <div className="my-1 border-t border-cardborder" />
                {audios.length ? (
                  audios.map((a) => (
                    <MenuItem key={a.id} selected={!!a.selected} onClick={() => { cmd(["set_property", "aid", a.id]); if (a.lang) savePref({ audioLang: a.lang }); setMenu(null); }}>
                      {trackLabel(a)}
                    </MenuItem>
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-muted">No audio tracks</div>
                )}
                {audioDeviceList.length > 0 && (
                  <>
                    <div className="my-1 border-t border-cardborder" />
                    <div className="px-3 pt-1 pb-0.5 text-[11px] uppercase tracking-wider text-muted">Output device</div>
                    {audioDeviceList.map((dvc) => (
                      <MenuItem key={dvc.name} selected={dvc.name === audioDevice} onClick={() => { cmd(["set_property", "audio-device", dvc.name]); setMenu(null); }}>
                        {dvc.description || dvc.name}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}
          </div>

          <IconButton title={fs ? "Exit fullscreen (f)" : "Fullscreen (f)"} onClick={() => window.locality.mpv.fullscreen()}>
            {fs ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </IconButton>
        </div>
      </div>

      {/* Skip Intro (shown while inside the intro) — independent of the bar. */}
      {inIntro && (
        <button
          className="absolute bottom-28 right-8 z-40 px-5 py-2.5 rounded-md bg-black/55 border border-white/40 text-white text-sm font-semibold hover:bg-black/75 transition-colors shadow-xl cursor-pointer"
          onClick={(e) => { e.stopPropagation(); cmd(["seek", meta!.introEnd!, "absolute"]); }}
        >
          Skip Intro
        </button>
      )}

      {/* Up Next card, near the end when there's a next episode. */}
      {inEndZone && meta?.next && (
        <div className="absolute bottom-28 right-8 z-40 w-72 rounded-lg bg-black/85 border border-white/15 backdrop-blur-md p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="text-white/55 text-[11px] uppercase tracking-wider mb-1">Up Next</div>
          <div className="text-white font-display text-base leading-snug line-clamp-2">{meta.next.title}</div>
          <div className="text-white/50 text-xs mt-0.5 mb-3">S{pad2(meta.next.season)}:E{pad2(meta.next.episode)}</div>
          <button
            className="w-full px-3 py-2 rounded-md bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
            onClick={() => void window.locality.mpv.next()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            {meta.autoplayNext ? "Play now" : "Play next"}
          </button>
          {meta.autoplayNext && <div className="text-white/50 text-xs mt-2 text-center">Playing in {upNextLeft}s</div>}
        </div>
      )}
    </div>
  );
}

function trackLabel(t: Track): string {
  return [t.lang ? String(t.lang).toUpperCase() : null, t.title].filter(Boolean).join(" · ") || `Track ${t.id}`;
}

/** Watch-party badge that reveals, on hover, who is here and who has the player open. */
function PartyPresenceBadge({ members }: { members: PartyMember[] }) {
  const joined = members.filter((m) => m.status === "joined");
  const invited = members.filter((m) => m.status === "invited");
  const watching = joined.filter((m) => m.watching).length;
  return (
    <div className="relative group shrink-0">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-white/90 border border-white/30 rounded-full px-2 py-0.5 cursor-default">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Watch party
        <span className="normal-case tracking-normal text-white/50">{watching}/{joined.length} in player</span>
      </span>
      <div className="absolute left-0 top-full mt-2 hidden group-hover:block z-50 w-60 rounded-lg bg-black/90 border border-white/15 backdrop-blur-md p-2 shadow-2xl">
        <div className="text-[10px] uppercase tracking-wider text-white/40 px-1.5 pb-1">Party ({joined.length})</div>
        {joined.map((m) => (
          <div key={m.userId} className="flex items-center gap-2 px-1.5 py-1 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.watching ? "bg-emerald-400" : "bg-white/25"}`} />
            <span className="text-white/90 truncate">{m.username}</span>
            {m.isHost && <span className="text-[9px] uppercase tracking-wider text-white/40">host</span>}
            <span className="ml-auto text-[10px] text-white/40 shrink-0">{m.watching ? "in player" : "in app"}</span>
          </div>
        ))}
        {invited.length > 0 && (
          <>
            <div className="my-1 border-t border-white/10" />
            {invited.map((m) => (
              <div key={m.userId} className="flex items-center gap-2 px-1.5 py-1 text-xs text-white/40">
                <span className="w-1.5 h-1.5 rounded-full bg-white/15 shrink-0" />
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

// Preview thumbnail above the scrubber. Preloads the target frame and only swaps
// once it's decoded, so sweeping the bar doesn't flash blank tiles.
function ScrubberTooltip({ hover, thumbAt, containerWidth }: { hover: { x: number; t: number }; thumbAt: number | null; containerWidth: number }) {
  const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);
  const targetUrl = thumbAt !== null ? thumbUrl(thumbAt) : null;
  useEffect(() => {
    if (!targetUrl) return;
    let active = true;
    const img = new Image();
    img.src = targetUrl;
    img.onload = () => active && setDisplayedUrl(targetUrl);
    return () => {
      active = false;
    };
  }, [targetUrl]);
  const clampedX = containerWidth > 0 ? Math.max(84, Math.min(hover.x, containerWidth - 84)) : hover.x;
  return (
    <div className="absolute bottom-full mb-3 -translate-x-1/2 flex flex-col items-center pointer-events-none z-30" style={{ left: clampedX }}>
      <div className="w-40 h-[90px] rounded-lg border border-white/15 shadow-2xl bg-black/90 overflow-hidden backdrop-blur-md">
        {displayedUrl ? (
          <img src={displayedUrl} alt="" draggable={false} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-zinc-900/80">
            <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-accent animate-spin" />
          </div>
        )}
      </div>
      <span className="mt-1.5 text-[11px] font-mono font-medium text-white bg-black/80 border border-white/10 px-2 py-0.5 rounded shadow-lg">
        {fmtTime(hover.t)}
      </span>
    </div>
  );
}

function IconButton({ children, title, onClick, active }: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button className={`p-1 cursor-pointer transition-colors ${active ? "text-white" : "text-white/85 hover:text-white"}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

// Themed popover that opens upward from a control (the bar sits at the bottom).
function Popover({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full right-0 mb-2 min-w-[210px] max-w-[340px] rounded-lg border border-cardborder bg-raised shadow-2xl py-1 z-30">
      <div className="px-3 pt-1.5 pb-1 text-[11px] uppercase tracking-wider text-muted">{heading}</div>
      <div className="max-h-[46vh] overflow-y-auto">{children}</div>
    </div>
  );
}

function MenuItem({ children, selected, onClick }: { children: React.ReactNode; selected?: boolean; onClick: () => void }) {
  return (
    <button className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-hov transition-colors cursor-pointer ${selected ? "text-accent" : "text-body"}`} onClick={onClick}>
      <span className="w-3.5 shrink-0">
        {selected && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-11" />
          </svg>
        )}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function StyleButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`text-[11px] py-1 rounded border transition-colors cursor-pointer ${active ? "bg-accent text-accenttext border-accent" : "text-body border-cardborder hover:bg-hov"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PauseIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}
function SkipNextIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5.5v13l9-6.5-9-6.5z" />
      <rect x="16.5" y="5" width="2.2" height="14" rx="1" />
    </svg>
  );
}
function FullscreenIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </svg>
  );
}
function ExitFullscreenIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
    </svg>
  );
}
function VolumeIcon({ muted = false, className = "w-[18px] h-[18px]" }: { muted?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5z" fill="currentColor" stroke="none" />
      {muted ? <path d="m15 9 5 6m0-6-5 6" /> : (
        <>
          <path d="M14.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M17 6.8a7.5 7.5 0 0 1 0 10.4" />
        </>
      )}
    </svg>
  );
}
function SubsIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 15h4M13 15h4M7 11h2M11 11h6" strokeLinecap="round" />
    </svg>
  );
}
function AudioIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="13.5" width="4" height="6.5" rx="1.5" />
      <rect x="17.5" y="13.5" width="4" height="6.5" rx="1.5" />
    </svg>
  );
}
