import { useEffect, useState } from "react";
import {
  apiFrom,
  testServer,
  saveServers,
  loadServers,
  probePublishedServer,
  type PublishedServer,
  type RemoteServer,
} from "../api";
import { Modal, btnGhost, btnPrimary, inputCls } from "./ui";

/**
 * Connect to another machine's Locality server.
 *
 * Two ways in: sign in and pick from the servers that account has published
 * (the address and token come along automatically, and it works over the
 * internet through the other PC's tunnel), or type an address by hand for a
 * server that isn't tied to an account.
 *
 * Every call here goes to the LOCAL server explicitly. The plain api() helpers
 * follow the active source, which may already be a *remote* machine if the user
 * opened this while browsing one, and account credentials must never be sent
 * anywhere but this PC.
 */
export function ConnectServerDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (server: RemoteServer) => void;
}) {
  const [mode, setMode] = useState<"account" | "address">("account");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  // null = we have no list yet, so ask for credentials. Any array = show it.
  const [servers, setServers] = useState<PublishedServer[] | null>(null);
  // Whose list is on screen: null = this PC's own account, else the typed email.
  // Looking up a friend's account is a one-shot read; it never replaces this
  // PC's session, so "signed in as you" stays true throughout.
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [url, setUrl] = useState("http://");
  const [token, setToken] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // A build without Supabase has nothing to sign into, so don't offer it.
  useEffect(() => {
    let alive = true;
    apiFrom<{ configured: boolean; signedIn: boolean }>("local", "/cloud/status")
      .then((s) => {
        if (!alive) return;
        setConfigured(s.configured);
        setSignedIn(s.signedIn);
        if (!s.configured) setMode("address");
        else if (s.signedIn) void loadOwn(); // already signed in: skip straight to the list
      })
      .catch(() => alive && setConfigured(false));
    return () => {
      alive = false;
    };
  }, []);

  const loadOwn = async () => {
    setBusy(true);
    setErr(null);
    try {
      setServers(await apiFrom<PublishedServer[]>("local", "/cloud/servers"));
      setLookedUp(null);
    } catch (e: any) {
      // Session expired or lookup failed: fall back to asking for credentials.
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    setBusy(true);
    setErr(null);
    setStatus("Signing in…");
    try {
      const list = await apiFrom<PublishedServer[]>("local", "/cloud/servers/lookup", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      setServers(list);
      setLookedUp(email.trim());
      setPassword("");
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  /** Save a server once we know which of its addresses actually answers. */
  const save = (name: string, u: string, tok: string) => {
    const server: RemoteServer = {
      id: "srv_" + Math.random().toString(36).slice(2, 10),
      name,
      url: u,
      token: tok,
    };
    saveServers([...loadServers().filter((s) => s.url !== u), server]); // replace same-URL
    onConnected(server);
    onClose();
  };

  const connectPublished = async (s: PublishedServer) => {
    setBusy(true);
    setErr(null);
    setStatus(`Reaching ${s.name || "server"}…`);
    try {
      const hit = await probePublishedServer(s);
      if (!hit) {
        setErr(
          `Found ${s.name || "that server"}, but couldn't reach it. It may be switched off, or remote access is off on that PC.`
        );
        return;
      }
      save(hit.name, hit.url, s.token);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const connectManual = async () => {
    setBusy(true);
    setErr(null);
    try {
      let u = url.trim();
      if (!/^https?:\/\//i.test(u)) u = "http://" + u;
      u = u.replace(/\/+$/, "");
      const info = await testServer(u, token.trim());
      save(info.name, u, token.trim());
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const tab = (id: "account" | "address", label: string) => (
    <button
      className={
        "flex-1 py-1.5 text-sm rounded-md transition-colors " +
        (mode === id ? "bg-accent text-accenttext" : "text-muted hover:text-body")
      }
      onClick={() => {
        setMode(id);
        setErr(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <Modal onClose={onClose}>
      <div className="p-6 space-y-4">
        <h3 className="font-display text-xl text-heading">Connect to a server</h3>

        {configured && (
          <div className="flex gap-1 p-1 rounded-lg bg-surface border border-cardborder">
            {tab("account", "Sign in")}
            {tab("address", "Enter address")}
          </div>
        )}

        {mode === "account" ? (
          <>
            {servers ? null : (
              <>
                <p className="text-xs text-muted leading-relaxed">
                  Sign in with the account the other PC uses. Its address and access token come across automatically.
                  {signedIn && " You stay signed in to your own account; this is only used to find the server."}
                </p>
                <label className="block">
                  <span className="text-xs text-muted">Email</span>
                  <input
                    className={inputCls + " mt-1"}
                    value={email}
                    autoFocus
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && lookup()}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted">Password</span>
                  <input
                    className={inputCls + " mt-1"}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && lookup()}
                  />
                </label>
                {signedIn && (
                  <button className="text-xs text-muted hover:text-body" disabled={busy} onClick={loadOwn}>
                    Back to my servers
                  </button>
                )}
              </>
            )}

            {servers && (
              <div className="space-y-2">
                {lookedUp && <p className="text-[11px] text-muted">Servers on {lookedUp}</p>}
                {servers.length === 0 ? (
                  <p className="text-xs text-muted leading-relaxed">
                    No other servers on this account. On the other PC, turn on Remote access in Settings and sign in
                    with the same account.
                  </p>
                ) : (
                  servers.map((s) => (
                    <button
                      key={s.serverId}
                      className="w-full text-left p-3 rounded-lg bg-surface border border-cardborder hover:border-accent transition-colors disabled:opacity-50"
                      disabled={busy}
                      onClick={() => connectPublished(s)}
                    >
                      <div className="text-sm text-heading">{s.name || "Locality server"}</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {s.addresses.some((a) => a.kind === "remote")
                          ? "reachable from anywhere"
                          : "on the local network"}
                      </div>
                    </button>
                  ))
                )}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    className={btnGhost + " !px-3 !py-1.5 text-xs"}
                    disabled={busy}
                    onClick={() => {
                      setServers(null);
                      setErr(null);
                    }}
                  >
                    {lookedUp ? "Use a different account" : "Find a friend's server"}
                  </button>
                  {lookedUp && signedIn && (
                    <button className="text-xs text-muted hover:text-body" disabled={busy} onClick={loadOwn}>
                      Back to my servers
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted leading-relaxed">
              Enter the address shown on the other PC under Settings → Remote access, and its access token.
            </p>
            <label className="block">
              <span className="text-xs text-muted">Server address</span>
              <input
                className={inputCls + " mt-1"}
                placeholder="http://192.168.1.20:3777"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connectManual()}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Access token</span>
              <input
                className={inputCls + " mt-1 font-mono"}
                placeholder="from the other PC's Settings"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connectManual()}
              />
            </label>
          </>
        )}

        {status && <p className="text-xs text-muted">{status}</p>}
        {err && <p className="text-danger text-sm">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {mode === "address" ? (
            <button className={btnPrimary} onClick={connectManual} disabled={busy || !url.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          ) : (
            !servers && (
              <button className={btnPrimary} onClick={lookup} disabled={busy || !email.trim() || !password}>
                {busy ? "Signing in…" : "Find servers"}
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}
