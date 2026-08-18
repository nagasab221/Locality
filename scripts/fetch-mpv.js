// Downloads the latest Windows mpv build and extracts mpv.exe into
// resources/mpv/ so electron-builder bundles it (win.extraResources) and end
// users never install mpv. Convenience for reproducible builds — if it fails,
// drop mpv.exe into resources/mpv/ manually (see resources/mpv/README.md).
//
// Source: zhongfly/mpv-winbuild GitHub releases (the de-facto Windows builds).
// mpv is GPL; Locality is GPL-3.0, so bundling it is license-compatible.
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { execFileSync } = require("child_process");

const DEST_DIR = path.join(__dirname, "..", "resources", "mpv");
const DEST = path.join(DEST_DIR, "mpv.exe");
const RELEASES_API = "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest";

/** GET with a User-Agent and one level of redirect following (asset -> CDN). */
function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "locality-build" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function readJson(url) {
  const res = await get(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function download(url, dest) {
  const res = await get(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on("finish", () => out.close(() => resolve()));
    out.on("error", reject);
  });
}

(async () => {
  if (fs.existsSync(DEST)) {
    console.log("mpv already present at", DEST, "- delete it to re-fetch.");
    return;
  }
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log("Finding the latest mpv Windows build…");
  const rel = await readJson(RELEASES_API);
  // The plain 64-bit player build: "mpv-x86_64-<date>-git-<hash>.7z".
  // Skip the -dev (libmpv headers) and -v3 (needs newer CPUs) variants.
  const asset = (rel.assets || []).find(
    (a) => /^mpv-x86_64-\d.*\.7z$/.test(a.name) && !/dev/.test(a.name)
  );
  if (!asset) throw new Error("no mpv-x86_64 .7z asset in the latest release");

  const tmp = path.join(os.tmpdir(), asset.name);
  console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB)…`);
  await download(asset.browser_download_url, tmp);

  console.log("Extracting mpv.exe…");
  // Windows' bundled tar (bsdtar/libarchive) reads 7-Zip archives.
  execFileSync("tar", ["-xf", tmp, "-C", DEST_DIR, "mpv.exe"], { stdio: "inherit" });
  fs.rmSync(tmp, { force: true });

  if (!fs.existsSync(DEST)) throw new Error("extraction produced no mpv.exe");
  console.log("Done ->", DEST);
})().catch((e) => {
  console.error("\nfetch-mpv failed:", e.message);
  console.error("Drop mpv.exe into resources/mpv/ manually. See resources/mpv/README.md");
  process.exit(1);
});
