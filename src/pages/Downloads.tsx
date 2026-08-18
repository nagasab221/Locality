import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, del, imgUrl, fmtSize, subscribe } from "../api";
import { btnGhost, Img } from "../components/ui";

interface Download {
  id: number;
  title: string;
  type: "movie" | "show";
  year: number | null;
  poster: string | null;
  mediaItemId: number | null;
  sourceName: string;
  status: "downloading" | "complete" | "error";
  totalBytes: number;
  doneBytes: number;
  error: string | null;
  percent: number;
}

/** Content pulled from other servers onto this PC. Downloaded items are ordinary
 *  local items, so a complete one links straight to its normal detail page. */
export default function Downloads() {
  const [downloads, setDownloads] = useState<Download[] | null>(null);

  const load = () => get<Download[]>("/downloads").then(setDownloads).catch(() => setDownloads([]));
  useEffect(() => {
    load();
    // The server pushes a "download" event per job on each progress tick.
    return subscribe("download", () => load());
  }, []);

  const remove = (d: Download) => {
    if (!confirm(`Delete “${d.title}” and its downloaded files from this PC?`)) return;
    del(`/downloads/${d.id}`).then(load).catch(() => {});
  };

  return (
    <div className="p-8">
      <h2 className="font-display text-2xl text-heading mb-1">Downloads</h2>
      <p className="text-sm text-muted mb-6">Movies and shows saved from other servers. They play here even offline.</p>

      {downloads && downloads.length === 0 && (
        <p className="text-muted">
          Nothing downloaded yet. Connect to another server, open a movie or show, and use Download.
        </p>
      )}

      <div className="space-y-3 max-w-3xl">
        {(downloads ?? []).map((d) => {
          const body = (
            <div className="flex gap-4 p-3 rounded-lg bg-surface border border-cardborder">
              <div className="w-16 shrink-0 aspect-[2/3] rounded overflow-hidden bg-raised border border-cardborder">
                <Img src={imgUrl(d.poster)} fallbackText={d.title} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-body truncate">
                  {d.title}
                  {d.year ? <span className="text-muted"> ({d.year})</span> : null}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {d.type === "show" ? "Series" : "Movie"} · from {d.sourceName || "another server"}
                </div>
                <div className="mt-2">
                  {d.status === "complete" ? (
                    <span className="text-xs text-ok">Downloaded{d.totalBytes ? ` · ${fmtSize(d.totalBytes)}` : ""}</span>
                  ) : d.status === "error" ? (
                    <span className="text-xs text-danger">{d.error || "Download failed"}</span>
                  ) : (
                    <>
                      <div className="h-1.5 rounded-full bg-track overflow-hidden">
                        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${d.percent}%` }} />
                      </div>
                      <div className="text-[11px] text-muted mt-1">
                        {d.percent}% · {fmtSize(d.doneBytes)}
                        {d.totalBytes ? ` / ${fmtSize(d.totalBytes)}` : ""}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <button
                className="self-start text-danger hover:opacity-80 text-xs px-1"
                onClick={(e) => {
                  e.preventDefault();
                  remove(d);
                }}
              >
                Delete
              </button>
            </div>
          );
          // A finished download is a normal local item; link to it. In-progress
          // ones aren't playable yet, so they're not links.
          return d.status === "complete" && d.mediaItemId ? (
            <Link key={d.id} to={`/item/${d.mediaItemId}`} className="block hover:opacity-95">
              {body}
            </Link>
          ) : (
            <div key={d.id}>{body}</div>
          );
        })}
      </div>
    </div>
  );
}
