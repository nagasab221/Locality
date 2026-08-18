# Bundled mpv

The experimental mpv playback engine needs an `mpv.exe` here. It is **not**
committed to git (it's ~40-70 MB); it's fetched at build time and bundled into
the installer via electron-builder's `win.extraResources`, so end users never
install mpv themselves.

## Get it

Automatic (recommended):

```
npm run fetch:mpv
```

That downloads the latest Windows mpv build and extracts `mpv.exe` into this
folder.

Manual: download a Windows build from https://mpv.io/installation/ (the
shinchiro / zhongfly builds), extract it, and drop `mpv.exe` (plus any DLLs the
build ships) into this folder as `resources/mpv/mpv.exe`.

## How it's found at runtime

`findMpv()` (in `electron/mpvPlayer.ts`) resolves, in order:

1. the `mpvPath` setting (a custom path a power user set),
2. the bundled binary (`resources/mpv/mpv.exe` in dev, `resources/mpv/mpv.exe`
   under the app's resources when packaged),
3. a drop-in at `%APPDATA%\Locality (Claude)\bin\mpv.exe`,
4. `mpv.exe` on PATH.

So a dev run picks up the file in this folder, and a packaged build picks up the
copy electron-builder placed under `resources/`.

## Licensing

mpv is GPL (built on ffmpeg/libass). Locality is GPL-3.0, so bundling it is
compatible. Keep attribution for mpv/ffmpeg/libass in the About section.
