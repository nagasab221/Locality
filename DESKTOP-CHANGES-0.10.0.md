# Desktop changes for the phone's watch party (0.9.5 → 0.10.1)

Everything the Windows build got in this round, so the Linux build can match.
**Four files:** one new endpoint, one test, one sync fix, one version bump.
Nothing else was touched — not party.ts, not cloudSync.ts, not the player.

- **0.10.0** — sections 1–3 below (the endpoint the phone needs).
- **0.10.1** — section 4 (party sync accuracy; fixes drift and stuck pauses
  between a PC and a phone). Worth taking even if you never use the phone,
  since it affects PC-to-PC parties too.

## Why

A watch party in **"local" mode** carries only the path-independent fingerprint
(`fp_` + sha1 of filename+size), and every member resolves it against their own
library. A PC does that in its own SQLite. The phone has no library of its own,
so it has to ask whichever server it's connected to — and there was no route for
that. Without this endpoint the phone can join a party but can never tell
whether your library actually holds the file.

Stream-mode parties don't need it. If you never use local mode from the phone,
this whole change is optional.

---

## 1. `electron/server/routes/player.ts`

Add this route. It goes **immediately before** the existing
`/** Watched toggle addressed by FILE ... */` block (`r.post("/files/:fileId/watched", …)`).
Anywhere inside `playerRoutes()` works — it only needs `db`, `MediaFile` and
`playbackTitle`, all already in that file.

```ts
  /**
   * Resolve a party's fingerprint against THIS library.
   *
   * A watch party in "local" mode carries only the path-independent fingerprint
   * (see services/party.ts), so every member finds their own copy. The desktop
   * looks it up in its own SQLite; a phone has no library of its own and asks
   * the server it's connected to through here.
   */
  r.get("/files/by-fingerprint/:fp", (req, res) => {
    const file = db
      .prepare("SELECT * FROM files WHERE fingerprint = ? AND missing = 0 LIMIT 1")
      .get(String(req.params.fp)) as MediaFile | undefined;
    if (!file) return res.status(404).json({ error: "Not in this library" });
    const ep = file.episode_id
      ? (db.prepare("SELECT show_id, season, episode FROM episodes WHERE id = ?").get(file.episode_id) as any)
      : null;
    res.json({
      fileId: file.id,
      title: playbackTitle(file),
      itemId: ep?.show_id ?? file.media_item_id ?? null,
      season: ep?.season ?? null,
      episode: ep?.episode ?? null,
    });
  });
```

Read-only, and it sits behind the same LAN token check as every other route, so
it exposes nothing new to the network.

## 2. `tests/smoke.test.js`

Add this test. It goes **immediately before** the existing
`await t.test("unknown ids 404 instead of throwing", …)` block.

```js
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
```

## 3. `package.json`

```diff
-  "version": "0.9.5",
+  "version": "0.10.1",
```

Only so a packaged build isn't confusable with the old one. Nothing depends on
the number — skip it if you'd rather keep your own versioning.

## 4. `src/partySync.ts` — sync accuracy (0.10.1)

Live testing between Windows and Android showed two faults, both from the same
root cause: **playback was corrected only at the instant an action arrived.**

- Seeking cost the guest a second or three of buffering. The others didn't
  wait, so the gap that opened during the buffer never closed — the timelines
  just stayed a few seconds apart.
- A pause could be silently undone locally (audio focus, a session command) and
  nothing ever put it back, so one side quietly resumed on its own.

The published position was also aged forward using `Date.parse(updatedAt)` —
the *other* machine's wall clock. A PC and a phone are routinely a second or
two apart, which is the same size as the error being corrected.

The fix, in three parts:

**a. Anchor on receipt, not on the publisher's clock.** Replace `partyTarget`:

```ts
export function partyPositionNow(pb: PartyPlayback, receivedAt: number): number {
  if (pb.paused) return pb.position;
  const elapsed = Math.max(0, (Date.now() - receivedAt) / 1000);
  return pb.position + ACTION_LATENCY_S + elapsed;
}
```

`receivedAt` is stamped with **our** clock when the action arrives, so the
elapsed time is real no matter how wrong either machine's absolute time is.
`MAX_EXTRAPOLATE_S` becomes unused — delete it.

**b. New constants** (and tolerance drops from 2 s to 1 s, which is what makes
a "few seconds" gap visible in the first place):

```ts
export const SYNC_TOLERANCE_S = 1;
const RECONCILE_MS = 1000;
const RESEEK_COOLDOWN_MS = 4000;
const ACTION_LATENCY_S = 0.4;
```

**c. A reconciliation loop** in `usePartySync` — this is the actual fix. It runs
every second, re-asserts play/pause, and closes any drift beyond tolerance. It
is purely local and never publishes, so correcting yourself can't drag the
others around. The cooldown stops a slow link from chasing its own tail (seek →
buffer → fall behind → seek again).

Add `receivedAt` and `lastCorrection` refs next to the existing `appliedSeq`
ref, set `receivedAt.current = Date.now()` in the apply effect, and add the
interval effect. See the Windows copy of `src/partySync.ts` for the exact code —
it's ~35 lines and easiest to copy wholesale, since that file is otherwise
identical between the two builds.

**Keep in step with the phone.** `player/PartySync.kt` in the Android project
carries the same four constants and the same loop. If you tune one, tune both,
or the two clients will correct each other.

---

## Verify

```bash
npm test
```

Expect **17 passing** (was 16). The new one is
`a party's fingerprint resolves to this library's file`.

## Build on Linux

```bash
npm run dist:linux
```

If `better-sqlite3` complains about a Node/Electron ABI mismatch after a fresh
`npm install` on the new machine:

```bash
npm run rebuild
```

(That swaps in the Electron-ABI prebuild — the same gotcha as on Windows.)

To just run it without packaging:

```bash
npm start
```

---

## What the phone does with it

`GET /api/files/by-fingerprint/<fp>` → `200 {fileId, title, itemId, season, episode}`
or `404 {error}`.

The phone calls it in `party/PartyService.localFileFor()` — it checks its own
downloaded bundles first, and falls back to this endpoint to find the connected
server's copy. That result is what drives "Playing your server's copy" versus
"You don't have this file" in the party UI, and what the desktop shows as the
`ready` / `no file` marker next to each member.

## Not part of this change

The accounts and party protocol themselves needed **no** desktop changes: the
phone speaks to the same Supabase project and the same tables (`parties`,
`party_members`, `party_state`, `party_contacts`, `profiles`, plus the
`locality_find_user` RPC) your desktop already uses, with the same poll
cadences and the same `seq` ordering.

One thing to keep in sync by hand if you ever tune it: the sync constants live
in `src/partySync.ts` on the desktop and `player/PartySync.kt` on the phone —
tolerance 2 s, echo-quiet 900 ms, settle 1800 ms, extrapolate ≤ 5 s. Change
them in both places or in neither, or the two clients will correct each other.
