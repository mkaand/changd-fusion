import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pngDimensions } from "./image.js";

export const VIDEO_MAX_BYTES = 8_000_000;
const VIDEO_TIMEOUT_MS = 30_000;
let encoding: Promise<void> = Promise.resolve();

function run(executable: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (part: Buffer) => {
      output += part.toString();
      if (output.length > 65_536) child.kill("SIGKILL");
    });
    child.stderr.on("data", (part: Buffer) => {
      stderr += part.toString();
      if (stderr.length > 65_536) child.kill("SIGKILL");
    });
    child.once("error", () => { clearTimeout(timer); reject(Error("Video encoder unavailable")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Error("Video encoding timed out"));
      else if (code !== 0) reject(Error("Video encoding failed"));
      else resolve(output);
    });
  });
}

export type VideoOptions = { ffmpeg?: string; ffprobe?: string; timeoutMs?: number; maxBytes?: number; tempRoot?: string };
export async function encodeVisualVideo(images: Buffer[], options: VideoOptions = {}): Promise<Buffer> {
  // The existing outbox is serial, and this lock also bounds direct concurrent calls.
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const prior = encoding;
  encoding = turn;
  await prior;
  try {
    if (images.length !== 3 || images.some((image) => image.length < 33 || image.length > 4_000_000))
      throw Error("Complete visual PNG set required");
    if (images.reduce((sum, image) => sum + image.length, 0) > 8_000_000)
      throw Error("Visual PNG set too large");
    for (const image of images) pngDimensions(image);
    const dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "fusion-video-"));
    try {
      const names = ["before", "after", "diff"];
      await Promise.all(images.map((image, index) => writeFile(path.join(dir, `${names[index]}.png`), image, { mode: 0o600, flag: "wx" })));
      const output = path.join(dir, "change.mp4");
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-filter_complex_threads", "2"];
      for (const name of names) args.push("-loop", "1", "-framerate", "12", "-t", "2", "-i", path.join(dir, `${name}.png`));
      const filters = names.map((name, index) =>
        `[${index}:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,drawtext=font=Sans:text=${name[0].toUpperCase() + name.slice(1)}:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=12:x=24:y=24[v${index}]`
      );
      args.push("-filter_complex", `${filters.join(";")};[v0][v1][v2]concat=n=3:v=1:a=0,format=yuv420p[v]`,
        "-map", "[v]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "12", "-preset", "veryfast", "-crf", "28",
        "-movflags", "+faststart", "-fs", String(options.maxBytes ?? VIDEO_MAX_BYTES), "-t", "6", output);
      await run(options.ffmpeg ?? "ffmpeg", args, options.timeoutMs ?? VIDEO_TIMEOUT_MS);
      const size = (await stat(output)).size;
      if (size < 1024 || size > (options.maxBytes ?? VIDEO_MAX_BYTES)) throw Error("Video output size invalid");
      const info = JSON.parse(await run(options.ffprobe ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt", "-of", "json", output], 5_000));
      const video = info.streams?.find((stream: any) => stream.codec_type === "video");
      const duration = Number(info.format?.duration);
      if (video?.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || info.streams?.some((stream: any) => stream.codec_type === "audio") || !Number.isFinite(duration) || duration < 5.8 || duration > 6.3)
        throw Error("Video output validation failed");
      const bytes = await readFile(output);
      if (bytes.toString("ascii", 4, 8) !== "ftyp") throw Error("Video output validation failed");
      return bytes;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}
