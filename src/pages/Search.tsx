import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { get } from "../api";
import type { ListItem } from "../types";
import { PosterCard } from "../components/ui";

type Result = ListItem & { libraryId: number; libraryName: string };

/** Whole-catalog search results (all libraries), reached from the sidebar box. */
export default function Search() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setBusy(true);
    let alive = true;
    get<Result[]>(`/search?q=${encodeURIComponent(q)}`)
      .then((r) => alive && setResults(r))
      .catch(() => alive && setResults([]))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [q]);

  return (
    <div className="p-8">
      <h2 className="font-display text-2xl text-heading mb-1">Search</h2>
      <p className="text-sm text-muted mb-6">
        {q.length < 2 ? "Type at least two letters." : busy ? "Searching…" : `Results for “${q}”`}
      </p>

      {results && results.length === 0 && q.length >= 2 && !busy && (
        <p className="text-muted">Nothing matched. Check the spelling, or the title may not be in a library yet.</p>
      )}

      {results && results.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {results.map((it) => (
            <div key={it.id}>
              <PosterCard item={it} />
              <div className="mt-1 text-[11px] text-muted truncate">{it.libraryName}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
