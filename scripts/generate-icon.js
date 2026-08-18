// Renders assets/logo.svg into assets/icon.ico (multi-size) + assets/icon.png.
// Same approach as the sibling "5arye" apps: sharp for rasterizing, to-ico for
// packing. Run via: npm run icon   (sharp/to-ico are devDependencies)
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const toIco = require("to-ico");

(async () => {
  const assets = path.join(__dirname, "..", "assets");
  const svg = fs.readFileSync(path.join(assets, "logo.svg"));
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = await Promise.all(
    sizes.map((s) => sharp(svg, { density: 300 }).resize(s, s).png().toBuffer())
  );
  fs.writeFileSync(path.join(assets, "icon.ico"), await toIco(pngs));
  fs.writeFileSync(
    path.join(assets, "icon.png"),
    await sharp(svg, { density: 300 }).resize(512, 512).png().toBuffer()
  );
  console.log("written: assets/icon.ico, assets/icon.png");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
