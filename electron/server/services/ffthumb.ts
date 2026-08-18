// One scaled JPEG frame via ffmpeg — used for "Other" video posters and Gallery
// thumbnails (photos and clips alike; ffmpeg reads images too).
import { spawn } from "child_process";
import fs from "fs";
import { ffmpegPath } from "./introDetect";

/**
 * Write a single scaled JPEG to `outPath`. For video, `at` seeks first (cheap
 * keyframe seek). Resolves true only when a non-empty file was produced.
 */
export function extractFrame(
  input: string,
  outPath: string,
  opts: { at?: number; width?: number } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      ...(opts.at && opts.at > 0 ? ["-ss", String(opts.at)] : []),
      "-i", input,
      "-frames:v", "1",
      "-vf", `scale=${opts.width ?? 320}:-2:force_original_aspect_ratio=decrease`,
      "-q:v", "5",
      "-y", outPath,
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true });
    } catch {
      return resolve(false);
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => {
      const ok = code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      resolve(ok);
    });
  });
}
