// The single most dangerous check in the app: it decides whether a caller skips
// the access token AND receives the unredacted settings (TMDB key, OpenSubtitles
// password, access token) from /state.
//
// The Cloudflare tunnel runs ON the server machine and connects over loopback,
// so "the socket says 127.0.0.1" stopped meaning "this is the desktop UI" the
// moment remote access shipped. If these ever go green in the wrong direction,
// turning on remote access publishes the library to the internet with no auth.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isLocalRequest, clientKey, parseTunnelUrl } = require("../dist/test/lib.cjs");

/** Minimal stand-in for the bits of express's Request that are actually read. */
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test("the desktop UI on loopback counts as local", () => {
  assert.equal(isLocalRequest(req("127.0.0.1")), true);
  assert.equal(isLocalRequest(req("::1")), true);
  assert.equal(isLocalRequest(req("::ffff:127.0.0.1")), true);
});

test("a LAN client is not local", () => {
  assert.equal(isLocalRequest(req("192.168.1.42")), false);
  assert.equal(isLocalRequest(req("100.87.3.9")), false); // tailscale
});

test("loopback + a forwarding header is NOT local — this is the tunnel case", () => {
  // What a request through the Cloudflare tunnel actually looks like to us.
  for (const h of ["cf-ray", "cf-connecting-ip", "cf-ipcountry", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"]) {
    assert.equal(isLocalRequest(req("127.0.0.1", { [h]: "anything" })), false, `${h} must force auth`);
  }
});

test("forged forwarding headers can only make the check stricter", () => {
  // A LAN attacker adding these gains nothing: they were already non-local, and
  // stripping them is impossible because Cloudflare's edge sets them.
  assert.equal(isLocalRequest(req("192.168.1.42", { "cf-ray": "forged" })), false);
});

test("empty header values don't trip the check", () => {
  // Some proxies send the header with no value; that shouldn't lock out the UI.
  assert.equal(isLocalRequest(req("127.0.0.1", { "x-forwarded-for": "" })), true);
});

test("the quick-tunnel URL is picked out of cloudflared's banner", () => {
  // Verbatim shape of what cloudflared writes to stderr. If this stops matching,
  // remote access fails silently: the process runs but never reports a URL.
  const banner = [
    "2026-07-20T09:12:31Z INF Requesting new quick Tunnel on trycloudflare.com...",
    "2026-07-20T09:12:31Z INF +--------------------------------------------------------------+",
    "2026-07-20T09:12:31Z INF |  Your quick Tunnel has been created! Visit it at:             |",
    "2026-07-20T09:12:31Z INF |  https://tan-river-8823.trycloudflare.com                     |",
    "2026-07-20T09:12:31Z INF +--------------------------------------------------------------+",
  ].join("\n");
  assert.equal(parseTunnelUrl(banner), "https://tan-river-8823.trycloudflare.com");

  // Ordinary chatter must not produce a bogus URL.
  assert.equal(parseTunnelUrl("2026-07-20T09:12:30Z INF Starting tunnel"), null);
  assert.equal(parseTunnelUrl("registered connIndex=0 location=fra01"), null);
});

test("rate limiting keys off the real client, not the tunnel's loopback socket", () => {
  // Otherwise every internet request would share one bucket and a single
  // attacker could lock out every other remote user.
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientKey(req("192.168.1.42")), "192.168.1.42");
});
