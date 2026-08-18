// Minimal EXIF reader: just enough to pull the taken-date out of a JPEG.
// File dates lie the moment photos are copied between machines; the EXIF
// DateTimeOriginal survives. No dependency — the format walk is small: JPEG
// segments -> APP1 "Exif" -> TIFF IFD0 -> Exif sub-IFD -> tag 0x9003.
// Everything is bounds-checked and any weirdness returns null (caller falls
// back to the file's mtime).
import fs from "fs";

const u16 = (b: Buffer, o: number, le: boolean) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
const u32 = (b: Buffer, o: number, le: boolean) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));

interface IfdEntry {
  type: number;
  count: number;
  at: number; // offset of the 4-byte value/offset field, relative to TIFF start
}

function ifdEntries(t: Buffer, off: number, le: boolean): Map<number, IfdEntry> {
  const out = new Map<number, IfdEntry>();
  if (off < 8 || off + 2 > t.length) return out;
  const n = u16(t, off, le);
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > t.length) break;
    out.set(u16(t, e, le), { type: u16(t, e + 2, le), count: u32(t, e + 4, le), at: e + 8 });
  }
  return out;
}

/** ASCII tag value; EXIF date strings are exactly 20 bytes with a NUL. */
function asciiValue(t: Buffer, entry: IfdEntry | undefined, le: boolean): string | null {
  if (!entry || entry.type !== 2 || entry.count < 1 || entry.count > 64) return null;
  const off = entry.count <= 4 ? entry.at : u32(t, entry.at, le);
  if (off < 0 || off + entry.count > t.length) return null;
  return t.toString("latin1", off, off + entry.count).replace(/\0+$/, "").trim();
}

/** "2023:08:15 14:30:00" -> ISO. EXIF has no timezone; treat as local time
 *  (consistent with the mtime-derived dates it replaces). */
function toIso(s: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (isNaN(d.getTime()) || d.getFullYear() < 1980 || d.getFullYear() > 2100) return null;
  return d.toISOString();
}

function tiffDate(t: Buffer): string | null {
  if (t.length < 8) return null;
  const bom = t.toString("latin1", 0, 2);
  const le = bom === "II";
  if (!le && bom !== "MM") return null;
  if (u16(t, 2, le) !== 0x2a) return null;

  const ifd0 = ifdEntries(t, u32(t, 4, le), le);
  const exifPtr = ifd0.get(0x8769); // Exif sub-IFD pointer
  if (exifPtr && (exifPtr.type === 4 || exifPtr.type === 3) && exifPtr.count === 1) {
    const sub = ifdEntries(t, u32(t, exifPtr.at, le), le);
    const s =
      asciiValue(t, sub.get(0x9003), le) ?? // DateTimeOriginal
      asciiValue(t, sub.get(0x9004), le); // DateTimeDigitized
    const iso = s ? toIso(s) : null;
    if (iso) return iso;
  }
  const s = asciiValue(t, ifd0.get(0x0132), le); // plain DateTime, last resort
  return s ? toIso(s) : null;
}

/** Taken-date from an in-memory JPEG head, or null. Never throws. */
export function exifTakenDate(buf: Buffer): string | null {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG
    let o = 2;
    while (o + 4 <= buf.length) {
      if (buf[o] !== 0xff) return null;
      const marker = buf[o + 1];
      if (marker >= 0xd0 && marker <= 0xd9) {
        o += 2; // standalone marker, no length field
        continue;
      }
      const size = buf.readUInt16BE(o + 2);
      if (size < 2) return null;
      if (marker === 0xe1 && o + 10 <= buf.length && buf.toString("latin1", o + 4, o + 10) === "Exif\0\0") {
        return tiffDate(buf.subarray(o + 10, o + 2 + size));
      }
      if (marker === 0xda) return null; // compressed data begins — no EXIF past here
      o += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

/** EXIF sits in the first segments, so only the head of the file is read. */
export async function readTakenDate(filePath: string): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return exifTakenDate(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
