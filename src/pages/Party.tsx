// Watch party — the hub for who you're watching with.
//
// Hosting starts from an item's page ("Watch together"), because that's where a
// concrete file id exists. This tab owns everything else: claiming a username,
// answering invites, inviting people, and showing the live party.
//
// State comes from GET /party/status once, then follows the "party" SSE event —
// the server does the Supabase polling, so this page never talks to the cloud
// itself and stays responsive whether or not the network is cooperating.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { subscribe } from "../api";
import { btnGhost, btnPrimary, inputCls, PlayIcon } from "../components/ui";
import { partyGet, partyPost, PARTY_MAX, type PartyMember, type PartyMode, type PartySnapshot } from "../partySync";

/** Letters only, matching the server's rule so the message arrives before the round trip. */
const USERNAME_RE = /^[A-Za-z]*$/;

export default function Party() {
  const [snap, setSnap] = useState<PartySnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    partyGet<PartySnapshot>("/party/status")
      .then(setSnap)
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  useEffect(load, [load]);
  // The server pushes a fresh snapshot whenever its poll finds a change.
  useEffect(() => subscribe("party", (s: PartySnapshot) => setSnap(s)), []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!snap) return <div className="p-8 text-muted text-sm">Loading…</div>;

  if (!snap.configured)
    return <Empty title="Watch party isn't available in this build" body="No cloud account is configured." />;

  if (!snap.signedIn)
    return (
      <Empty
        title="Sign in to watch together"
        body="Watch party uses your Locality account to find the people you invite."
        action={
          <button className={btnPrimary} onClick={() => navigate("/settings")}>
            Open Settings
          </button>
        }
      />
    );

  // First visit: the account has no username yet, and invites are addressed by
  // one, so this gate comes before anything else in the tab.
  if (!snap.username) return <UsernameGate onDone={load} />;

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <h1 className="font-display text-2xl text-heading">Watch party</h1>
        <p className="text-sm text-muted mt-1">
          Watching as <span className="text-hint">{snap.username}</span>
        </p>
      </div>

      {(err || snap.error) && (
        <p className="text-danger text-sm bg-danger/10 border border-danger/30 rounded-md px-3 py-2">
          {err || snap.error}
        </p>
      )}

      {snap.invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] uppercase tracking-widest text-muted">Invitations</h2>
          {snap.invites.map((inv) => (
            <div
              key={inv.partyId}
              className="flex items-center gap-3 rounded-lg border border-cardborder bg-raised px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-heading truncate">{inv.title || "Untitled"}</div>
                <div className="text-xs text-muted mt-0.5">
                  from {inv.hostUsername || "someone"} ·{" "}
                  {inv.mode === "stream"
                    ? "streaming from their machine"
                    : inv.hasFile
                      ? "you have this file"
                      : "you don't have this file"}
                </div>
              </div>
              <button
                className={btnPrimary + " !px-3 !py-1.5"}
                disabled={busy || (inv.mode === "local" && !inv.hasFile)}
                title={
                  inv.mode === "local" && !inv.hasFile
                    ? "This party needs your own copy of the file, and it isn't in your library"
                    : "Join"
                }
                onClick={() => act(() => partyPost("/party/accept", { partyId: inv.partyId }))}
              >
                Join
              </button>
              <button
                className={btnGhost + " !px-3 !py-1.5"}
                disabled={busy}
                onClick={() => act(() => partyPost("/party/decline", { partyId: inv.partyId }))}
              >
                Decline
              </button>
            </div>
          ))}
        </section>
      )}

      {snap.party ? (
        <ActivePartyPanel snap={snap} busy={busy} act={act} />
      ) : (
        <Empty
          title="No party running"
          body="Open a movie or an episode and choose “Watch together” to start one."
        />
      )}
    </div>
  );
}

function ActivePartyPanel({
  snap,
  busy,
  act,
}: {
  snap: PartySnapshot;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const party = snap.party!;
  const navigate = useNavigate();
  const [invitee, setInvitee] = useState(snap.lastInvite);
  // Re-seed when the remembered address changes under us (another invite went
  // out), but never while the user is mid-edit.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setInvitee(snap.lastInvite);
  }, [snap.lastInvite]);

  const joined = party.members.filter((m) => m.status === "joined");
  const invited = party.members.filter((m) => m.status === "invited");

  // Where "Open player" goes. In local mode each member plays their own copy; a
  // stream guest plays the host's file id against the host as a remote source.
  const playHref =
    party.mode === "stream" && !party.isHost
      ? party.hostFileId != null
        ? `/play/${party.hostFileId}?src=party`
        : null
      : party.localFileId != null
        ? `/play/${party.localFileId}`
        : null;

  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-cardborder bg-raised p-5">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-widest text-muted mb-1">
              {party.isHost ? "Hosting" : "In a party"} ·{" "}
              {party.mode === "stream" ? "streaming" : "own copies"}
            </div>
            <div className="font-display text-lg text-heading truncate">{party.title || "Untitled"}</div>
            <div className="text-xs text-muted mt-1">
              {party.playback.paused ? "Paused" : "Playing"} at {fmt(party.playback.position)}
            </div>
          </div>
          {playHref ? (
            <button className={btnPrimary} onClick={() => navigate(playHref)}>
              <PlayIcon /> Open player
            </button>
          ) : (
            <span className="text-xs text-danger max-w-48 text-right">
              You don't have this file, and the host isn't streaming it.
            </span>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-muted mb-2">
          People ({joined.length}/{PARTY_MAX})
        </h2>
        <div className="space-y-1.5">
          {joined.map((m) => (
            <MemberRow key={m.userId} m={m} mode={party.mode} />
          ))}
          {invited.map((m) => (
            <MemberRow key={m.userId} m={m} mode={party.mode} />
          ))}
        </div>
      </div>

      {party.isHost && (
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-muted mb-2">Invite someone</h2>
          <div className="flex gap-2">
            <input
              className={inputCls + " flex-1"}
              placeholder="Email or username"
              value={invitee}
              onChange={(e) => {
                touched.current = true;
                setInvitee(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && invitee.trim())
                  void act(() => partyPost("/party/invite", { identifier: invitee.trim() }));
              }}
            />
            <button
              className={btnPrimary}
              disabled={busy || !invitee.trim()}
              onClick={() => act(() => partyPost("/party/invite", { identifier: invitee.trim() }))}
            >
              Invite
            </button>
          </div>
          {snap.contacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {snap.contacts.map((c) => (
                <button
                  key={c.userId}
                  className="px-2.5 py-1 rounded-full border border-inborder text-xs text-body hover:border-accent hover:text-accent transition-colors"
                  title={c.email || c.username}
                  disabled={busy}
                  onClick={() => act(() => partyPost("/party/invite", { identifier: c.email || c.username }))}
                >
                  {c.username}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        className={btnGhost}
        disabled={busy}
        onClick={() => {
          const msg = party.isHost
            ? "End the party for everyone?"
            : "Leave this party?";
          if (confirm(msg)) void act(() => partyPost("/party/leave"));
        }}
      >
        {party.isHost ? "End party" : "Leave party"}
      </button>
    </section>
  );
}

function MemberRow({ m, mode }: { m: PartyMember; mode: PartyMode }) {
  // "Doesn't have the file" only matters when everyone plays their own copy.
  const missing = mode === "local" && m.status === "joined" && !m.hasFile;
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-inborder px-3 py-2 text-sm">
      <span className="w-6 h-6 rounded-full bg-accent/20 text-accent grid place-items-center text-[11px] font-semibold shrink-0">
        {m.username.slice(0, 1).toUpperCase()}
      </span>
      <span className="text-body">{m.username}</span>
      {m.isHost && <span className="text-[10px] uppercase tracking-wider text-muted">host</span>}
      <div className="flex-1" />
      {m.status === "invited" ? (
        <span className="text-xs text-muted">invited…</span>
      ) : missing ? (
        <span className="text-xs text-danger">missing the file</span>
      ) : (
        <span className="text-xs text-muted">ready</span>
      )}
    </div>
  );
}

/**
 * First run: claim a username. Invites resolve by email OR username, and this is
 * the only thing that gives an account a readable name, so the tab can't do
 * anything useful until it's set.
 */
function UsernameGate({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await partyPost("/party/username", { username: name });
      onDone();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const tooShort = name.length > 0 && name.length < 3;

  return (
    <div className="p-8 max-w-md space-y-4">
      <h1 className="font-display text-2xl text-heading">Pick a username</h1>
      <p className="text-sm text-muted">
        This is how friends find you when they send a watch-party invite. Letters only.
      </p>
      <input
        className={inputCls + " w-full"}
        placeholder="e.g. fabri"
        value={name}
        autoFocus
        // Reject anything non-alphabetic as it's typed, rather than explaining
        // the rule after a failed submit.
        onChange={(e) => USERNAME_RE.test(e.target.value) && setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.length >= 3 && void submit()}
      />
      {tooShort && <p className="text-xs text-muted">At least 3 letters.</p>}
      {err && <p className="text-danger text-sm">{err}</p>}
      <button className={btnPrimary} disabled={busy || name.length < 3} onClick={submit}>
        Continue
      </button>
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="p-8 max-w-lg space-y-3">
      <h1 className="font-display text-xl text-heading">{title}</h1>
      <p className="text-sm text-muted">{body}</p>
      {action}
    </div>
  );
}

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
