// Runs the end-to-end smoke test under Electron's copy of Node.
//
// better-sqlite3 in this project is built for Electron's ABI (see `npm run
// rebuild`), so stock `node` can't load it. ELECTRON_RUN_AS_NODE makes the
// Electron binary behave as a plain Node runtime, which has the matching ABI.
// Done in JS rather than inline env syntax so it works in cmd, PowerShell and sh.
const { spawnSync } = require("child_process");
const electron = require("electron"); // resolves to the binary path outside Electron

const files = process.argv.slice(2);
const args = ["--test", ...(files.length ? files : ["tests/smoke.test.js"])];

const run = spawnSync(electron, args, {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

if (run.error) {
  console.error(run.error);
  process.exit(1);
}
process.exit(run.status ?? 1);
