# Locality

A locally-run desktop media server & player — Plex's core local experience on a
single machine. Electron + React/TypeScript/Tailwind, an Express server bound
strictly to `127.0.0.1` inside the main process, SQLite for the catalog, and
mpv (when installed) for playback.

## Run

```
npm install
npm run rebuild   # fetches the better-sqlite3 prebuild for Electron's ABI (no compiler needed)
npm start         # builds main/preload/renderer, then launches Electron
```

`npm run build` + `npx electron .` if you've already built.
Smoke check: `LOCALITY_SMOKE=1 npx electron .` prints `SMOKE_OK` and exits.

## Package (Windows exe)

```
npm run icon      # renders assets/logo.svg -> assets/icon.ico (sharp + to-ico)
npm run dist      # icon + build + electron-builder -> release\ (installer + portable)
```

Outputs: `release\Locality Setup <ver>.exe` (installer) and
`release\Locality-Portable-<ver>.exe`. The exe is unsigned, so SmartScreen
shows "Run anyway" on first launch. App data lives in
`%APPDATA%\Locality (Claude)`.

## First-time setup

1. **Settings → Metadata**: paste a free TMDB API key (v3 key or v4 read token).
2. **Settings → Libraries**: add a folder and tag it *Movies* or *TV Shows* — it scans immediately.
3. Optional: **Settings → Subtitles** for an OpenSubtitles API key (+ account for higher download quota).
4. Optional: install [mpv](https://mpv.io) for full codec support (HEVC/MKV/embedded tracks). Auto-detected
   from PATH/winget/scoop/chocolatey, or set the path explicitly. Without mpv, a built-in HTML5 fallback
   player streams from the local server (H.264-class content).

## Connecting from another device (Android, local network)

The whole app runs over a REST API, so a mobile client needs no server changes:

1. **PC**: Settings → *Remote access — Android* → enable, note the **port**
   (default 3777) and the **access token**, then restart Locality.
2. On first start Windows Firewall asks — **allow on Private networks**.
3. **Phone** (same Wi-Fi): base URL is `http://<PC LAN IP>:<port>` — the exact
   URLs are shown in that Settings section (e.g. `http://192.168.1.23:3777`).
4. Every request from the network must carry the token:
   header `X-Locality-Token: <token>` (preferred) or `?token=<token>`
   (for players/EventSource that can't set headers). Requests from the PC
   itself never need it. Wrong/missing token → `401`.

Key endpoints for a client (all JSON under `/api`):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | libraries, settings, LAN info |
| `GET /api/home` | Continue Watching + Recently Added |
| `GET /api/libraries/:id/items` | poster grid data |
| `GET /api/items/:id` | movie/show detail (seasons, episodes, files) |
| `GET /api/images/<rel>` | cached artwork (`poster` field values) |
| `GET /api/stream/:fileId` | video with HTTP Range support (seekable) |
| `POST /api/player/progress` | `{fileId, position, duration}` — resume sync |
| `POST /api/episodes/:id/watched` / `POST /api/items/:id/watched` | toggle watched |
| `GET /api/files/:fileId/subtitles`, `GET /api/subtitles/:subId/vtt` | subtitles |
| `GET /api/player/prepare/:fileId` | everything for playback: resume position, subtitles, intro/credits markers, next episode |
| `GET /api/export/items/:id` (`?season=N`) | offline-download manifest: files (sizes, fingerprints), subtitle refs, markers |
| `POST /api/player/progress-batch` | `{entries:[{fingerprint, filename, size_bytes, duration_seconds, position_seconds, watched, last_updated}]}` — offline progress recorded on the phone, merged newest-wins |
| `GET /api/events?token=…` | SSE: scan progress, library changes |

Progress posted from the phone lands in the same fingerprint-keyed ledger, so
Continue Watching stays in sync between PC and phone automatically. Security
note: LAN mode is plain HTTP on your local network — keep it off on networks
you don't trust.

## Watching from outside the house

Settings → *Remote access* → **Reach this PC from outside the house**.

Locality downloads `cloudflared` (once, into `<dataDir>\bin`) and opens an
outbound Cloudflare tunnel to its own loopback port. Because the connection is
outbound there is no router setup, no public IP and no certificate work, and it
works behind carrier-grade NAT. Cloudflare hands back a
`https://<name>.trycloudflare.com` URL and terminates TLS at its edge.

Nobody has to type that URL. The desktop publishes it to your account's `servers`
row alongside the LAN and Tailscale addresses, and the phone tries them in order,
stopping at the first that answers — LAN at home, the tunnel when you're out. If
the saved address stops working the phone re-resolves it automatically
(`ServerLocator`), so leaving the house doesn't need a re-pair.

Two consequences worth knowing:

- The URL changes every time cloudflared restarts. That's fine for the phone,
  which follows the published value, but don't bookmark it.
- Your video passes through Cloudflare's edge on the way, and the access token is
  all that stands between the internet and your library. Turning remote access on
  therefore replaces any legacy short token with a 128-bit one; phones paired by
  signing in pick the new token up on their own.

Auth hardening that comes with it: requests carrying `CF-Ray` / `X-Forwarded-For`
are never treated as local even though cloudflared connects over loopback (see
`services/requestOrigin.ts`), failed token attempts are rate limited per client,
tokens are compared in constant time, and `PUT /api/settings` is refused for
anything but the PC itself.

## Architecture

```
electron/main.ts          Electron shell: window, dialogs, starts the server
electron/server/          Self-contained local server layer (no Electron imports —
                          a future remote-access layer can host it as-is)
  index.ts                Express wiring, 127.0.0.1-only listener
  db.ts                   SQLite schema (libraries, media_items, seasons, episodes,
                          files, watch_progress, subtitles, settings)
  routes/media.ts         Libraries, scanning, item listings/detail, TMDB matching, settings
  routes/player.ts        Playback (mpv + HTML5), range streaming, progress, subtitles
  services/
    parser.ts             Release-name parser (SxxEyy, 1x01, Season folders, dotted names)
    scanner.ts            Incremental scan + TMDB metadata/image caching
    tmdb.ts               TMDB client, local image cache (no CDN hotlinking)
    progressLedger.ts     Portable locality.json ledger (see below)
    mpv.ts                mpv spawn + JSON-IPC remote control
    subtitles.ts          Sidecar detection, SRT/ASS→VTT, OpenSubtitles API
    watcher.ts            Optional chokidar background scanning
src/                      React renderer (HashRouter, Tailwind "5arye" dark/gold theme)
```

## Portable watch progress — `Documents\Locality\locality.json`

Watch progress is mirrored from SQLite into a single human-readable JSON file
keyed by a **path-independent fingerprint** (`sha1(filename + size)`), so the
same file is recognized on any machine regardless of drive letters or folder
layout. Copy the file to the same place on another machine and Locality merges
it automatically — at startup *and* live while running (the file is watched).
Merging is entry-by-entry with newest `last_updated` winning; one machine's
copy never wholesale-replaces the other's.

Data folder (DB + image cache): `%APPDATA%\Locality`.

## Attribution

This product uses the TMDB API but is not endorsed or certified by
[TMDB](https://www.themoviedb.org). Additional metadata from
[TVmaze](https://www.tvmaze.com) and [AniList](https://anilist.co); subtitle
search via [OpenSubtitles.com](https://www.opensubtitles.com).

Playback uses a bundled [FFmpeg](https://ffmpeg.org) binary (via `ffmpeg-static`),
which is licensed separately under the LGPL/GPL; it is invoked as a standalone
subprocess, not linked into the application.

## License

Locality is released under the **MIT License** (see [LICENSE](LICENSE)). It plays
media you already have on your own machine; it does not provide, index, or stream
any content itself.
