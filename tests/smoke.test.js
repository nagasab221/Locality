// End-to-end smoke test: boots the real server against a throwaway data dir and
// a fixture library, scans it, and exercises the endpoints the UI and the phone
// depend on. Catches the class of breakage that typechecking can't — a bad
// migration, a route that throws, a scan that files nothing.
//
// Runs under Electron (ELECTRON_RUN_AS_NODE=1) because better-sqlite3 is built
// for Electron's ABI. See `npm run test:e2e`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../dist/test/server.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "locality-smoke-"));
const dataDir = path.join(root, "data");
const docsDir = path.join(root, "docs");
const mediaDir = path.join(root, "media");

// A fixture TV library. Contents don't matter — the scanner keys off names and
// sizes — but they must be big enough to clear the junk-file size floor.
const EPISODES = [
  "Test Show/Season 1/Test Show - S01E01 - Pilot.mkv",
  "Test Show/Season 1/Test Show - S01E02 - Second.mkv",
];
for (const rel of EPISODES) {
  const p = path.join(mediaDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(1024 * 1024)); // 1 MB placeholder
}

let server;
let base;

const api = async (p, init) => {
  const res = await fetch(base + p, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("server boots and serves state", async (t) => {
  server = await startServer({
    dataDir,
    documentsDir: docsDir,
    appVersion: "0.0.0-test",
    logPath: path.join(dataDir, "test.log"),
  });
  base = `http://127.0.0.1:${server.port}/api`;
  // The fixture files are empty placeholders, so intro/credits detection would
  // spawn ffmpeg per episode and log failures. Nothing here tests it; pause it
  // so a real failure in this suite is easy to spot.
  await api("/detect/pause", { method: "POST", body: JSON.stringify({ paused: true }) });

  const { status, body } = await api("/state");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.libraries), "state must list libraries");
  assert.ok(body.dataDir, "state must report its data dir");

  await t.test("adding a library scans it and surfaces the episodes", async () => {
    const created = await api("/libraries", {
      method: "POST",
      body: JSON.stringify({ name: "Test TV", type: "tv", path: mediaDir }),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const libId = created.body.id;

    // The scan runs in the background; poll briefly for it to land.
    let items = [];
    for (let i = 0; i < 60; i++) {
      const r = await api(`/libraries/${libId}/items`);
      items = r.body ?? [];
      if (items.length > 0) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    assert.equal(items.length, 1, "the two episodes should group into ONE show");
    assert.equal(items[0].type, "show");
    assert.match(items[0].title, /Test Show/i);

    const detail = await api(`/items/${items[0].id}`);
    assert.equal(detail.status, 200);
    const episodes = (detail.body.seasons ?? []).flatMap((s) => s.episodes);
    assert.equal(episodes.length, 2, "both episodes should be attached");
    assert.ok(episodes.every((e) => e.file), "each episode should have a file");
    assert.equal(detail.body.inWatchlist, false);
  });

  await t.test("watchlist round-trips", async () => {
    const items = (await api("/libraries/1/items")).body;
    const id = items[0].id;
    assert.equal((await api(`/items/${id}/watchlist`, { method: "POST", body: JSON.stringify({ on: true }) })).status, 200);
    assert.equal((await api(`/items/${id}`)).body.inWatchlist, true);
    const home = await api("/home");
    assert.equal(home.status, 200);
    assert.equal(home.body.watchlist.length, 1, "watchlisted show should appear on home");

    await api(`/items/${id}/watchlist`, { method: "POST", body: JSON.stringify({ on: false }) });
    assert.equal((await api(`/items/${id}`)).body.inWatchlist, false);
  });

  await t.test("progress is recorded and drives Continue Watching", async () => {
    const detail = (await api(`/items/${(await api("/libraries/1/items")).body[0].id}`)).body;
    const file = detail.seasons[0].episodes[0].file;
    const posted = await api("/player/progress", {
      method: "POST",
      body: JSON.stringify({ fileId: file.id, position: 120, duration: 1500 }),
    });
    assert.equal(posted.status, 200);
    const home = await api("/home");
    assert.equal(home.body.continueWatching.length, 1);
    assert.equal(home.body.continueWatching[0].kind, "episode");
  });

  await t.test("per-show track preferences round-trip", async () => {
    const id = (await api("/libraries/1/items")).body[0].id;
    const put = await api(`/player/prefs/${id}`, {
      method: "PUT",
      body: JSON.stringify({ audioLang: "jpn", subLang: "eng" }),
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.audioLang, "jpn");
    // Independent fields: updating one must not clear the other.
    const second = await api(`/player/prefs/${id}`, { method: "PUT", body: JSON.stringify({ subLang: "off" }) });
    assert.equal(second.body.audioLang, "jpn", "audio pref must survive a subtitle-only update");
    assert.equal(second.body.subLang, "off");
  });

  await t.test("profiles keep separate watch state", async () => {
    // The default profile already has Continue Watching from the progress test.
    const before = await api("/profiles");
    assert.equal(before.status, 200);
    assert.equal(before.body.length, 1, "a fresh install has exactly one (default) profile");
    assert.equal(before.body[0].is_default, 1);

    const created = await api("/profiles", { method: "POST", body: JSON.stringify({ name: "Kid", color: "#7BB08A" }) });
    assert.equal(created.status, 200);
    const kid = created.body.id;
    const asKid = (p, init) => api(p, { ...init, headers: { "X-Locality-Profile": String(kid), ...(init?.headers ?? {}) } });

    // The default profile is mid-episode; the new profile has watched nothing.
    assert.equal((await api("/home")).body.continueWatching.length, 1, "default profile keeps its progress");
    assert.equal((await asKid("/home")).body.continueWatching.length, 0, "new profile starts empty");

    // Record different progress for the kid on the same file.
    const file = (await api(`/items/${(await api("/libraries/1/items")).body[0].id}`)).body.seasons[0].episodes[0].file;
    await asKid("/player/progress", { method: "POST", body: JSON.stringify({ fileId: file.id, position: 600, duration: 1500 }) });

    const kidHome = await asKid("/home");
    assert.equal(kidHome.body.continueWatching.length, 1, "kid now has its own Continue Watching");

    // The two profiles must report independent positions for the same file.
    const kidDetail = (await asKid(`/items/${(await api("/libraries/1/items")).body[0].id}`)).body;
    const defDetail = (await api(`/items/${(await api("/libraries/1/items")).body[0].id}`)).body;
    assert.equal(kidDetail.seasons[0].episodes[0].progress.position_seconds, 600);
    assert.equal(defDetail.seasons[0].episodes[0].progress.position_seconds, 120, "default progress untouched by the kid");

    // The default profile can never be deleted; a real one can.
    assert.equal((await api(`/profiles/${before.body[0].id}`, { method: "DELETE" })).status, 400);
    assert.equal((await api(`/profiles/${kid}`, { method: "DELETE" })).status, 200);
    assert.equal((await api("/profiles")).body.length, 1);
  });

  await t.test("a profile can be locked with a local password", async () => {
    const kid = (await api("/profiles", { method: "POST", body: JSON.stringify({ name: "Locked" }) })).body.id;
    assert.equal((await api(`/profiles/${kid}/password`, { method: "PUT", body: JSON.stringify({ password: "s3cret" }) })).status, 200);

    const row = (await api("/profiles")).body.find((p) => p.id === kid);
    assert.equal(row.locked, true);
    assert.equal(row.password_hash, undefined, "the hash must never reach a client");
    assert.equal(row.password_salt, undefined);

    assert.equal((await api(`/profiles/${kid}/unlock`, { method: "POST", body: JSON.stringify({ password: "nope" }) })).status, 401);
    assert.equal((await api(`/profiles/${kid}/unlock`, { method: "POST", body: JSON.stringify({ password: "s3cret" }) })).status, 200);

    // Clearing the password removes the lock.
    await api(`/profiles/${kid}/password`, { method: "PUT", body: JSON.stringify({ password: "" }) });
    assert.equal((await api("/profiles")).body.find((p) => p.id === kid).locked, false);
    await api(`/profiles/${kid}`, { method: "DELETE" });
  });

  await t.test("downloading from another server mirrors it into a local, playable item", async () => {
    // Point the server at ITSELF over loopback as the "remote" — a clean way to
    // exercise the whole manifest → transfer → local-item path with no 2nd box.
    const origin = base.replace(/\/api$/, "");
    const showId = (await api("/libraries/1/items")).body[0].id;
    const started = await api("/downloads", {
      method: "POST",
      body: JSON.stringify({ serverUrl: origin, token: "", itemId: showId, season: 1, sourceName: "self" }),
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const jobId = started.body.downloadId;

    let job;
    for (let i = 0; i < 80; i++) {
      job = (await api("/downloads")).body.find((d) => d.id === jobId);
      if (job && (job.status === "complete" || job.status === "error")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(job.status, "complete", JSON.stringify(job));
    assert.equal(job.percent, 100);

    // The internal Downloads library must never surface in normal listings.
    assert.ok(!(await api("/state")).body.libraries.some((l) => l.internal), "internal library hidden from /state");
    assert.ok((await api("/search?q=Test")).body.every((r) => r.libraryName !== "Downloads"), "downloaded copy excluded from search");

    // But the downloaded item is an ordinary, playable local item.
    const detail = (await api(`/items/${started.body.mediaItemId}`)).body;
    assert.equal(detail.type, "show");
    const epFile = detail.seasons[0].episodes.find((e) => e.file)?.file;
    assert.ok(epFile, "downloaded episode has a local file");
    assert.equal((await api(`/player/prepare/${epFile.id}`)).status, 200);

    assert.equal((await api(`/downloads/${jobId}`, { method: "DELETE" })).status, 200);
    assert.equal((await api("/downloads")).body.length, 0);
  });

  await t.test("search finds titles across the catalog", async () => {
    const hit = await api("/search?q=Test");
    assert.equal(hit.status, 200);
    assert.ok(hit.body.length >= 1, "the fixture show should match");
    assert.match(hit.body[0].title, /Test Show/i);
    assert.ok(hit.body[0].libraryName, "results carry the library name");
    // A one-letter query is too short to bother the DB.
    assert.deepEqual((await api("/search?q=a")).body, []);
  });

  await t.test("a request arriving through a proxy must present the token", async () => {
    // Exercises the real middleware over a real socket. cloudflared connects
    // from 127.0.0.1, so this is exactly what an internet request looks like:
    // loopback source, Cloudflare headers attached.
    const token = (await api("/state")).body.settings.lanToken;
    assert.ok(token.length >= 32, `new installs must mint a 128-bit token, got ${token.length} chars`);

    const viaTunnel = (extra, path = "/state") => api(path, { headers: { "cf-ray": "7d4b2f1a0000", ...extra } });
    assert.equal((await viaTunnel()).status, 401, "no token must be rejected");
    assert.equal((await viaTunnel({ "X-Locality-Token": "wrong" })).status, 401);

    const ok = await viaTunnel({ "X-Locality-Token": token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.tmdbApiKey, "", "credentials must be redacted for remote callers");
    assert.equal(ok.body.settings.lanToken, "", "the token must not be echoed back over the tunnel");
    assert.equal(ok.body.remote, null);

    // Even authenticated, a remote caller can't rewrite settings.
    const wrote = await api("/settings", {
      method: "PUT",
      headers: { "cf-ray": "7d4b2f1a0000", "X-Locality-Token": token },
      body: JSON.stringify({ remoteEnabled: "0" }),
    });
    assert.equal(wrote.status, 403);

    // Nor reach the account-lookup routes — they handle cloud credentials.
    assert.equal((await viaTunnel({ "X-Locality-Token": token }, "/cloud/servers")).status, 403);
    const lookup = await api("/cloud/servers/lookup", {
      method: "POST",
      headers: { "cf-ray": "7d4b2f1a0000", "X-Locality-Token": token },
      body: JSON.stringify({ email: "a@b.c", password: "x" }),
    });
    assert.equal(lookup.status, 403);
  });

  await t.test("gallery and other libraries scan their own file types", async () => {
    // Gallery: images + a clip, in a subfolder (album).
    const galleryDir = path.join(root, "gallery");
    fs.mkdirSync(path.join(galleryDir, "Trip"), { recursive: true });
    fs.writeFileSync(path.join(galleryDir, "a.jpg"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(galleryDir, "Trip", "b.png"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(galleryDir, "Trip", "clip.mp4"), Buffer.alloc(4096));

    const gLib = await api("/libraries", { method: "POST", body: JSON.stringify({ name: "Photos", type: "gallery", path: galleryDir }) });
    assert.equal(gLib.status, 200, JSON.stringify(gLib.body));
    let gitems = [];
    for (let i = 0; i < 40; i++) {
      gitems = (await api(`/gallery/${gLib.body.id}`)).body ?? [];
      if (gitems.length >= 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(gitems.length, 3, "two photos + one clip");
    assert.equal(gitems.filter((x) => x.kind === "photo").length, 2);
    assert.equal(gitems.filter((x) => x.kind === "video").length, 1);
    assert.ok(gitems.some((x) => x.folder === "Trip"), "subfolder is recorded as the album");
    // Gallery shows in the sidebar (state) but not on Home (no media_items).
    assert.ok((await api("/state")).body.libraries.some((l) => l.id === gLib.body.id && l.type === "gallery"));
    assert.ok(!(await api("/home")).body.recentlyAdded.some((r) => r.library.id === gLib.body.id));

    // "Other": one movie-shaped item per video, no matching.
    const otherDir = path.join(root, "other");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "Home Movie 2021.mp4"), Buffer.alloc(1024 * 1024));
    const oLib = await api("/libraries", { method: "POST", body: JSON.stringify({ name: "Misc", type: "other", path: otherDir }) });
    assert.equal(oLib.status, 200);
    let oitems = [];
    for (let i = 0; i < 40; i++) {
      oitems = (await api(`/libraries/${oLib.body.id}/items`)).body ?? [];
      if (oitems.length >= 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(oitems.length, 1, "one item per file, no grouping");
    assert.equal(oitems[0].type, "movie");
    assert.match(oitems[0].title, /Home Movie/);
  });

  await t.test("a library can span multiple folders", async () => {
    const a = path.join(root, "multiA");
    const b = path.join(root, "multiB");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, "clipA.mp4"), Buffer.alloc(1024 * 1024));
    fs.writeFileSync(path.join(b, "clipB.mp4"), Buffer.alloc(1024 * 1024));

    const lib = await api("/libraries", { method: "POST", body: JSON.stringify({ name: "Span", type: "other", path: a }) });
    const libId = lib.body.id;
    const wait = async (want) => {
      let items = [];
      for (let i = 0; i < 40; i++) {
        items = (await api(`/libraries/${libId}/items`)).body ?? [];
        if (want(items.length)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return items;
    };
    assert.equal((await wait((n) => n >= 1)).length, 1, "primary folder scans");

    assert.equal((await api(`/libraries/${libId}/folders`, { method: "POST", body: JSON.stringify({ path: b }) })).status, 200);
    assert.equal((await wait((n) => n >= 2)).length, 2, "the added folder's files show up too");

    const libState = (await api("/state")).body.libraries.find((l) => l.id === libId);
    assert.equal(libState.folders.length, 1, "the extra folder is reported in state");

    assert.equal((await api(`/libraries/${libId}/folders/${libState.folders[0].id}`, { method: "DELETE" })).status, 200);
    assert.equal((await wait((n) => n <= 1)).length, 1, "removing a folder drops its items");
  });

  await t.test("libraries can be reordered", async () => {
    const before = (await api("/state")).body.libraries.map((l) => l.id);
    assert.ok(before.length >= 2, "expected several libraries by this point");
    const flipped = [...before].reverse();
    assert.equal((await api("/libraries/order", { method: "POST", body: JSON.stringify({ ids: flipped }) })).status, 200);
    const after = (await api("/state")).body.libraries.map((l) => l.id);
    assert.deepEqual(after, flipped, "state lists libraries in the saved order");
    assert.equal((await api("/libraries/order", { method: "POST", body: JSON.stringify({ ids: "nope" }) })).status, 400);
  });

  await t.test("a daily database backup is written on boot", async () => {
    const dir = path.join(dataDir, "backups");
    let names = [];
    for (let i = 0; i < 30; i++) {
      names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^locality-\d{4}-\d{2}-\d{2}\.db$/.test(n)) : [];
      if (names.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(names.length >= 1, `expected a backup snapshot in ${dir}`);
  });

  await t.test("cache cleanup removes orphaned artwork", async () => {
    const orphan = path.join(dataDir, "media-cache", "images", "poster", "0000orphan0000.jpg");
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, Buffer.alloc(2048));

    const stats = (await api("/cache/stats")).body;
    assert.ok(stats.bytes >= 2048, "stats count the file");

    const r = (await api("/cache/cleanup", { method: "POST" })).body;
    assert.ok(r.removed >= 1, "the orphan counts as removed");
    assert.ok(!fs.existsSync(orphan), "the orphan file is gone");
  });

  await t.test("a party's fingerprint resolves to this library's file", async () => {
    // What a phone in a "local" mode watch party asks: everyone holds their own
    // copy, and the party only carries the path-independent fingerprint.
    const detail = (await api(`/items/${(await api("/libraries/1/items")).body[0].id}`)).body;
    const file = detail.seasons[0].episodes[0].file;
    const hit = await api(`/files/by-fingerprint/${file.fingerprint}`);
    assert.equal(hit.status, 200);
    assert.equal(hit.body.fileId, file.id, "resolves back to the same file");
    assert.ok(hit.body.title, "carries a human title for the party UI");
    assert.equal((await api("/files/by-fingerprint/fp_nothinghere")).status, 404);
  });

  await t.test("unknown ids 404 instead of throwing", async () => {
    assert.equal((await api("/items/999999")).status, 404);
    assert.equal((await api("/player/prepare/999999")).status, 404);
  });
});

test.after(async () => {
  // Let the background scan finish first. Closing mid-scan tears the DB out from
  // under the scanner/marker-detector, which then log "database connection is
  // not open" — harmless here, but it makes the run look like it failed.
  for (let i = 0; i < 40 && base; i++) {
    const { body } = await api("/state").catch(() => ({ body: null }));
    if (!body || !(body.libraries ?? []).some((l) => l.scanning)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (server) await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
