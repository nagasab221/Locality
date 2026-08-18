import { spawn } from "child_process";
import type { DB } from "../db";
import { getSetting } from "../db";
import { ffmpegPath } from "./introDetect";

export interface HwAccelConfig {
  encoder: string;
  name: string;
  videoArgs: string[];
  inputArgs: string[];
}

let cachedDetectedEncoder: string | null = null;
let isDetecting = false;

/**
 * Test if a specific encoder can successfully encode 1 frame using FFmpeg.
 */
function testEncoder(encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostdin",
      "-f", "lavfi", "-i", "testsrc=duration=0.1:size=320x240:rate=1",
      "-c:v", encoder,
      "-f", "null", "-",
    ];
    const proc = spawn(ffmpegPath(), args);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Detect the best working GPU hardware encoder on this system.
 */
export async function detectBestHardwareEncoder(): Promise<string> {
  if (cachedDetectedEncoder) return cachedDetectedEncoder;
  if (isDetecting) return "libx264";
  isDetecting = true;
  try {
    if (await testEncoder("h264_nvenc")) {
      console.log("hwaccel: detected working NVIDIA NVENC GPU encoder");
      cachedDetectedEncoder = "h264_nvenc";
      return "h264_nvenc";
    }
    if (await testEncoder("h264_qsv")) {
      console.log("hwaccel: detected working Intel QuickSync (QSV) GPU encoder");
      cachedDetectedEncoder = "h264_qsv";
      return "h264_qsv";
    }
    if (await testEncoder("h264_amf")) {
      console.log("hwaccel: detected working AMD AMF GPU encoder");
      cachedDetectedEncoder = "h264_amf";
      return "h264_amf";
    }
  } catch (e) {
    console.error("hwaccel detection error:", e);
  } finally {
    isDetecting = false;
  }
  console.log("hwaccel: using CPU software libx264 encoder");
  cachedDetectedEncoder = "libx264";
  return "libx264";
}

export function resetHwAccelCache() {
  cachedDetectedEncoder = null;
}

export async function getHwAccelConfig(db: DB): Promise<HwAccelConfig> {
  const setting = (getSetting(db, "hwaccel") || "auto").trim().toLowerCase();

  let encoder = setting;
  if (setting === "auto") {
    encoder = await detectBestHardwareEncoder();
  }

  if (encoder === "nvenc" || encoder === "h264_nvenc") {
    return {
      encoder: "h264_nvenc",
      name: "NVIDIA NVENC",
      inputArgs: ["-hwaccel", "auto"],
      videoArgs: [
        "-c:v", "h264_nvenc",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-g", "48", "-keyint_min", "48",
        "-b:v", "8M", "-maxrate", "12M", "-bufsize", "24M",
      ],
    };
  }

  if (encoder === "qsv" || encoder === "h264_qsv") {
    return {
      encoder: "h264_qsv",
      name: "Intel QuickSync",
      inputArgs: ["-hwaccel", "auto"],
      videoArgs: [
        "-c:v", "h264_qsv",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-g", "48", "-keyint_min", "48",
        "-b:v", "8M", "-maxrate", "12M", "-bufsize", "24M",
      ],
    };
  }

  if (encoder === "amf" || encoder === "h264_amf") {
    return {
      encoder: "h264_amf",
      name: "AMD AMF",
      inputArgs: ["-hwaccel", "auto"],
      videoArgs: [
        "-c:v", "h264_amf",
        "-quality", "speed",
        "-pix_fmt", "yuv420p",
        "-g", "48", "-keyint_min", "48",
        "-b:v", "8M", "-maxrate", "12M", "-bufsize", "24M",
      ],
    };
  }

  // Fallback: CPU software encoding
  return {
    encoder: "libx264",
    name: "CPU (libx264)",
    inputArgs: [],
    videoArgs: [
      "-c:v", "libx264",
      "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
      "-maxrate", "12M", "-bufsize", "24M",
    ],
  };
}
