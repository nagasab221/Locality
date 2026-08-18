import { useState } from "react";
import { post } from "../api";
import { btnPrimary, inputCls, CheckIcon } from "./ui";

const BENEFITS = [
  "Pick up where you left off on any device",
  "The Android app finds this PC on its own, no IP or port to type",
  "Your media stays on this PC. Only watch history syncs.",
];

/**
 * First-launch screen: prompt to sign in or create an account before the app
 * proper, with the benefits alongside and a quiet way to skip. Shown only when
 * cloud sync is configured and nobody is signed in yet (App decides); dismissing
 * it (sign in / create / skip) sets `locality.welcomeSeen` so it never returns.
 */
export default function Welcome({
  onDone,
  toast,
}: {
  onDone: () => void;
  toast: (text: string, tone?: "info" | "error" | "ok") => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!email || !password || busy) return;
    setBusy(true);
    setError(null);
    const path = mode === "signup" ? "/cloud/signup" : "/cloud/signin";
    post(path, { email, password })
      .then(() => {
        toast(mode === "signup" ? "Account created" : "Signed in", "ok");
        onDone();
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  const tab = (m: "signup" | "signin", label: string) => (
    <button
      type="button"
      onClick={() => {
        setMode(m);
        setError(null);
      }}
      className={`flex-1 py-1.5 rounded-md text-sm transition-colors ${
        mode === m ? "bg-accent text-accenttext font-semibold" : "text-muted hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[100] bg-bg flex flex-col items-center justify-center px-6 modal-in">
      <div className="text-center mb-8">
        <h1 className="font-display text-4xl text-accent tracking-wide">Locality</h1>
        <p className="text-sm text-muted mt-1">Sign in or create an account to get started.</p>
      </div>

      <div className="w-full max-w-3xl grid md:grid-cols-2 gap-px rounded-xl overflow-hidden border border-cardborder bg-cardborder shadow-2xl">
        {/* Sign in / create account */}
        <div className="bg-surface p-7">
          <div className="flex gap-1 p-1 rounded-lg bg-raised border border-inborder mb-5">
            {tab("signup", "Create account")}
            {tab("signin", "Sign in")}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-muted">Email</span>
              <input
                className={inputCls + " mt-1"}
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Password</span>
              <input
                className={inputCls + " mt-1"}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            {error && <p className="text-danger text-xs">{error}</p>}
            <button className={btnPrimary + " w-full justify-center"} disabled={busy || !email || !password} onClick={submit}>
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </div>
        </div>

        {/* Benefits */}
        <div className="bg-raised p-7">
          <h2 className="font-display text-lg text-heading mb-4">Why sign in?</h2>
          <ul className="space-y-3">
            {BENEFITS.map((b) => (
              <li key={b} className="flex gap-2.5 text-sm text-body/90 leading-snug">
                <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent flex items-center justify-center">
                  <CheckIcon className="w-3 h-3" />
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <button
        className="mt-6 text-sm text-muted hover:text-body transition-colors"
        onClick={onDone}
      >
        Skip for now
      </button>
    </div>
  );
}
