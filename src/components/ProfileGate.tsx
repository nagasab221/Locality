import { useState } from "react";
import { post, setActiveProfile } from "../api";
import type { Profile } from "../types";
import { btnGhost, btnPrimary, inputCls } from "./ui";

/** Avatar circle with the person's initial. */
function Avatar({ name, color, size }: { name: string; color: string; size: number }) {
  return (
    <span
      className="rounded-full flex items-center justify-center font-semibold text-accenttext"
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Shown once per app launch (see App's `needProfileGate`). With several profiles
 * it's a Netflix-style "Who's watching?"; picking a locked one asks for its
 * password. With a single locked profile it goes straight to the password. On a
 * successful choice it reloads so everything loads as that person.
 */
export default function ProfileGate({ profiles, onCancel }: { profiles: Profile[]; onCancel?: () => void }) {
  const multi = profiles.length >= 2;
  // A single locked profile skips the picker and asks for its password directly.
  const [unlocking, setUnlocking] = useState<Profile | null>(() => (!multi && profiles[0]?.locked ? profiles[0] : null));
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commit = (p: Profile) => {
    setActiveProfile(p.is_default ? null : p.id);
    sessionStorage.setItem("locality.profileChosen", "1");
    window.location.reload();
  };

  const choose = (p: Profile) => {
    setErr(null);
    if (p.locked) {
      setUnlocking(p);
      setPassword("");
    } else {
      commit(p);
    }
  };

  const submit = () => {
    if (!unlocking) return;
    setBusy(true);
    setErr(null);
    post(`/profiles/${unlocking.id}/unlock`, { password })
      .then(() => commit(unlocking))
      .catch(() => {
        setErr("Wrong password");
        setBusy(false);
      });
  };

  return (
    <div className="fixed inset-0 z-[100] bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-2xl text-center">
        {unlocking ? (
          <div className="max-w-xs mx-auto space-y-5">
            <div className="flex justify-center">
              <Avatar name={unlocking.name} color={unlocking.color} size={76} />
            </div>
            <h1 className="font-display text-2xl text-heading">Enter {unlocking.name}'s password</h1>
            <input
              type="password"
              autoFocus
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {err && <p className="text-danger text-sm">{err}</p>}
            <div className="flex gap-2 justify-center">
              {multi && (
                <button
                  className={btnGhost}
                  onClick={() => {
                    setUnlocking(null);
                    setErr(null);
                  }}
                >
                  Back
                </button>
              )}
              <button className={btnPrimary} disabled={busy || !password} onClick={submit}>
                {busy ? "Checking…" : "Unlock"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <h1 className="font-display text-3xl text-heading mb-10">Who's watching?</h1>
            <div className="flex flex-wrap gap-8 justify-center">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  className="group flex flex-col items-center gap-3 w-28"
                  onClick={() => choose(p)}
                >
                  <div className="relative transition-transform group-hover:scale-105">
                    <Avatar name={p.name} color={p.color} size={92} />
                    {p.locked && (
                      <span className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-raised border border-cardborder flex items-center justify-center">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-muted">
                          <rect x="4" y="10" width="16" height="11" rx="2" />
                          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                        </svg>
                      </span>
                    )}
                  </div>
                  <span className="text-body group-hover:text-heading truncate max-w-full">{p.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
