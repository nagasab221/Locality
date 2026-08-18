// OpenSubtitles search dialog for the mpv engine. mpv paints over the main
// window, so this runs in its own centered window (opened by openSubSearch() in
// electron/main.ts). It reuses the server's os-search/os-download routes — the
// same ones the built-in player uses — then loads the downloaded track into mpv
// with sub-add over the IPC bridge.
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../api";

interface OsResult {
  osFileId: number;
  language: string;
  release: string;
  downloadCount: number;
  hearingImpaired: boolean;
}

const params = new URLSearchParams(window.location.search);
const fileId = Number(params.get("file"));
const port = params.get("port") ?? "3777";

const inputCls = "px-3 h-9 rounded-md bg-raised border border-inborder text-sm text-body outline-none focus:border-accent";
const btnPrimary = "px-4 h-9 rounded-md bg-accent text-accenttext text-sm font-medium hover:bg-accenthov disabled:opacity-50 shrink-0";

export default function MpvSubSearch() {
  const [lang, setLang] = useState("");
  const [results, setResults] = useState<OsResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => void window.locality.mpv.closeSubSearch();

  const search = useCallback((language?: string) => {
    setBusy(true);
    setErr(null);
    get<OsResult[]>(`/files/${fileId}/os-search${language ? `?lang=${encodeURIComponent(language)}` : ""}`)
      .then(setResults)
      .catch((e) => { setErr(String(e?.message ?? e)); setResults([]); })
      .finally(() => setBusy(false));
  }, []);

  // Initial search uses the server's default language and the file's metadata.
  useEffect(() => search(), [search]);

  // Esc closes the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (r: OsResult) => {
    setBusy(true);
    setErr(null);
    post<{ id: number; lang: string; label: string }>(`/files/${fileId}/os-download`, {
      osFileId: r.osFileId,
      lang: r.language,
      label: r.release,
    })
      .then((sub) => {
        // mpv loads the registered track over HTTP (the vtt route converts
        // srt/ass on the fly) and selects it.
        const url = `http://127.0.0.1:${port}/api/subtitles/${sub.id}/vtt`;
        void window.locality.mpv.command(["sub-add", url, "select", sub.label || r.release, r.language]);
        close();
      })
      .catch((e) => { setErr(String(e?.message ?? e)); setBusy(false); });
  };

  return (
    <div className="h-screen w-screen bg-bg text-body flex flex-col select-none">
      <div className="flex items-center justify-between px-5 h-12 border-b border-cardborder [-webkit-app-region:drag]">
        <h3 className="font-display text-base text-heading">Search subtitles online</h3>
        <button
          className="w-8 h-8 rounded-md flex items-center justify-center text-muted hover:bg-hov hover:text-body [-webkit-app-region:no-drag]"
          title="Close (Esc)"
          onClick={close}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <div className="flex gap-2 px-5 py-3">
        <input
          className={inputCls + " flex-1"}
          placeholder="Language code (e.g. en, ar) — empty for default"
          value={lang}
          autoFocus
          onChange={(e) => setLang(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && search(lang)}
        />
        <button className={btnPrimary} onClick={() => search(lang)} disabled={busy}>Search</button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {err && <p className="text-danger text-sm mb-3 break-words">{err}</p>}
        {results === null ? (
          <p className="text-muted text-sm">Searching…</p>
        ) : results.length === 0 && !err ? (
          <p className="text-muted text-sm">No results. Set an OpenSubtitles API key in Settings, or try a different language.</p>
        ) : (
          <div className="space-y-1.5">
            {results.map((r) => (
              <button
                key={r.osFileId}
                disabled={busy}
                onClick={() => pick(r)}
                className="w-full text-left px-3 py-2 rounded-md border border-cardborder hover:border-accent hover:bg-raised transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <span className="px-1.5 py-0.5 rounded bg-raised border border-inborder text-[10px] uppercase text-hint shrink-0">{r.language}</span>
                <span className="text-sm text-body truncate flex-1">{r.release}</span>
                <span className="text-[11px] text-muted shrink-0">{r.downloadCount}↓{r.hearingImpaired ? " · HI" : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
