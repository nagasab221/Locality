import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { get, post, subscribe, lp, isRemoteActive } from "../api";
import type { Library, ListItem } from "../types";
import { PosterCard, SkeletonPosterGrid, btnGhost, selectCls } from "../components/ui";
import { ContextMenu, type MenuEntry } from "../components/ContextMenu";
import { MatchDialog } from "../components/MatchDialog";
import { CollectionPickDialog, type CollectionCard } from "../components/CollectionPickDialog";
import { Img } from "../components/ui";
import { Link } from "react-router-dom";
import { imgUrl } from "../api";
import { Spinner } from "../App";
import GalleryPage from "./Gallery";

type SortKey = "title" | "year" | "added";
type WatchFilter = "all" | "unwatched" | "watched" | "inprogress" | "hidden";

export default function LibraryPage() {
  const { id } = useParams();
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [genre, setGenre] = useState("all");
  const [year, setYear] = useState("all");
  const [watch, setWatch] = useState<WatchFilter>("all");
  const [scanning, setScanning] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; item: ListItem } | null>(null);
  const [matchItem, setMatchItem] = useState<ListItem | null>(null);
  const [collectItem, setCollectItem] = useState<ListItem | null>(null);
  const [collections, setCollections] = useState<CollectionCard[]>([]);
  const navigate = useNavigate();

  const load = useCallback(() => {
    if (!id) return;
    get<ListItem[]>(`/libraries/${id}/items`).then(setItems).catch(() => setItems([]));
    get<CollectionCard[]>("/collections").then(setCollections).catch(() => setCollections([]));
    get("/state").then((s) => {
      const lib = s.libraries.find((l: Library) => l.id === +id);
      setLibrary(lib ?? null);
      setScanning(!!lib?.scanning);
    });
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    const subs = [
      subscribe("library-changed", (d) => {
        if (d.libraryId === Number(id)) load();
      }),
      subscribe("item-changed", load),
      subscribe("scan", (d) => {
        if (d.libraryId === Number(id)) setScanning(d.phase !== "done" && d.phase !== "error");
      }),
    ];
    return () => subs.forEach((u) => u());
  }, [id, load]);

  const genres = useMemo(() => {
    const g = new Set<string>();
    items?.forEach((it) => it.genres.forEach((x) => g.add(x)));
    return [...g].sort();
  }, [items]);

  const years = useMemo(() => {
    const y = new Set<number>();
    items?.forEach((it) => it.year && y.add(it.year));
    return [...y].sort((a, b) => b - a);
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    let out = items.filter((it) => {
      // Hidden items only appear under the explicit "Hidden" filter.
      if (watch === "hidden") {
        if (!it.hidden) return false;
      } else if (it.hidden) return false;
      if (q && !it.title.toLowerCase().includes(q) && String(it.year ?? "") !== q) return false;
      if (genre !== "all" && !it.genres.includes(genre)) return false;
      if (year !== "all" && it.year !== +year) return false;
      if (watch !== "all" && watch !== "hidden") {
        const watched = it.type === "movie" ? !!it.watched : (it.episodeCount ?? 0) > 0 && it.watchedCount === it.episodeCount;
        const inProgress = it.type === "movie" ? !!it.inProgress : (it.watchedCount ?? 0) > 0 && !watched;
        if (watch === "watched" && !watched) return false;
        if (watch === "unwatched" && watched) return false;
        if (watch === "inprogress" && !inProgress) return false;
      }
      return true;
    });
    out = [...out].sort((a, b) => {
      if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
      if (sort === "added") return b.added_at.localeCompare(a.added_at);
      return a.title.localeCompare(b.title);
    });
    return out;
  }, [items, query, genre, year, watch, sort]);

  // Photo/clip libraries get their own grid + lightbox. ("Other" libraries hold
  // movie-shaped items, so they reuse the poster grid below unchanged.)
  if (library?.type === "gallery") return <GalleryPage library={library} />;

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="font-display text-2xl text-heading mr-auto flex items-center gap-3">
          {library?.name ?? "Library"}
          {scanning && <Spinner />}
        </h1>
        <div className="relative">
          <svg
            className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            className="pl-8 pr-7 py-1.5 w-52 rounded-md bg-input border border-inborder text-body text-sm placeholder:text-muted focus:outline-none focus:border-accent"
            placeholder="Search this library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {query && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-body"
              onClick={() => setQuery("")}
              title="Clear"
            >
              ×
            </button>
          )}
        </div>
        <select className={selectCls} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="title">Sort: Title</option>
          <option value="year">Sort: Year</option>
          <option value="added">Sort: Recently added</option>
        </select>
        <select className={selectCls} value={genre} onChange={(e) => setGenre(e.target.value)}>
          <option value="all">All genres</option>
          {genres.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select className={selectCls} value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select className={selectCls} value={watch} onChange={(e) => setWatch(e.target.value as WatchFilter)}>
          <option value="all">All</option>
          <option value="unwatched">Unwatched</option>
          <option value="watched">Watched</option>
          <option value="inprogress">In progress</option>
          <option value="hidden">Hidden</option>
        </select>
        <button
          className={btnGhost}
          title="Surprise me (random unwatched title)"
          onClick={() => {
            const pool = (items ?? []).filter((it) => {
              if (it.hidden) return false;
              const watched =
                it.type === "movie" ? !!it.watched : (it.episodeCount ?? 0) > 0 && it.watchedCount === it.episodeCount;
              return !watched;
            });
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (pick) navigate(lp(`/item/${pick.id}`));
          }}
        >
          🎲
        </button>
        <button
          className={btnGhost}
          disabled={scanning}
          onClick={() => {
            setScanning(true);
            post(`/libraries/${id}/scan`).catch(() => setScanning(false));
          }}
        >
          Rescan
        </button>
      </div>

      {/* Collections / box sets */}
      {collections.length > 0 && watch !== "hidden" && !query && (
        <div className="mb-7">
          <div className="text-[11px] uppercase tracking-widest text-muted mb-2">Collections</div>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {collections.map((c) => (
              <Link
                key={c.key}
                to={lp(`/collection/${c.key}`)}
                className="group w-40 shrink-0 rounded-lg bg-surface border border-cardborder hover:border-accent transition-colors overflow-hidden"
              >
                <div className="aspect-video bg-raised">
                  <Img src={imgUrl(c.poster)} fallbackText={c.name} className="w-full h-full object-cover" />
                </div>
                <div className="px-2.5 py-2">
                  <div className="text-xs text-body truncate group-hover:text-heading">{c.name}</div>
                  <div className="text-[11px] text-muted">{c.count} titles</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {items === null ? (
        <SkeletonPosterGrid />
      ) : filtered.length === 0 ? (
        <div className="text-muted text-sm mt-12 text-center">
          {items.length === 0 ? "Nothing here yet. The scan may still be running, or the folder has no video files." : "No items match the current filters."}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
          {filtered.map((it) => (
            <PosterCard
              key={it.id}
              item={it}
              onContextMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, item: it })}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.item)} onClose={() => setMenu(null)} />
      )}
      {matchItem && (
        <MatchDialog item={matchItem} onClose={() => setMatchItem(null)} onMatched={load} />
      )}
      {collectItem && (
        <CollectionPickDialog item={collectItem} onClose={() => setCollectItem(null)} onDone={load} />
      )}
    </div>
  );

  /** Resolve the first playable file of an item (movie file or first episode). */
  async function firstFile(item: ListItem): Promise<{ id: number; path: string } | null> {
    const d = await get(`/items/${item.id}`);
    if (item.type === "movie") return d.files?.[0] ?? null;
    for (const s of d.seasons ?? []) {
      for (const ep of s.episodes) if (ep.file) return ep.file;
    }
    return null;
  }

  function menuEntries(item: ListItem): MenuEntry[] {
    const watched =
      item.type === "movie" ? !!item.watched : (item.episodeCount ?? 0) > 0 && item.watchedCount === item.episodeCount;
    const entries: MenuEntry[] = [];

    if (item.type === "movie") {
      entries.push({
        label: "Play",
        onClick: () => void firstFile(item).then((f) => f && navigate(lp(`/play/${f.id}`))),
      });
    }
    entries.push(
      { label: "Match…", onClick: () => setMatchItem(item) },
      {
        label: watched ? "Mark unwatched" : "Mark watched",
        onClick: () => void post(`/items/${item.id}/watched`, { watched: !watched }).then(load).catch(() => {}),
      },
      {
        label: "Refresh metadata",
        onClick: () => void post(`/items/${item.id}/refresh`).then(load).catch(() => {}),
      },
      { label: "Add to collection…", onClick: () => setCollectItem(item) }
    );
    // "Show file location" only makes sense for the local server — the path
    // lives on the remote machine when browsing a connected server.
    if (!isRemoteActive()) {
      entries.push({
        label: "Show file location",
        onClick: () =>
          void firstFile(item).then((f) => f && window.locality.showInFolder(f.path)).catch(() => {}),
      });
    }
    if (item.hidden) {
      entries.push({
        label: "Restore to library",
        onClick: () => void post(`/items/${item.id}/hidden`, { hidden: false }).then(load).catch(() => {}),
      });
    } else {
      entries.push({
        label: "Remove from library",
        danger: true,
        onClick: () => {
          if (
            confirm(
              `Remove "${item.title}" from the library?\n\nThe video file on disk is NOT deleted. ` +
                `You can bring it back via the "Hidden" filter → Restore to library.`
            )
          ) {
            void post(`/items/${item.id}/hidden`, { hidden: true }).then(load).catch(() => {});
          }
        },
      });
    }
    return entries;
  }
}
