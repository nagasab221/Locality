// Bundle entry for the end-to-end smoke test. better-sqlite3 and ffmpeg-static
// stay external: the former is compiled for Electron's ABI, which is why this
// bundle is run with `electron` in ELECTRON_RUN_AS_NODE mode rather than node.
export { startServer } from "../electron/server/index";
