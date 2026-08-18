import { useState } from "react";
import { post } from "../api";
import { btnGhost, btnPrimary, inputCls } from "./ui";

type LibType = "movies" | "tv" | "gallery" | "other";

const TYPES: { key: LibType; label: string; hint: string; icon: JSX.Element }[] = [
  { key: "movies", label: "Movies", hint: "Films, one file each", icon: <FilmIcon /> },
  { key: "tv", label: "TV Shows", hint: "Series with seasons & episodes", icon: <TvIcon /> },
  { key: "gallery", label: "Photos", hint: "Pictures and short clips", icon: <PhotoIcon /> },
  { key: "other", label: "Other Videos", hint: "Home videos, anything else", icon: <BoxIcon /> },
];

/**
 * First-run flow: pick a library type, choose a folder, name it, scan. Shown when
 * there are no libraries yet (see App's `showOnboarding`). A skip lets the user
 * explore an empty app instead.
 */
export default function Onboarding({ onDone }: { onDone: (added: boolean) => void }) {
  const [type, setType] = useState<LibType>("movies");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = (t: LibType) => {
    setType(t);
    if (!name.trim()) setName(TYPES.find((x) => x.key === t)!.label);
  };

  const choose = async () => {
    const p = await window.locality.chooseFolder();
    if (p) {
      setFolder(p);
      if (!name.trim()) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };

  const create = () => {
    setBusy(true);
    setErr(null);
    post("/libraries", { name: (name.trim() || TYPES.find((x) => x.key === type)!.label), type, path: folder })
      .then(() => onDone(true))
      .catch((e) => {
        setErr(String(e.message ?? e));
        setBusy(false);
      });
  };

  return (
    <div className="fixed inset-0 z-[100] bg-bg flex items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-xl">
        <h1 className="font-display text-3xl text-heading text-center">Welcome to Locality</h1>
        <p className="text-sm text-muted text-center mt-2 mb-8">
          Point it at a folder on your machine and it builds a library. Let's add your first one.
        </p>

        <div className="grid grid-cols-2 gap-3 mb-6">
          {TYPES.map((t) => (
            <button
              key={t.key}
              className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                type === t.key ? "border-accent bg-accent/10" : "border-cardborder bg-surface hover:border-accent/50"
              }`}
              onClick={() => pick(t.key)}
            >
              <span className={type === t.key ? "text-accent" : "text-muted"}>{t.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm text-heading">{t.label}</span>
                <span className="block text-[11px] text-muted truncate">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="space-y-3 p-4 rounded-lg bg-surface border border-cardborder">
          <div className="flex gap-3 items-center">
            <button className={btnGhost} onClick={choose}>
              Choose folder…
            </button>
            <span className="text-xs text-muted truncate flex-1">{folder || "No folder selected"}</span>
          </div>
          <input className={inputCls} placeholder="Library name" value={name} onChange={(e) => setName(e.target.value)} />
          {err && <p className="text-danger text-sm">{err}</p>}
          <button className={btnPrimary + " w-full"} disabled={busy || !folder} onClick={create}>
            {busy ? "Adding…" : "Add library"}
          </button>
        </div>

        <div className="text-center mt-6">
          <button className="text-xs text-muted hover:text-body" onClick={() => onDone(false)}>
            I'll explore first
          </button>
        </div>
      </div>
    </div>
  );
}

function FilmIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}
function TvIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="m8 2 4 4 4-4" />
    </svg>
  );
}
function PhotoIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
