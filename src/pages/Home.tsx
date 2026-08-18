import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, subscribe } from "../api";
import type { HomeCard, Library, ListItem } from "../types";
import { ContinueCard, PosterCard, SectionTitle, SkeletonHome, btnPrimary } from "../components/ui";
import { ContextMenu } from "../components/ContextMenu";

interface HomeData {
  continueWatching: HomeCard[];
  recentlyAdded: { library: Library; items: ListItem[] }[];
  watchlist: ListItem[];
}

export default function Home() {
  const [data, setData] = useState<HomeData | null>(null);
  const [err, setErr] = useState(false);
  const [cwMenu, setCwMenu] = useState<{ x: number; y: number; card: HomeCard } | null>(null);

  const load = useCallback(() => {
    get<HomeData>("/home")
      .then((d) => {
        setData(d);
        setErr(false);
      })
      .catch(() => setErr(true));
  }, []);

  useEffect(() => {
    load();
    const subs = [
      subscribe("ledger-merged", load),
      subscribe("library-changed", load),
      subscribe("player", (s) => {
        if (!s.active) load(); // refresh Continue Watching when playback stops
      }),
    ];
    return () => subs.forEach((u) => u());
  }, [load]);

  if (!data)
    return err ? (
      <div className="p-8 mt-24 text-center space-y-3">
        <p className="text-muted text-sm">Couldn't load your home screen.</p>
        <button className={btnPrimary} onClick={load}>Try again</button>
      </div>
    ) : (
      <SkeletonHome />
    );

  const empty = data.recentlyAdded.length === 0;

  return (
    <div className="p-8 space-y-10">
      {empty && (
        <div className="max-w-lg mx-auto mt-24 text-center space-y-4">
          <h1 className="font-display text-3xl text-heading">Welcome to Locality</h1>
          <p className="text-muted text-sm leading-relaxed">
            Add a Movies or TV Shows library in Settings to get started.
          </p>
          <Link to="/settings" className={btnPrimary}>
            Open Settings
          </Link>
        </div>
      )}

      {data.continueWatching.length > 0 && (
        <section>
          <SectionTitle>Continue Watching</SectionTitle>
          <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
            {data.continueWatching.map((c) => (
              <div
                key={c.fileId}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCwMenu({ x: e.clientX, y: e.clientY, card: c });
                }}
              >
                <ContinueCard card={c} />
              </div>
            ))}
          </div>
        </section>
      )}

      {cwMenu && (
        <ContextMenu
          x={cwMenu.x}
          y={cwMenu.y}
          onClose={() => setCwMenu(null)}
          entries={[
            {
              label: "Mark watched",
              onClick: () => {
                post(`/files/${cwMenu.card.fileId}/watched`, { watched: true }).then(load).catch(() => {});
              },
            },
            {
              label: "Remove from Continue Watching",
              danger: true,
              onClick: () => {
                // Clearing the resume position drops it from the row without marking it watched.
                post("/player/progress", { fileId: cwMenu.card.fileId, position: 0, duration: cwMenu.card.duration }).then(load).catch(() => {});
              },
            },
          ]}
        />
      )}

      {data.watchlist.length > 0 && (
        <section>
          <SectionTitle>Watchlist</SectionTitle>
          <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
            {data.watchlist.map((it) => (
              <div key={it.id} className="w-36 shrink-0">
                <PosterCard item={it} />
              </div>
            ))}
          </div>
        </section>
      )}

      {data.recentlyAdded.map(
        ({ library, items }) =>
          items.length > 0 && (
            <section key={library.id}>
              <div className="flex items-baseline justify-between mb-3">
                <SectionTitle>Recently Added in {library.name}</SectionTitle>
                <Link to={`/library/${library.id}`} className="text-xs text-hint hover:text-accent">
                  See all →
                </Link>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                {items.slice(0, 8).map((it) => (
                  <PosterCard key={it.id} item={it} />
                ))}
              </div>
            </section>
          )
      )}
    </div>
  );
}
