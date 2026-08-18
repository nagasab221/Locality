import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, apiFrom, get, post, imgUrl, fmtTime, fmtSize, subscribe, lp, isRemoteActive, activeRemoteServer } from "../api";
import type { ItemDetail as Detail, EpisodeRow } from "../types";
import { btnGhost, btnPrimary, CheckIcon, Img, Modal, PlayIcon, PosterCard, inputCls } from "../components/ui";
import { MatchDialog } from "../components/MatchDialog";

export default function ItemDetailPage() {
  const { id } = useParams();
  const [item, setItem] = useState<Detail | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detectQueued, setDetectQueued] = useState(false);
  const [similar, setSimilar] = useState<Detail[]>([]);
  const [season, setSeason] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dlNote, setDlNote] = useState<string | null>(null);
  /** File id a watch party is being started for, or null when the dialog is shut. */
  const [partyFor, setPartyFor] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    get<Detail>(`/items/${id}`)
      .then((d) => {
        setItem(d);
        if (d.seasons && d.seasons.length > 0) {
          setSeason((s) => (s !== null && d.seasons!.some((x) => x.season === s) ? s : d.seasons![0].season));
        }
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    get(`/items/${id}/similar`).then(setSimilar).catch(() => setSimilar([]));
  }, [id]);
  useEffect(() => {
    const subs = [
      subscribe("item-changed", (d) => {
        if (d.itemId === Number(id)) load();
      }),
      subscribe("detect", (d) => {
        if (d.showId === Number(id) && (d.phase === "done" || d.phase === "error")) setDetectQueued(false);
      }),
      subscribe("ledger-merged", load),
      subscribe("player", (s) => {
        if (!s.active) load();
      }),
    ];
    return () => subs.forEach((u) => u());
  }, [id, load]);

  if (error) return <div className="p-8 text-danger">{error}</div>;
  if (!item) return <div className="p-8 text-muted">Loading…</div>;

  const isMovie = item.type === "movie";
  const primaryFile = isMovie ? item.files?.[0] : undefined;
  const resumable =
    primaryFile?.progress && !primaryFile.progress.watched && primaryFile.progress.position_seconds > 30;
  const watched = isMovie ? item.watched : (item.episodeCount ?? 0) > 0 && item.watchedCount === item.episodeCount;
  const currentSeason = item.seasons?.find((s) => s.season === season);

  // For shows: the episode this "Play" button targets, without scrolling to it.
  // First an in-progress episode (resume where they stopped), else the first
  // unwatched one, else S01E01 so "Play" still works after a full watch.
  const episodesInOrder = isMovie
    ? []
    : [...(item.seasons ?? [])]
        .flatMap((s) => s.episodes)
        .filter((e) => e.file)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const inProgressEp = episodesInOrder.find(
    (e) => e.progress && !e.progress.watched && e.progress.position_seconds > 30
  );
  const nextUp = isMovie || episodesInOrder.length === 0
    ? null
    : inProgressEp
      ? { ep: inProgressEp, resume: true }
      : { ep: episodesInOrder.find((e) => !e.progress?.watched) ?? episodesInOrder[0], resume: false };

  const act = (fn: () => Promise<any>) => {
    setBusy(true);
    fn()
      .then(load)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  // Download this item from the remote server we're browsing onto this PC. Goes
  // to the LOCAL server, which pulls it in the background (see the Downloads page).
  const startDownload = (seasonToGet: number | null) => {
    const srv = activeRemoteServer();
    if (!srv || !item) return;
    setDlNote("Starting…");
    apiFrom("local", "/downloads", {
      method: "POST",
      body: JSON.stringify({
        serverUrl: srv.url.replace(/\/+$/, ""),
        token: srv.token,
        itemId: item.id,
        season: seasonToGet,
        sourceName: srv.name,
      }),
    })
      .then(() => setDlNote(isMovie ? "Downloading. See Downloads." : "Downloading season. See Downloads."))
      .catch((e) => setDlNote(String(e.message ?? e)));
  };

  return (
    <div>
      {/* Hero */}
      <div className="relative h-72">
        {item.backdrop ? (
          <Img src={imgUrl(item.backdrop)} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-raised" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/60 to-bg/10" />
      </div>

      <div className="px-8 -mt-36 relative pb-10">
        <div className="flex gap-7">
          <div className="w-48 shrink-0 rounded-lg overflow-hidden border border-cardborder shadow-xl bg-raised aspect-[2/3]">
            <Img src={imgUrl(item.poster)} fallbackText={item.title} className="w-full h-full object-cover" />
          </div>

          <div className="flex-1 min-w-0 pt-16">
            <h1 className="font-display text-4xl text-heading drop-shadow">{item.title}</h1>
            <div className="mt-2 text-sm text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
              {item.year && <span>{item.year}</span>}
              {item.runtime && <span>{item.runtime} min</span>}
              {item.rating != null && item.rating > 0 && <span className="text-hint">★ {item.rating.toFixed(1)}</span>}
              {!isMovie && item.episodeCount != null && (
                <span>
                  {item.watchedCount}/{item.episodeCount} episodes watched
                </span>
              )}
              {item.status === "needs_match" && (
                <span className="px-2 py-0.5 rounded bg-warn/20 text-warn text-xs">needs matching</span>
              )}
              {item.status === "matched" && item.provider && item.provider !== "tmdb" && (
                <span className="px-2 py-0.5 rounded bg-raised border border-inborder text-xs text-muted">
                  via {item.provider === "tvmaze" ? "TVmaze" : "AniList"}
                </span>
              )}
            </div>
            {item.genres.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.genres.map((g) => (
                  <span key={g} className="px-2.5 py-0.5 rounded-full border border-inborder text-xs text-body">
                    {g}
                  </span>
                ))}
              </div>
            )}
            {item.tagline && <p className="mt-4 text-hint italic text-sm">{item.tagline}</p>}
            {item.overview && <p className="mt-2 text-sm text-body/90 leading-relaxed max-w-3xl">{item.overview}</p>}

            <div className="mt-5 flex flex-wrap gap-2.5">
              {isMovie && primaryFile && (
                <Link to={lp(`/play/${primaryFile.id}`)} className={btnPrimary}>
                  <PlayIcon />
                  {resumable ? `Resume ${fmtTime(primaryFile.progress!.position_seconds)}` : "Play"}
                </Link>
              )}
              {nextUp && (
                <Link to={lp(`/play/${nextUp.ep.file!.id}`)} className={btnPrimary}>
                  <PlayIcon />
                  {nextUp.resume
                    ? `Resume ${epCode(nextUp.ep)} · ${fmtTime(nextUp.ep.progress!.position_seconds)}`
                    : `Play ${epCode(nextUp.ep)}`}
                </Link>
              )}
              {/* Hosting needs a concrete file, so it lives here rather than in
                  the Party tab. Remote libraries can't host: the party would
                  have to stream from a machine that isn't this one. */}
              {!isRemoteActive() && (primaryFile || nextUp) && (
                <button
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => setPartyFor((primaryFile ?? nextUp!.ep.file!).id)}
                >
                  <PartyIcon />
                  Watch together
                </button>
              )}
              <button className={btnGhost} disabled={busy} onClick={() => act(() => post(`/items/${item.id}/watched`, { watched: !watched }))}>
                <CheckIcon className="w-4 h-4" />
                {watched ? "Mark unwatched" : "Mark watched"}
              </button>
              <button
                className={btnGhost}
                disabled={busy}
                title={item.inWatchlist ? "Remove from watchlist" : "Add to watchlist"}
                onClick={() => act(() => post(`/items/${item.id}/watchlist`, { on: !item.inWatchlist }))}
              >
                <BookmarkIcon filled={!!item.inWatchlist} className="w-4 h-4" />
                {item.inWatchlist ? "In watchlist" : "Watchlist"}
              </button>
              {isRemoteActive() && (
                <button
                  className={btnGhost}
                  disabled={!!dlNote && dlNote !== "" && dlNote.startsWith("Downloading")}
                  title="Save to this PC for offline viewing"
                  onClick={() => startDownload(isMovie ? null : season)}
                >
                  <DownloadIcon />
                  {isMovie ? "Download" : "Download season"}
                </button>
              )}
              {dlNote && <span className="text-xs text-muted self-center">{dlNote}</span>}
              <button className={btnGhost} onClick={() => setMatchOpen(true)}>
                Match…
              </button>
              {!isMovie && (
                <button
                  className={btnGhost}
                  disabled={detectQueued}
                  title="Analyze episode audio to find the intro and end credits (runs in the background)"
                  onClick={() => {
                    setDetectQueued(true);
                    post(`/items/${item.id}/detect-markers`).catch(() => setDetectQueued(false));
                  }}
                >
                  {detectQueued ? "Detecting…" : "Detect intro/credits"}
                </button>
              )}
              <button
                className={btnGhost}
                disabled={busy || (!item.tmdb_id && !(item as any).provider_id)}
                onClick={() => act(() => post(`/items/${item.id}/refresh`))}
              >
                Refresh metadata
              </button>
            </div>

            {isMovie && primaryFile && (
              <p className="mt-4 text-xs text-muted truncate" title={primaryFile.path}>
                {primaryFile.filename} · {fmtSize(primaryFile.size)}
              </p>
            )}
          </div>
        </div>

        {/* Cast & crew — names link to Person pages when we have a TMDB person id */}
        {(item.cast.length > 0 || item.crew.length > 0) && (
          <div className="mt-8 max-w-4xl">
            {item.crew.length > 0 && (
              <p className="text-sm text-muted">
                {item.crew.map((c, i) => (
                  <span key={c.name + c.job}>
                    {i > 0 && " · "}
                    {c.id ? (
                      <Link to={lp(`/person/${c.id}`)} className="hover:text-accent transition-colors">
                        {c.name}
                      </Link>
                    ) : (
                      c.name
                    )}{" "}
                    ({c.job})
                  </span>
                ))}
              </p>
            )}
            {item.cast.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.cast.map((c) =>
                  c.id ? (
                    <Link
                      key={c.name + c.character}
                      to={lp(`/person/${c.id}`)}
                      className="px-2.5 py-1 rounded-md bg-raised border border-cardborder text-xs hover:border-accent transition-colors"
                    >
                      <span className="text-body">{c.name}</span>
                      {c.character && <span className="text-muted"> as {c.character}</span>}
                    </Link>
                  ) : (
                    <span key={c.name + c.character} className="px-2.5 py-1 rounded-md bg-raised border border-cardborder text-xs" title="Refresh metadata to enable the person page">
                      <span className="text-body">{c.name}</span>
                      {c.character && <span className="text-muted"> as {c.character}</span>}
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        )}

        {/* Seasons / episodes */}
        {!isMovie && item.seasons && (
          <div className="mt-10">
            <div className="flex gap-2 flex-wrap mb-4">
              {item.seasons.map((s) => (
                <button
                  key={s.season}
                  onClick={() => setSeason(s.season)}
                  className={`px-3.5 py-1.5 rounded-md text-sm border transition-colors ${
                    s.season === season ? "bg-accent text-accenttext border-accent font-semibold" : "border-inborder text-body hover:bg-hov"
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="space-y-2 max-w-4xl">
              {currentSeason?.episodes.map((ep) => (
                <EpisodeCard key={ep.id} ep={ep} onChange={load} onParty={!isRemoteActive() ? setPartyFor : undefined} />
              ))}
            </div>
          </div>
        )}

        {/* More Like This — only titles that already exist in the library */}
        {similar.length > 0 && (
          <div className="mt-10">
            <h2 className="font-display text-xl text-heading mb-3">More Like This</h2>
            <div className="flex gap-4 overflow-x-auto pb-3">
              {similar.map((s) => (
                <div key={s.id} className="w-36 shrink-0">
                  <PosterCard item={s} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {matchOpen && <MatchDialog item={item} onClose={() => setMatchOpen(false)} onMatched={load} />}
      {partyFor != null && <StartPartyDialog fileId={partyFor} onClose={() => setPartyFor(null)} />}
    </div>
  );
}

/**
 * Pick how the guests get the video before the party is created — the choice is
 * baked into the party row, so it can't be changed afterwards without starting
 * over.
 */
function StartPartyDialog({ fileId, onClose }: { fileId: number; onClose: () => void }) {
  const [mode, setMode] = useState<"local" | "stream">("local");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const startParty = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post("/party/host", { fileId, mode });
      navigate("/party"); // invite people from there
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-6 space-y-4">
        <h3 className="font-display text-xl text-heading">Watch together</h3>
        <div className="space-y-2">
          <ModeOption
            active={mode === "local"}
            onClick={() => setMode("local")}
            title="Everyone has the file"
            body="Each person plays their own copy, matched automatically. Nothing streams over the internet, and neither side needs remote access."
          />
          <ModeOption
            active={mode === "stream"}
            onClick={() => setMode("stream")}
            title="Stream from me"
            body="Guests who don't have the file play it off this machine. Needs remote access switched on in Settings → Network."
          />
        </div>
        {err && <p className="text-danger text-sm">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={btnPrimary} onClick={startParty} disabled={busy}>
            Start party
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ModeOption({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
        active ? "border-accent bg-accent/10" : "border-cardborder hover:bg-raised"
      }`}
    >
      <div className={`text-sm ${active ? "text-accent" : "text-heading"}`}>{title}</div>
      <div className="text-xs text-muted mt-1 leading-relaxed">{body}</div>
    </button>
  );
}

function PartyIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16.5 6.4a3.2 3.2 0 0 1 0 6.2M18.5 20a6 6 0 0 0-3-5.2" />
    </svg>
  );
}

function epCode(e: EpisodeRow): string {
  return `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`;
}

function DownloadIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
    </svg>
  );
}

function BookmarkIcon({ filled = false, className = "w-4 h-4" }: { filled?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h12v16l-6-4-6 4V4z" />
    </svg>
  );
}

function EpisodeCard({ ep, onChange, onParty }: { ep: EpisodeRow; onChange: () => void; onParty?: (fileId: number) => void }) {
  const watched = !!ep.progress?.watched;
  const [markersOpen, setMarkersOpen] = useState(false);
  const pct =
    ep.progress && !watched && ep.progress.duration_seconds > 0
      ? Math.min(100, (ep.progress.position_seconds / ep.progress.duration_seconds) * 100)
      : 0;
  return (
    <div className="flex gap-4 p-3 rounded-lg bg-surface border border-cardborder hover:border-inborder transition-colors">
      <div className="relative w-40 shrink-0 aspect-video rounded-md overflow-hidden bg-raised">
        <Img src={imgUrl(ep.still)} fallbackText={`E${ep.episode}`} className="w-full h-full object-cover" />
        {ep.file && (
          <Link
            to={lp(`/play/${ep.file.id}`)}
            className="absolute inset-0 flex items-center justify-center bg-bg/40 opacity-0 hover:opacity-100 transition-opacity"
          >
            <div className="w-9 h-9 rounded-full bg-accent text-accenttext flex items-center justify-center">
              <PlayIcon className="w-4 h-4 ml-0.5" />
            </div>
          </Link>
        )}
        {pct > 0 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-track">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm text-heading font-semibold truncate">
            {ep.episode}. {ep.title ?? `Episode ${ep.episode}`}
          </span>
          {ep.air_date && <span className="text-xs text-muted shrink-0">{ep.air_date}</span>}
          {!ep.file && <span className="text-xs text-danger shrink-0">missing file</span>}
        </div>
        {ep.overview && <p className="mt-1 text-xs text-muted leading-relaxed line-clamp-2">{ep.overview}</p>}
        <button
          className="mt-1.5 text-[11px] text-muted hover:text-hint transition-colors"
          title="Edit intro/credits timestamps (auto-detected values are pre-filled)"
          onClick={() => setMarkersOpen(true)}
        >
          {ep.intro_start != null || ep.credits_start != null
            ? `intro ${ep.intro_start ?? "?"} to ${ep.intro_end ?? "?"}s · credits ${ep.credits_start ?? "?"}s · edit`
            : "set intro/credits…"}
        </button>
      </div>
      {markersOpen && <MarkerEditDialog ep={ep} onClose={() => setMarkersOpen(false)} onSaved={onChange} />}
      {onParty && ep.file && (
        <button
          title="Watch this episode together"
          onClick={() => onParty(ep.file!.id)}
          className="self-center w-8 h-8 shrink-0 rounded-full border border-inborder text-muted hover:text-body hover:bg-hov flex items-center justify-center transition-colors"
        >
          <PartyIcon />
        </button>
      )}
      <button
        title={watched ? "Mark unwatched" : "Mark watched"}
        disabled={!ep.file}
        onClick={() => post(`/episodes/${ep.id}/watched`, { watched: !watched }).then(onChange)}
        className={`self-center w-8 h-8 shrink-0 rounded-full border flex items-center justify-center transition-colors disabled:opacity-30 ${
          watched ? "bg-accent text-accenttext border-accent" : "border-inborder text-muted hover:text-body hover:bg-hov"
        }`}
      >
        <CheckIcon />
      </button>
    </div>
  );
}

function MarkerEditDialog({ ep, onClose, onSaved }: { ep: EpisodeRow; onClose: () => void; onSaved: () => void }) {
  const [introStart, setIntroStart] = useState(ep.intro_start != null ? String(ep.intro_start) : "");
  const [introEnd, setIntroEnd] = useState(ep.intro_end != null ? String(ep.intro_end) : "");
  const [credits, setCredits] = useState(ep.credits_start != null ? String(ep.credits_start) : "");
  const [err, setErr] = useState<string | null>(null);

  const save = () => {
    api(`/episodes/${ep.id}/markers`, {
      method: "PUT",
      body: JSON.stringify({ intro_start: introStart, intro_end: introEnd, credits_start: credits }),
    })
      .then(() => {
        onSaved();
        onClose();
      })
      .catch((e) => setErr(String(e.message ?? e)));
  };

  const field = (label: string, v: string, set: (s: string) => void) => (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        className={inputCls + " mt-1"}
        value={v}
        placeholder="seconds (empty = none)"
        onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ""))}
      />
    </label>
  );

  return (
    <Modal onClose={onClose}>
      <div className="p-5 space-y-3">
        <h3 className="font-display text-lg text-heading">
          Intro / credits · S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
        </h3>
        <p className="text-xs text-muted">
          Values in seconds from the start of the file. Pre-filled from automatic detection; adjust if it got them wrong.
        </p>
        {field("Intro start", introStart, setIntroStart)}
        {field("Intro end", introEnd, setIntroEnd)}
        {field("Credits start (triggers Up Next)", credits, setCredits)}
        {err && <p className="text-danger text-sm">{err}</p>}
        <div className="flex gap-2 pt-1">
          <button className={btnPrimary} onClick={save}>
            Save
          </button>
          <button className={btnGhost} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

