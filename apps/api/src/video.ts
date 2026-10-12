import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_CHAT_VIDEO_BYTES, MAX_CHAT_VIDEO_SECONDS } from "@private-chat/contracts";

const run = promisify(execFile);
const inputOptions = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm"];

/** Validate the actual media, normalize for iOS, discard location/metadata.
 * Never log decoder output: it can contain private media metadata.
 * The HTTP handler admits one conversion at a time before buffering uploads.
 */
export async function processChatVideo(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_CHAT_VIDEO_BYTES) throw new Error("INVALID_VIDEO");
  const isMp4 = input.length >= 12 && input.subarray(4, 8).toString("ascii") === "ftyp";
  const isWebm = input.length >= 4 && input.readUInt32BE(0) === 0x1a45dfa3;
  if (!isMp4 && !isWebm) throw new Error("INVALID_VIDEO");
  const directory = await fs.mkdtemp(join(tmpdir(), "private-chat-video-"));
  const source = join(directory, "input");
  const output = join(directory, "video.mp4");
  try {
    await fs.writeFile(source, input, { mode: 0o600 });
    const { stdout } = await run("ffprobe", ["-v", "error", ...inputOptions,
      "-show_entries", "format=duration,format_name:stream=codec_type,width,height,duration",
      "-of", "json", source], { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
    };
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(probe.format?.duration);
    if (!video?.width || !video.height || video.width * video.height > 33_177_600 ||
      video.width > 8192 || video.height > 8192 || !Number.isFinite(duration) ||
      duration <= 0 || duration > MAX_CHAT_VIDEO_SECONDS ||
      !(probe.format?.format_name?.split(",").some((name) => ["mov", "mp4", "matroska", "webm"].includes(name)))) {
      throw new Error("INVALID_VIDEO");
    }
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-threads", "2", ...inputOptions, "-i", source,
      "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
      "-vf", "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      "-r", "30", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "24",
      "-maxrate", "2000k", "-bufsize", "4000k", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000",
      "-t", String(MAX_CHAT_VIDEO_SECONDS), "-fs", String(MAX_CHAT_VIDEO_BYTES),
      "-movflags", "+faststart", output],
    { timeout: 180000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size >= MAX_CHAT_VIDEO_BYTES) throw new Error("INVALID_VIDEO");
    return await fs.readFile(output);
  } catch {
    throw new Error("INVALID_VIDEO");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** One byte range, including suffixes, as used by Safari's media player. */
export function parseVideoRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(end)) return null;
    end = Math.min(end, size - 1);
  }
  return Number.isSafeInteger(start) && start >= 0 && start < size && end >= start
    ? { start, end } : null;
}
