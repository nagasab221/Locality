import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { imgUrl, fmtTime, lp } from "../api";
import type { HomeCard, ListItem } from "../types";

/**
 * <img> that fades in once loaded. When the file is missing/broken (or src is
 * empty) it renders a text placeholder instead of an invisible box.
 */
export function Img({
  src,
  className = "",
  alt = "",
  fallbackText,
}: {
  src?: string;
  className?: string;
  alt?: string;
  fallbackText?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-full h-full flex items-center justify-center p-3 text-center bg-raised">
        {fallbackText && <span className="font-display text-muted text-sm">{fallbackText}</span>}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      ref={(el) => {
        // Cached images may already be complete before onLoad can fire.
        if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true);
      }}
      className={`img-fade ${loaded ? "loaded" : ""} ${className}`}
    />
  );
}

export const btnPrimary =
  "inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent text-accenttext text-sm font-semibold hover:bg-accenthov transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const btnGhost =
  "inline-flex items-center gap-2 px-4 py-2 rounded-md border border-inborder text-body text-sm hover:bg-hov transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const inputCls =
  "w-full px-3 py-2 rounded-md bg-input border border-inborder text-body text-sm placeholder:text-muted focus:outline-none focus:border-accent";
export const selectCls =
  "px-2.5 py-1.5 rounded-md bg-raised border border-inborder text-body text-sm focus:outline-none focus:border-accent";

export function PosterCard({
  item,
  onContextMenu,
}: {
  item: ListItem;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const watched =
    item.type === "movie"
      ? !!item.watched
      : (item.episodeCount ?? 0) > 0 && item.watchedCount === item.episodeCount;
  return (
    <Link
      to={lp(`/item/${item.id}`)}
      className="group block"
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault();
          onContextMenu(e);
        })
      }
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-raised border border-cardborder group-hover:border-accent transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-lg group-hover:shadow-black/50">
        <Img
          src={imgUrl(item.poster)}
          fallbackText={item.title}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        />
        {watched && (
          <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-accent text-accenttext flex items-center justify-center shadow">
            <CheckIcon />
          </div>
        )}
        {item.type === "show" && !watched && (item.watchedCount ?? 0) > 0 && (
          <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full bg-bg/80 border border-cardborder text-[10px] text-body">
            {item.episodeCount! - item.watchedCount!} left
          </div>
        )}
        {item.status === "needs_match" && (
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-warn/90 text-accenttext text-[10px] font-semibold" title="Needs matching">
            ?
          </div>
        )}
        {item.type === "movie" && item.inProgress && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-track">
            {/* real resume %; older remote servers don't send it — show half */}
            <div className="h-full bg-accent" style={{ width: `${item.progressPct ?? 50}%` }} />
          </div>
        )}
      </div>
      <div className="mt-1.5 px-0.5">
        <div className="text-sm text-body truncate group-hover:text-heading">{item.title}</div>
        <div className="text-xs text-muted">{item.year ?? ""}</div>
      </div>
    </Link>
  );
}

export function ContinueCard({ card }: { card: HomeCard }) {
  const pct = card.duration > 0 ? Math.min(100, (card.position / card.duration) * 100) : 0;
  return (
    <div className="w-72 shrink-0 group">
      <Link
        to={lp(`/play/${card.fileId}`)}
        className="block relative aspect-video rounded-lg overflow-hidden bg-raised border border-cardborder group-hover:border-accent transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-lg group-hover:shadow-black/50"
      >
        <Img
          src={imgUrl(card.backdrop)}
          fallbackText={card.title}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-bg/90 via-transparent opacity-90" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-accent text-accenttext flex items-center justify-center shadow-lg">
            <PlayIcon className="w-5 h-5 ml-0.5" />
          </div>
        </div>
        <div className="absolute bottom-1.5 right-2 text-[11px] text-body/90">
          {fmtTime(Math.max(0, card.duration - card.position))} left
        </div>
        <div className="absolute bottom-0 inset-x-0 h-1 bg-track">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </Link>
      <Link to={lp(`/item/${card.itemId}`)} className="block mt-1.5 px-0.5">
        <div className="text-sm text-body truncate hover:text-heading">{card.title}</div>
        <div className="text-xs text-muted truncate">{card.subtitle}</div>
      </Link>
    </div>
  );
}

export function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  // Portaled to <body> so ancestor transforms/animations can't shift it.
  return createPortal(
    <div
      className="backdrop-enter fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`modal-in ${wide ? "max-w-2xl" : "max-w-md"} w-full max-h-[85vh] overflow-y-auto rounded-xl bg-surface border border-cardborder shadow-2xl`}>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display text-xl text-heading mb-3">{children}</h2>;
}

// ---- loading skeletons ------------------------------------------------------
// Layout-shaped placeholders instead of a "Loading…" string; the pulse is
// stilled under prefers-reduced-motion (index.css).

export function SkeletonPosterGrid({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-[2/3] rounded-lg bg-raised border border-cardborder" />
          <div className="mt-2 h-3.5 w-3/4 rounded bg-raised" />
          <div className="mt-1.5 h-3 w-1/3 rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonSquareGrid({ count = 28 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="animate-pulse aspect-square rounded-md bg-raised border border-cardborder" />
      ))}
    </div>
  );
}

/** Home while /home loads: a continue-watching row and a poster row. */
export function SkeletonHome() {
  return (
    <div className="p-8 space-y-10">
      <div>
        <div className="animate-pulse h-6 w-44 rounded bg-raised mb-4" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="animate-pulse w-72 shrink-0">
              <div className="aspect-video rounded-lg bg-raised border border-cardborder" />
              <div className="mt-2 h-3.5 w-2/3 rounded bg-raised" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="animate-pulse h-6 w-56 rounded bg-raised mb-4" />
        <SkeletonPosterGrid count={7} />
      </div>
    </div>
  );
}

export function CheckIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}
