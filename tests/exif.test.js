// The EXIF taken-date reader. Buffers are hand-built so the tests pin the
// byte-level format walk (JPEG segments -> APP1 -> TIFF -> sub-IFD) in both
// endiannesses without fixture files.
const test = require("node:test");
const assert = require("node:assert/strict");
const { exifTakenDate } = require("../dist/test/lib.cjs");

/** TIFF block: IFD0 -> Exif sub-IFD -> DateTimeOriginal "2023:08:15 14:30:00". */
function tiffWithDateTimeOriginal(le) {
  const t = Buffer.alloc(64);
  const w16 = (v, o) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const w32 = (v, o) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  t.write(le ? "II" : "MM", 0, "latin1");
  w16(0x2a, 2);
  w32(8, 4); // IFD0 at 8
  w16(1, 8); // one entry
  w16(0x8769, 10); // Exif sub-IFD pointer
  w16(4, 12); // LONG
  w32(1, 14);
  w32(26, 18); // sub-IFD offset
  w32(0, 22); // no next IFD
  w16(1, 26); // sub-IFD: one entry
  w16(0x9003, 28); // DateTimeOriginal
  w16(2, 30); // ASCII
  w32(20, 32);
  w32(44, 36); // value offset
  w32(0, 40);
  t.write("2023:08:15 14:30:00\0", 44, "latin1");
  return t;
}

function jpegWith(tiff) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 4); // segment size includes itself
  return Buffer.concat([head, payload]);
}

const EXPECTED = new Date(2023, 7, 15, 14, 30, 0).toISOString();

test("DateTimeOriginal is read from little-endian EXIF", () => {
  assert.equal(exifTakenDate(jpegWith(tiffWithDateTimeOriginal(true))), EXPECTED);
});

test("DateTimeOriginal is read from big-endian EXIF", () => {
  assert.equal(exifTakenDate(jpegWith(tiffWithDateTimeOriginal(false))), EXPECTED);
});

test("plain DateTime in IFD0 is the fallback", () => {
  const t = Buffer.alloc(46);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(0x2a, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);
  t.writeUInt16LE(0x0132, 10); // DateTime
  t.writeUInt16LE(2, 12);
  t.writeUInt32LE(20, 14);
  t.writeUInt32LE(26, 18);
  t.writeUInt32LE(0, 22);
  t.write("2023:08:15 14:30:00\0", 26, "latin1");
  assert.equal(exifTakenDate(jpegWith(t)), EXPECTED);
});

test("non-JPEG, EXIF-less JPEG and truncated buffers return null", () => {
  assert.equal(exifTakenDate(Buffer.from("definitely a text file")), null);
  assert.equal(exifTakenDate(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0])), null);
  assert.equal(exifTakenDate(jpegWith(tiffWithDateTimeOriginal(true)).subarray(0, 30)), null);
  assert.equal(exifTakenDate(Buffer.alloc(0)), null);
});

test("garbage dates are rejected", () => {
  const t = tiffWithDateTimeOriginal(true);
  t.write("0000:99:99 99:99:99\0", 44, "latin1");
  assert.equal(exifTakenDate(jpegWith(t)), null);
});
