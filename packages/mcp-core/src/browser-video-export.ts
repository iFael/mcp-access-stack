import { execFile } from "node:child_process";
import { chmod, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.js";

const run = promisify(execFile);

export type BrowserVideoFormat = "webm" | "gif" | "mp4";

function ffmpegExecutable(): string {
  const configured = process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) {
      throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED",
        "MCP_BROWSER_MEDIA_FFMPEG_PATH must name an absolute FFmpeg executable.");
    }
    return configured;
  }
  return "ffmpeg";
}

/** The Playwright FFmpeg build only encodes WebM. GIF/MP4 require a full FFmpeg. */
export async function requireBrowserVideoEncoder(format: BrowserVideoFormat): Promise<void> {
  if (format === "webm") return;
  try {
    const { stdout } = await run(ffmpegExecutable(), ["-hide_banner", "-encoders"], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    const codec = format === "gif" ? "gif" : "libx264";
    if (!new RegExp(`^\\s*V\\S*\\s+${codec}\\s`, "m").test(stdout)) {
      throw new Error("Required video encoder unavailable.");
    }
  } catch {
    throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED",
      `Full FFmpeg with ${format === "gif" ? "GIF" : "H.264/libx264"} encoding is required for ${format} previews.`);
  }
}

/**
 * Transcode a completed, MCP-owned WebM artifact. Both paths are minted by the
 * recorder inside its private artifact directory, never supplied by a user.
 */
export async function exportBrowserVideo(
  sourcePath: string,
  targetPath: string,
  format: Exclude<BrowserVideoFormat, "webm">,
  maxBytes: number,
): Promise<number> {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath) ||
      path.dirname(sourcePath) !== path.dirname(targetPath) ||
      sourcePath === targetPath || path.extname(sourcePath).toLowerCase() !== ".webm" ||
      path.extname(targetPath).toLowerCase() !== `.${format}`) {
    throw new AppError("INVALID_ARGUMENT", "Video export requires distinct private artifact paths.");
  }
  await requireBrowserVideoEncoder(format);
  const codecArguments = format === "gif"
    ? [
        "-filter_complex",
        "[0:v]fps=10,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-loop", "0", "-f", "gif",
      ]
    : [
        "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4",
      ];
  try {
    await run(ffmpegExecutable(), [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", sourcePath, "-an", ...codecArguments, "-n", targetPath,
    ], { timeout: 120_000, maxBuffer: 8_192, windowsHide: true });
    const output = await stat(targetPath);
    if (!output.isFile() || output.size === 0 || output.size > maxBytes) {
      throw new AppError("LIMIT_EXCEEDED", "Exported video is empty or exceeds the artifact size limit.");
    }
    await chmod(targetPath, 0o600);
    return output.size;
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError("BROWSER_WORKER_UNAVAILABLE",
      `Failed to encode ${format} preview with full FFmpeg. Check the runtime's supported codecs.`,
      { cause: error });
  }
}
