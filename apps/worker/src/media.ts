import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

type Timecode = { startSeconds: number; endSeconds: number };
type Probe = { durationSeconds: number; fps: number };
type SceneWindow = { id: string; timecode: Timecode; frameSeconds: number[] };

const MAX_SECONDS = 180;
// Excludes playlists, concat, image sequences and other indirect-input demuxers.
// MOV external data references remain disabled (FFmpeg's default).
const INPUT_OPTIONS = [
  "-protocol_whitelist", "file,pipe",
  "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegvideo,mpegts,flv,ogg,asf"
];

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be finite and between ${min} and ${max}`);
  }
  return value;
}

function duration(value: unknown, max: number): number {
  if (typeof value !== "number" && (
    typeof value !== "string" ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
  )) {
    throw new TypeError("Invalid media duration");
  }
  const result = bounded(Number(value), "Duration", 0, max);
  if (result === 0) throw new RangeError("Duration must be positive");
  return result;
}

function frameRate(value: unknown): number {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) {
    throw new TypeError("Video frame rate must be a positive rational");
  }
  const [numerator, denominator] = value.split("/").map(Number);
  const fps = numerator / denominator;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) ||
      numerator <= 0 || denominator <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError("Invalid video frame rate");
  }
  return fps;
}

export function parseProbe(json: unknown, maxSeconds = MAX_SECONDS): Probe {
  duration(maxSeconds, MAX_SECONDS);
  const root = object(json);
  const streams = root?.streams;
  if (!Array.isArray(streams)) throw new TypeError("Probe has no streams");
  const video = streams.map(object).find(stream =>
    stream?.codec_type === "video" && object(stream.disposition)?.attached_pic !== 1 &&
    object(stream.disposition)?.timed_thumbnails !== 1
  );
  if (!video) throw new TypeError("Media must contain a video stream");
  const rate = video.avg_frame_rate === undefined || video.avg_frame_rate === "0/0"
    ? video.r_frame_rate
    : video.avg_frame_rate;
  const fps = frameRate(rate);
  const candidates = [object(root?.format)?.duration, video.duration]
    .filter(value => value !== undefined && value !== "N/A");
  if (!candidates.length) throw new TypeError("Probe has no duration");
  // Validate both: a short container duration must not mask an oversized stream.
  const durations = candidates.map(value => duration(value, maxSeconds));
  // Trailing audio must not produce windows beyond the last video frame.
  const videoDuration = video.duration === undefined || video.duration === "N/A"
    ? undefined : duration(video.duration, maxSeconds);
  return { durationSeconds: videoDuration ?? Math.max(...durations), fps };
}

export function sceneWindows(durationSeconds: number): SceneWindow[] {
  duration(durationSeconds, MAX_SECONDS);
  const windows: SceneWindow[] = [];
  for (let startSeconds = 0; startSeconds < durationSeconds; startSeconds += 12) {
    const endSeconds = Math.min(startSeconds + 12, durationSeconds);
    const frameSeconds: number[] = [];
    for (let seconds = startSeconds; seconds < endSeconds && frameSeconds.length < 6; seconds += 2) {
      frameSeconds.push(seconds);
    }
    windows.push({
      id: `scene-${String(windows.length + 1).padStart(4, "0")}`,
      timecode: { startSeconds, endSeconds },
      frameSeconds
    });
  }
  return windows;
}

function localPath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0") ||
      (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) {
    throw new TypeError("Expected a local filesystem path, not a URL or protocol");
  }
  return resolve(path);
}

export function frameArgs(source: string, seconds: number, dest: string): string[] {
  bounded(seconds, "Frame timestamp", 0, MAX_SECONDS);
  if (seconds === MAX_SECONDS) throw new RangeError("Frame timestamp must be below 180 seconds");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    ...INPUT_OPTIONS, "-i", localPath(source), "-ss", String(seconds),
    "-map", "0:V:0", "-an", "-frames:v", "1",
    "-vf", "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease",
    "-c:v", "mjpeg", "-q:v", "2", "-f", "image2", "-update", "1", localPath(dest)
  ];
}

export function clipArgs(source: string, timecode: Timecode, dest: string): string[] {
  const start = bounded(timecode.startSeconds, "Clip start", 0, MAX_SECONDS);
  const end = bounded(timecode.endSeconds, "Clip end", 0, MAX_SECONDS);
  if (end <= start) throw new RangeError("Clip end must be after its start");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    ...INPUT_OPTIONS, "-i", localPath(source), "-ss", String(start), "-t", String(end - start),
    "-map", "0:V:0", "-map", "0:a:0?", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4", localPath(dest)
  ];
}

function abortError(signal: AbortSignal): Error {
  const error = new Error("Media operation aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failure: Error | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      // No shell or process-name killing: terminate only this task's direct child.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const onAbort = () => stop(abortError(signal!));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) stop(new Error(`${command} output exceeded 8 MiB`));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.on("error", error => { failure ??= error; });
    child.once("close", (code, killedBy) => {
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) {
        reject(new Error(`${command} failed (${killedBy ?? code}): ${stderr.trim()}`));
      } else resolveRun(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal?.aborted) onAbort();
  });
}

export async function probeMedia(path: string, signal?: AbortSignal): Promise<Probe> {
  const json = await run("ffprobe", [
    "-v", "error", ...INPUT_OPTIONS,
    "-show_entries", "format=duration:stream=codec_type,duration,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic,timed_thumbnails",
    "-of", "json", "-i", localPath(path)
  ], signal);
  return parseProbe(JSON.parse(json));
}

export async function captureFrame(
  source: string, seconds: number, dest: string, signal?: AbortSignal
): Promise<void> {
  await run("ffmpeg", frameArgs(source, seconds, dest), signal);
}

export async function extractClip(
  source: string, timecode: Timecode, dest: string, signal?: AbortSignal
): Promise<void> {
  await run("ffmpeg", clipArgs(source, timecode, dest), signal);
}

// Minimal structural surface for compilation before dependencies are installed.
// archiver is a required runtime dependency for export jobs.
type Archive = Readable & {
  append(source: Readable, options: { name: string }): Archive;
  finalize(): Promise<void>;
  abort(): Archive;
};
type ArchiveFactory = (format: "zip", options: { zlib: { level: number } }) => Archive;

export async function zipFiles(
  files: Array<{ path: string; name: string }>, destination: string, signal?: AbortSignal
): Promise<void> {
  checkAbort(signal);
  const target = localPath(destination);
  const names = new Set<string>();
  const entries = files.map(file => {
    const { name } = file;
    if (typeof name !== "string" || !name || /[\\:\0]/.test(name) ||
        name.split("/").some(part => !part || part === "." || part === "..") || names.has(name)) {
      throw new TypeError("ZIP entry names must be unique safe relative paths");
    }
    names.add(name);
    const path = localPath(file.path);
    if (path === target) throw new TypeError("ZIP cannot include its own destination");
    return { path, name };
  });
  for (const entry of entries) {
    checkAbort(signal);
    if (!(await stat(entry.path)).isFile()) throw new TypeError("ZIP inputs must be regular files");
  }
  const moduleName = "archiver";
  const imported = await import(moduleName) as { default?: ArchiveFactory };
  if (typeof imported.default !== "function") throw new TypeError("Invalid archiver module");
  checkAbort(signal);
  const archive = imported.default("zip", { zlib: { level: 9 } });
  // Exclusive creation avoids truncating existing files or deleting them on failure.
  const output = createWriteStream(target, { flags: "wx" });
  return new Promise<void>((resolveZip, reject) => {
    const inputs: Array<{ stream: ReadStream; completion: Promise<void> }> = [];
    let created = false;
    let closed = false;
    let finalized = false;
    let settled = false;
    let failure: Error | undefined;
    const finish = () => {
      if (settled || !closed || (!failure && !finalized)) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void Promise.all(inputs.map(input => input.completion)).then(async () => {
        if (!failure) { resolveZip(); return; }
        if (created) {
          try { await rm(target, { force: true }); }
          catch (cleanupError) {
            reject(new AggregateError([failure, cleanupError], "ZIP failed and partial archive could not be removed"));
            return;
          }
        }
        reject(failure);
      });
    };
    const fail = (reason: unknown) => {
      if (failure || settled) return;
      failure = reason instanceof Error ? reason : new Error(String(reason));
      archive.unpipe(output);
      try { archive.abort(); } catch { /* Still close the owned streams. */ }
      for (const input of inputs) input.stream.destroy();
      archive.destroy();
      output.destroy();
      finish();
    };
    const onAbort = () => fail(abortError(signal!));
    output.once("open", () => { created = true; });
    output.on("error", fail);
    archive.on("error", fail);
    archive.on("warning", fail);
    output.once("close", () => {
      closed = true;
      if (!output.writableFinished && !failure) fail(new Error("ZIP output closed before completion"));
      finish();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      archive.pipe(output);
      for (const entry of entries) {
        const stream = createReadStream(entry.path);
        stream.on("error", fail);
        inputs.push({ stream, completion: finished(stream, { cleanup: true }).catch(() => undefined) });
        archive.append(stream, { name: entry.name });
        if (failure) break;
      }
      if (failure) return;
      void archive.finalize().then(() => { finalized = true; finish(); }, fail);
    } catch (error) { fail(error); }
  });
}
