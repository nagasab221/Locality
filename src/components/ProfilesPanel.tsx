import { useEffect, useState } from "react";
import { get, post, put, del } from "../api";
import type { Profile } from "../types";
import { btnGhost, btnPrimary, inputCls, SectionTitle } from "./ui";

// A small, calm palette for avatars — all legible against dark text.
const COLORS = ["#C4A47C", "#7FA6C9", "#A88BC4", "#7BB08A", "#D08C6E", "#C97B92", "#C9B36B", "#8FB0A6"];

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-muted">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** Manage household profiles (Settings). Each profile has its own Continue
 *  Watching and watched history; switching happens from the sidebar. */
export function ProfilesPanel({ toast }: { toast: (text: string, tone?: "info" | "error" | "ok") => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[1]);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [pwFor, setPwFor] = useState<Profile | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => get<Profile[]>("/profiles").then(setProfiles).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const add = () => {
    if (!name.trim()) return;
    setBusy(true);
    post("/profiles", { name: name.trim(), color })
      .then(() => {
        setName("");
        setColor(COLORS[(profiles.length + 1) % COLORS.length]);
        toast("Profile added", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  const saveEdit = () => {
    if (!editing) return;
    setBusy(true);
    put(`/profiles/${editing.id}`, { name: editing.name, color: editing.color })
      .then(() => {
        setEditing(null);
        toast("Profile updated", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  const remove = (p: Profile) => {
    if (!confirm(`Remove the profile “${p.name}”? Its watch history is deleted. Your files are untouched.`)) return;
    del(`/profiles/${p.id}`)
      .then(() => {
        toast("Profile removed", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"));
  };

  const savePassword = () => {
    if (!pwFor) return;
    setBusy(true);
    put(`/profiles/${pwFor.id}/password`, { password: pw })
      .then(() => {
        setPwFor(null);
        setPw("");
        toast("Password set", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"))
      .finally(() => setBusy(false));
  };

  const clearPassword = (p: Profile) => {
    put(`/profiles/${p.id}/password`, { password: "" })
      .then(() => {
        toast("Password removed", "ok");
        load();
      })
      .catch((e) => toast(String(e.message ?? e), "error"));
  };

  const swatches = (value: string, onPick: (c: string) => void) => (
    <div className="flex flex-wrap gap-1.5">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`w-6 h-6 rounded-full transition-transform ${value === c ? "ring-2 ring-offset-2 ring-offset-surface ring-white/70 scale-110" : "hover:scale-110"}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
          aria-label={`colour ${c}`}
        />
      ))}
    </div>
  );

  return (
    <section className="space-y-3">
      <SectionTitle>Profiles</SectionTitle>
      <p className="text-xs text-muted leading-relaxed">
        Give everyone in the house their own Continue Watching and watched history. Switch profiles from the top of the
        sidebar. Your main profile is the one that syncs across your devices.
      </p>

      <div className="space-y-2">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-surface border border-cardborder">
            <span
              className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-semibold text-accenttext"
              style={{ background: p.color }}
            >
              {(p.name.trim()[0] ?? "?").toUpperCase()}
            </span>
            {editing?.id === p.id ? (
              <div className="flex-1 space-y-2">
                <input
                  className={inputCls}
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                {swatches(editing.color, (c) => setEditing({ ...editing, color: c }))}
                <div className="flex gap-2">
                  <button className={btnPrimary + " !py-1 text-xs"} onClick={saveEdit} disabled={busy}>
                    Save
                  </button>
                  <button className={btnGhost + " !py-1 text-xs"} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : pwFor?.id === p.id ? (
              <div className="flex-1 space-y-2">
                <div className="text-xs text-muted">{p.locked ? "New password" : `Set a password for ${p.name}`}</div>
                <input
                  className={inputCls}
                  type="password"
                  autoFocus
                  placeholder="Password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && savePassword()}
                />
                <div className="flex gap-2">
                  <button className={btnPrimary + " !py-1 text-xs"} onClick={savePassword} disabled={busy || !pw}>
                    Save
                  </button>
                  <button className={btnGhost + " !py-1 text-xs"} onClick={() => { setPwFor(null); setPw(""); }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-body truncate flex items-center gap-1.5">
                    {p.name}
                    {p.locked && <LockGlyph />}
                    {!!p.is_default && <span className="ml-1 text-[10px] uppercase tracking-widest text-muted">main</span>}
                  </div>
                </div>
                <button className={btnGhost + " !px-2 !py-1 text-xs"} onClick={() => setEditing(p)}>
                  Edit
                </button>
                {p.locked ? (
                  <button className={btnGhost + " !px-2 !py-1 text-xs"} onClick={() => clearPassword(p)} title="Remove password">
                    Unlock
                  </button>
                ) : (
                  <button className={btnGhost + " !px-2 !py-1 text-xs"} onClick={() => { setPwFor(p); setPw(""); }} title="Set a password">
                    Lock
                  </button>
                )}
                {!p.is_default && (
                  <button className="text-danger hover:opacity-80 text-xs px-1" onClick={() => remove(p)} title="Remove profile">
                    Remove
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="p-3 rounded-lg bg-surface border border-cardborder space-y-2.5">
        <div className="text-xs text-muted">Add a profile</div>
        <input
          className={inputCls}
          placeholder="Name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        {swatches(color, setColor)}
        <button className={btnPrimary + " !py-1.5 text-sm"} onClick={add} disabled={busy || !name.trim()}>
          Add profile
        </button>
      </div>
    </section>
  );
}
