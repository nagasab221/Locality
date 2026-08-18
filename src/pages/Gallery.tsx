import { useCallback, useEffect, useMemo, useState } from "react";
import { get, subscribe, sourceBase, sourceToken } from "../api";
import type { Library } from "../types";
import { selectCls, SkeletonSquareGrid } from "../components/ui";
import { Spinner } from "../App";

interface GItem {
  id: number;
  filename: string;
  kind: "photo" | "video";
  folder: string;
  taken_at: string | null;
}

const tok = () => {
  const t = sourceToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
};
const thumbUrl = (id: number) => `${sourceBase()}/gallery/thumb/${id}${tok()}`;
const fullUrl = (id: number) => `${sourceBase()}/gallery/full/${id}${tok()}`;

type GallerySort = "albums" | "newest" | "oldest" | "nameAsc" | "nameDesc";
type GalleryFilter = "all" | "photo" | "video";

const pref = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};

/** Photo/clip library view: sortable grid of thumbnails with a lightbox. */
export default function GalleryPage({ library }: { library: Library }) {
  const [items, setItems] = useState<GItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null); // index into `visible`
  // Each library remembers its own view (a camera dump wants dates, a
  // wallpaper folder wants names).
  const [sort, setSortState] = useState(() => pref(`locality.gallery.sort.${library.id}`, "albums") as GallerySort);
  const [filter, setFilterState] = useState(() => pref(`locality.gallery.filter.${library.id}`, "all") as GalleryFilter);

  useEffect(() => {
    setSortState(pref(`locality.gallery.sort.${library.id}`, "albums") as GallerySort);
    setFilterState(pref(`locality.gallery.filter.${library.id}`, "all") as GalleryFilter);
  }, [library.id]);

  const setSort = (v: GallerySort) => {
    setSortState(v);
    try {
      localStorage.setItem(`locality.gallery.sort.${library.id}`, v);
    } catch {}
  };
  const setFilter = (v: GalleryFilter) => {
    setFilterState(v);
    try {
      localStorage.setItem(`locality.gallery.filter.${library.id}`, v);
    } catch {}
  };

  const load = useCallback(() => {
    get<GItem[]>(`/gallery/${library.id}`).then(setItems).catch(() => setItems([]));
  }, [library.id]);

  useEffect(load, [load]);
  useEffect(() => {
    const subs = [
      subscribe("library-changed", (d) => d.libraryId === library.id && load()),
      subscribe("scan", (d) => d.libraryId === library.id && setScanning(d.phase !== "done" && d.phase !== "error")),
    ];
    return () => subs.forEach((u) => u());
  }, [library.id, load]);

  // Natural order so IMG_9 sorts before IMG_10.
  const byName = (a: GItem, b: GItem) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" });

  // The lightbox pages through `visible`, so arrows always follow what's shown.
  const visible = useMemo(() => {
    let list = items ?? [];
    if (filter !== "all") list = list.filter((it) => it.kind === filter);
    const sorted = [...list];
    switch (sort) {
      case "newest":
        sorted.sort((a, b) => (b.taken_at ?? "").localeCompare(a.taken_at ?? "") || byName(a, b));
        break;
      case "oldest":
        sorted.sort((a, b) => (a.taken_at ?? "").localeCompare(b.taken_at ?? "") || byName(a, b));
        break;
      case "nameAsc":
        sorted.sort(byName);
        break;
      case "nameDesc":
        sorted.sort((a, b) => byName(b, a));
        break;
      default: // albums
        sorted.sort((a, b) => a.folder.localeCompare(b.folder) || byName(a, b));
    }
    return sorted;
  }, [items, sort, filter]);

  // Section headers: album folders, months, or none for the name sorts. The
  // list is already sorted by the grouping key, so equal labels are contiguous.
  const groups = useMemo(() => {
    const labelFor = (it: GItem): string => {
      if (sort === "albums") return it.folder;
      if (sort === "newest" || sort === "oldest") {
        const d = it.taken_at ? new Date(it.taken_at) : null;
        return d && !isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Unknown date";
      }
      return "";
    };
    const out: { label: string; entries: { item: GItem; index: number }[] }[] = [];
    visible.forEach((item, index) => {
      const label = labelFor(item);
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, entries: [] });
      out[out.length - 1].entries.push({ item, index });
    });
    return out;
  }, [visible, sort]);

  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="font-display text-2xl text-heading mr-auto flex items-center gap-3">
          {library.name}
          {scanning && <Spinner />}
        </h1>
        <select className={selectCls} title="Sort" value={sort} onChange={(e) => setSort(e.target.value as GallerySort)}>
          <option value="albums">Albums</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="nameAsc">Name A to Z</option>
          <option value="nameDesc">Name Z to A</option>
        </select>
        <select className={selectCls} title="Show" value={filter} onChange={(e) => setFilter(e.target.value as GalleryFilter)}>
          <option value="all">All</option>
          <option value="photo">Photos</option>
          <option value="video">Videos</option>
        </select>
        <span className="text-sm text-muted">{visible.length} items</span>
      </div>

      {items === null ? (
        <SkeletonSquareGrid />
      ) : visible.length === 0 ? (
        <div className="text-muted text-sm mt-12 text-center">
          {items.length === 0
            ? "Nothing here yet. The scan may still be running, or the folder has no photos or videos."
            : "Nothing matches this filter."}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label || "_root"} className="mb-8">
            {g.label && <div className="text-[11px] uppercase tracking-widest text-muted mb-2">{g.label}</div>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
              {g.entries.map(({ item, index }) => (
                <button
                  key={item.id}
                  className="relative aspect-square rounded-md overflow-hidden bg-raised border border-cardborder hover:border-accent transition-colors group"
                  onClick={() => setLightbox(index)}
                  title={item.filename}
                >
                  <img
                    src={thumbUrl(item.id)}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                    onError={(e) => ((e.currentTarget.style.opacity = "0.2"))}
                  />
                  {item.kind === "video" && (
                    <span className="absolute bottom-1 right-1 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))
      )}

      {lightbox !== null && visible[lightbox] && (
        <Lightbox
          items={visible}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: GItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const prev = () => onIndex((index - 1 + items.length) % items.length);
  const next = () => onIndex((index + 1) % items.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center" onClick={onClose}>
      <button className="absolute top-4 right-5 text-white/70 hover:text-white text-3xl leading-none" onClick={onClose}>
        ×
      </button>
      {items.length > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white text-5xl leading-none px-3"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
          >
            ‹
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/60 hover:text-white text-5xl leading-none px-3"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
          >
            ›
          </button>
        </>
      )}
      <div className="max-w-[92vw] max-h-[92vh]" onClick={(e) => e.stopPropagation()}>
        {item.kind === "video" ? (
          <video src={fullUrl(item.id)} controls autoPlay className="max-w-[92vw] max-h-[92vh] rounded" />
        ) : (
          <img src={fullUrl(item.id)} className="max-w-[92vw] max-h-[92vh] object-contain rounded" alt={item.filename} />
        )}
        <div className="text-center text-white/50 text-xs mt-2">{item.filename}</div>
      </div>
    </div>
  );
}
