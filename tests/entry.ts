// Bundle entry for the test suite: re-exports the pure server functions so
// esbuild can emit one dependency-free CJS file that plain `node --test` can
// require (the real server pulls in better-sqlite3, which is built for
// Electron's ABI and can't load under stock node).
export { parseMediaPath, normalizeTitle } from "../electron/server/services/parser";
export { pickBestMatch } from "../electron/server/services/matchScore";
export { exifTakenDate } from "../electron/server/services/exif";
export { fingerprintFile } from "../electron/server/services/fingerprint";
export { isLocalRequest, clientKey } from "../electron/server/services/requestOrigin";
export { parseTunnelUrl } from "../electron/server/services/tunnel";
