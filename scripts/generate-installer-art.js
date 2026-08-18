// Renders the themed NSIS installer bitmaps (dark background + tan/gold tile,
// matching the app) into assets/. NSIS only accepts BMP, which sharp can't
// emit, so we rasterize to raw pixels and write a 24-bit BMP by hand.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const assets = path.join(__dirname, "..", "assets");

// The app's media-tile glyph (tan rounded square + play cutout), on the dark
// theme. Kept self-contained (no external font) so it renders identically
// wherever the build runs.
const tile = (x, y, size) => `
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.16}" fill="url(#tan)"/>
  <path d="M ${x + size * 0.36} ${y + size * 0.28}
           L ${x + size * 0.36} ${y + size * 0.72}
           L ${x + size * 0.68} ${y + size * 0.5} Z" fill="#0D0D0D"/>`;

const defs = `
  <defs>
    <linearGradient id="tan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#D5B78D"/>
      <stop offset="1" stop-color="#C4A47C"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#141210"/>
      <stop offset="1" stop-color="#0D0D0D"/>
    </linearGradient>
  </defs>`;

const sidebarSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
    ${defs}
    <rect width="164" height="314" fill="url(#bg)"/>
    ${tile(42, 96, 80)}
    <rect x="42" y="210" width="80" height="2" rx="1" fill="#C4A47C"/>
  </svg>`;

const headerSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
    ${defs}
    <rect width="150" height="57" fill="#0D0D0D"/>
    ${tile(101, 8, 40)}
  </svg>`;

/** Encode top-down RGB pixels (w*h*3) as a 24-bit BMP buffer. */
function bmp24(width, height, rgb) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const imgSize = rowSize * height;
  const buf = Buffer.alloc(54 + imgSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(54 + imgSize, 2);
  buf.writeUInt32LE(54, 10); // pixel offset
  buf.writeUInt32LE(40, 14); // DIB header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(imgSize, 34);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // BMP rows are bottom-up
    let off = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = (srcY * width + x) * 3;
      buf[off++] = rgb[s + 2]; // B
      buf[off++] = rgb[s + 1]; // G
      buf[off++] = rgb[s]; // R
    }
  }
  return buf;
}

async function write(name, svg, w, h) {
  const { data } = await sharp(Buffer.from(svg), { density: 300 })
    .resize(w, h)
    .flatten({ background: "#0D0D0D" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  fs.writeFileSync(path.join(assets, name), bmp24(w, h, data));
  console.log("written:", name);
}

(async () => {
  await write("installerSidebar.bmp", sidebarSvg, 164, 314);
  await write("installerHeader.bmp", headerSvg, 150, 57);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
