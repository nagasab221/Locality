# Locality 1.0.0

Cleanup + features for the 1.0 tag. Version bumped to **1.0.0** in package.json.

## Supabase migration — applied ✓
Party presence needs a `watching_at` column on `party_members`. This has been run
on the project and verified against the REST API on 2026-08-18, so the presence
dots are live. The statement (also in `supabase/schema.sql`), kept for reference
and for any other environment:

```sql
alter table public.party_members add column if not exists watching_at timestamptz;
```

It degrades gracefully anyway: without the column the party still works fully,
just with no presence dots. Everything else needs no migration; the local SQLite
`shared` column applies itself on first launch.

## Settings
- **Reordered the tabs** to General, Libraries, Playback, Metadata, Remote Access,
  Account, and it now opens on General.

## Per-library sharing (Shared / Private)
- Each library has a **Shared / Private** toggle (Settings → Libraries), and a
  **Private** badge shows on unshared libraries in the sidebar.
- Private means private: a private library is hidden from every request that
  isn't this PC — listings, search, Home, detail, streams, subtitles, thumbnails,
  gallery and the offline export are all gated (`services/requestOrigin.ts`,
  applied across `routes/media.ts` and `routes/player.ts`). Default is Shared, so
  nothing changes until you flip one. Sharing is per-device and not synced to the
  account.

## Watch party
- **Presence**: hover the "Watch party" badge in the player to see everyone in the
  party and a live green dot for who actually has the player open. The player
  pings presence every few seconds; it clears when the player closes.
- **Start from an episode**: every episode row has a "Watch together" button.
- **Join / leave toasts** app-wide, and a **confirm** before ending or leaving.

## Account → Your devices
- Lists the machines published under your account. **Rename** (reliable for this
  PC; for another running device it holds until that device next re-publishes) and
  **Remove** old devices. Renaming this PC is stored locally so it survives the
  next publish.

## Player polish (mpv)
- **`?`** opens a keyboard-shortcuts card.
- **Subtitle colour + background box** added to the subtitle menu (was size +
  position only).
- **Volume and speed persist** across sessions and carry to the next episode.

## About
- Settings → General → About now shows the **version** and adds mpv + FFmpeg to
  the existing attributions.

## Verified
Typecheck, production build, and 30 unit tests pass. The party-only pieces
(presence dot, join/leave toasts) still need a real two-machine party to watch
end to end, and the per-library gating is worth a quick check from the phone
(a Private library should simply not appear).
