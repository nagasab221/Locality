import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { del, get } from "../api";
import type { ListItem } from "../types";
import { PosterCard, btnGhost } from "../components/ui";

interface CollectionData {
  key: string;
  name: string;
  manual: boolean;
  id?: number;
  total: number | null; // TMDB box sets: how many parts exist overall
  items: ListItem[];
}

export default function CollectionPage() {
  const { key } = useParams();
  const [data, setData] = useState<CollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<CollectionData>(`/collections/${key}`)
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, [key]);

  useEffect(load, [load]);

  if (error) return <div className="p-8 text-danger">{error}</div>;
  if (!data) return <div className="p-8 text-muted">Loading…</div>;

  const watched = data.items.filter((it) =>
    it.type === "movie" ? it.watched : (it.episodeCount ?? 0) > 0 && it.watchedCount === it.episodeCount
  ).length;

  return (
    <div className="p-8">
      <div className="flex items-end gap-4 mb-6 flex-wrap">
        <h1 className="font-display text-2xl text-heading">{data.name}</h1>
        <span className="text-sm text-muted pb-0.5">
          {data.total ? `${data.items.length} of ${data.total} owned · ` : `${data.items.length} in library · `}
          {watched} watched
        </span>
        {data.manual && data.id != null && (
          <button
            className={btnGhost + " !px-3 !py-1 ml-auto"}
            onClick={() => {
              if (confirm(`Delete collection "${data.name}"? Items stay in the library.`)) {
                del(`/collections/${data.id}`).then(() => history.back());
              }
            }}
          >
            Delete collection
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
        {data.items.map((it) => (
          <PosterCard key={it.id} item={it} />
        ))}
      </div>
    </div>
  );
}
