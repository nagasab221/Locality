import crypto from "crypto";
import path from "path";

/**
 * Cross-machine media fingerprint. Deliberately path-independent:
 * keyed on (lowercased filename + byte size) so the same file is recognized
 * on another machine regardless of drive letter / folder layout.
 */
export function fingerprintFile(filePath: string, sizeBytes: number): string {
  const name = path.basename(filePath).toLowerCase();
  const h = crypto.createHash("sha1").update(`${name}|${sizeBytes}`).digest("hex");
  return `fp_${h.slice(0, 20)}`;
}
