import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { exportBrowserVideo, requireBrowserVideoEncoder } from "../src/browser-video-export.js";

const roots: string[] = [];
const initialFfmpeg = process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH;

afterEach(async () => {
  if (initialFfmpeg === undefined) delete process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH;
  else process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH = initialFfmpeg;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-video-export-"));
  roots.push(root);
  return root;
}

const exec = promisify(execFile);
const realFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 10_000 });
const realEncodingAvailable = realFfmpeg.status === 0 &&
  /\blibx264\b/u.test(realFfmpeg.stdout) && /\bgif\b/u.test(realFfmpeg.stdout);

describe("browser media exports", () => {
  (realEncodingAvailable ? it : it.skip)("produces a genuine GIF and H.264 MP4 from a WebM source", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "real-source.webm");
    await exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=0.6", "-an",
      "-c:v", "libvpx", "-y", source], { timeout: 30_000 });
    const gif = path.join(root, "real.gif");
    const mp4 = path.join(root, "real.mp4");
    await expect(exportBrowserVideo(source, gif, "gif", 2_000_000)).resolves.toBeGreaterThan(0);
    await expect(exportBrowserVideo(source, mp4, "mp4", 2_000_000)).resolves.toBeGreaterThan(0);
    expect((await readFile(gif)).toString("ascii", 0, 6)).toBe("GIF89a");
    expect((await readFile(mp4)).toString("ascii", 4, 8)).toBe("ftyp");
  }, 30_000);

  it("keeps WebM native and rejects unavailable or untrusted export inputs", async () => {
    await expect(requireBrowserVideoEncoder("webm")).resolves.toBeUndefined();
    const root = await temporaryRoot();
    process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH = path.join(root, "no-ffmpeg");
    await expect(requireBrowserVideoEncoder("mp4")).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
    await expect(exportBrowserVideo(path.join(root, "a.webm"), path.join(root, "other", "b.mp4"),
      "mp4", 100_000)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  (process.platform === "win32" ? it.skip : it)(
    "validates the full encoder and converts GIF/MP4 without shell interpolation",
    async () => {
      const root = await temporaryRoot();
      const executable = path.join(root, "fake-ffmpeg.cjs");
      const argumentsFile = path.join(root, "arguments.json");
      await writeFile(executable,
        "#!/usr/bin/env node\n" +
        "const fs = require('node:fs');\n" +
        "const args = process.argv.slice(2);\n" +
        "if (args.includes('-encoders')) {\n" +
        "  process.stdout.write(' V..... gif GIF encoder\\n V..... libx264 H.264 encoder\\n');\n" +
        "} else {\n" +
        "  fs.writeFileSync(require('node:path').join(__dirname, 'arguments.json'), JSON.stringify(args));\n" +
        "  const target = args.at(-1);\n" +
        "  fs.writeFileSync(target, target.endsWith('.gif') ? 'GIF89a' : 'fake-mp4-with-ftyp');\n" +
        "}\n",
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      process.env.MCP_BROWSER_MEDIA_FFMPEG_PATH = executable;
      const source = path.join(root, "demo.webm");
      await writeFile(source, "webm-source");
      for (const format of ["gif", "mp4"] as const) {
        const target = path.join(root, "demo." + format);
        await expect(exportBrowserVideo(source, target, format, 1_000_000)).resolves.toBeGreaterThan(0);
        const bytes = await readFile(target);
        expect(bytes.toString("utf8")).toContain(format === "gif" ? "GIF89a" : "ftyp");
        const args = JSON.parse(await readFile(argumentsFile, "utf8")) as string[];
        expect(args).toContain(source);
        expect(args).toContain("-nostdin");
        expect(args).toContain("-n");
        expect(args.at(-1)).toBe(target);
        expect(args).toContain(format === "gif" ? "gif" : "libx264");
      }
      await expect(exportBrowserVideo(source, path.join(root, "too-big.gif"), "gif", 1))
        .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      await expect(readFile(path.join(root, "too-big.gif"))).rejects.toThrow();
    },
  );
});
