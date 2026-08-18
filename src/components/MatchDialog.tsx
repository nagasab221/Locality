import { useCallback, useEffect, useState } from "react";
import { get, post } from "../api";
import { btnPrimary, inputCls, Modal } from "./ui";

/** Minimal item shape the dialog needs — works for grid items and detail pages. */
export interface MatchTarget {
  id: number;
  title: string;
  year: number | null;
  type: "movie" | "show";
  provider?: string;
}

const PROVIDERS: { id: string; label: string; note: string; tvOnly?: boolean }[] = [
  { id: "tmdb", label: "TMDB", note: "movies & TV (needs API key)" },
  { id: "tvmaze", label: "TVmaze", note: "TV & anime (no key)", tvOnly: true },
  { id: "anilist", label: "AniList", note: "anime (no key)" },
];

export function MatchDialog({ item, onClose, onMatched }: { item: MatchTarget; onClose: () => void; onMatched: () => void }) {
  const [q, setQ] = useState(item.title);
  const [year, setYear] = useState(item.year ? String(item.year) : "");
  const [provider, setProvider] = useState<string>(item.provider ?? "tmdb");
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const type = item.type === "movie" ? "movie" : "tv";
  const providers = PROVIDERS.filter((p) => !(p.tvOnly && type === "movie"));

  const search = useCallback(
    (prov?: string) => {
      setBusy(true);
      setErr(null);
      setResults(null);
      get(
        `/search-meta?provider=${prov ?? provider}&q=${encodeURIComponent(q)}&type=${type}${year ? `&year=${year}` : ""}`
      )
        .then(setResults)
        .catch((e) => setErr(String(e.message ?? e)))
        .finally(() => setBusy(false));
    },
    [q, year, type, provider]
  );

  useEffect(() => search(), []); // initial search with parsed title

  const pick = (providerId: number) => {
    setBusy(true);
    post(`/items/${item.id}/match`, { provider, providerId })
      .then(() => {
        onMatched();
        onClose();
      })
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-5">
        <h3 className="font-display text-xl text-heading mb-4">Match “{item.title}”</h3>
        <div className="flex gap-2 mb-2">
          {providers.map((p) => (
            <button
              key={p.id}
              title={p.note}
              onClick={() => {
                setProvider(p.id);
                search(p.id);
              }}
              className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                provider === p.id
                  ? "bg-accent text-accenttext border-accent font-semibold"
                  : "border-inborder text-body hover:bg-hov"
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className="text-[11px] text-muted self-center ml-1">
            {providers.find((p) => p.id === provider)?.note}
          </span>
        </div>
        <div className="flex gap-2 mb-4">
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Search…" />
          <input className={inputCls + " !w-24"} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} placeholder="Year" />
          <button className={btnPrimary} onClick={() => search()} disabled={busy || !q.trim()}>
            Search
          </button>
        </div>
        {err && <p className="text-danger text-sm mb-3">{err}</p>}
        {results === null && !err ? (
          <p className="text-muted text-sm">Searching…</p>
        ) : results && results.length === 0 ? (
          <p className="text-muted text-sm">
            No results. Try another provider tab or adjust the search text.
            {provider === "tmdb" && " (TMDB needs an API key in Settings; TVmaze and AniList work without one.)"}
          </p>
        ) : (
          <div className="space-y-2">
            {(results ?? []).map((r) => (
              <button
                key={r.providerId}
                onClick={() => pick(r.providerId)}
                disabled={busy}
                className="w-full text-left p-3 rounded-lg border border-cardborder hover:border-accent hover:bg-raised transition-colors"
              >
                <div className="text-sm text-heading font-semibold">
                  {r.title} {r.year && <span className="text-muted font-normal">({r.year})</span>}
                </div>
                {r.overview && <p className="text-xs text-muted mt-1 line-clamp-2">{r.overview}</p>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
