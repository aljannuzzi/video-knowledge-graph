import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  captureFrame, clipArgs, extractClip, frameArgs, parseProbe, probeMedia, sceneWindows, zipFiles
} from "./media.js";

const validProbe = () => ({
  streams: [{ codec_type: "video", avg_frame_rate: "30000/1001", duration: "12.5" }],
  format: { duration: "12.5" }
});

test("probe parses real rational fps and container or stream durations", () => {
  assert.deepEqual(parseProbe(validProbe()), { durationSeconds: 12.5, fps: 30000 / 1001 });
  assert.deepEqual(parseProbe({
    streams: [{ codec_type: "video", r_frame_rate: "24/1", duration: "2.25" }]
  }), { durationSeconds: 2.25, fps: 24 });
  assert.deepEqual(parseProbe({
    streams: [{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "25/1" }],
    format: { duration: 180 }
  }), { durationSeconds: 180, fps: 25 });
  const probe = validProbe();
  probe.format.duration = "N/A";
  assert.equal(parseProbe(probe).durationSeconds, 12.5);
  probe.format.duration = "13";
  assert.equal(parseProbe(probe).durationSeconds, 12.5);
});

test("probe requires an actual video stream, not audio or cover art", () => {
  for (const input of [null, [], {}, "{}", 42, { streams: {} }, { streams: [] },
    { streams: [null, false, { codec_type: "audio" }], format: { duration: 1 } },
    { streams: [{ codec_type: "video", disposition: { attached_pic: 1 }, avg_frame_rate: "1/1" }],
      format: { duration: 1 } },
    { streams: [{ codec_type: "video", disposition: { timed_thumbnails: 1 }, avg_frame_rate: "1/1" }],
      format: { duration: 1 } }]) {
    assert.throws(() => parseProbe(input));
  }
  const probe = validProbe();
  assert.equal(parseProbe({ ...probe, streams: [null, { codec_type: "audio" }, ...probe.streams] }).fps, 30000 / 1001);
  assert.equal(parseProbe({
    ...probe, streams: [
      { codec_type: "video", disposition: { attached_pic: 1 }, avg_frame_rate: "0/0" },
      ...probe.streams
    ]
  }).fps, 30000 / 1001);
});

test("trailing audio cannot create a sampling window past the video stream", () => {
  const probe = parseProbe({
    streams: [{ codec_type: "video", avg_frame_rate: "30/1", duration: "12" },
      { codec_type: "audio", duration: "13" }],
    format: { duration: "13" }
  });
  assert.equal(probe.durationSeconds, 12);
  assert.equal(sceneWindows(probe.durationSeconds).length, 1);
});

test("probe rejects missing, malformed, nonpositive or nonfinite fps", () => {
  for (const fps of [undefined, null, 30, "30", "", "N/A", "NaN/1", "Infinity/1",
    "1/0", "0/1", "-24/1", "24/-1", "1.5/1", "1/1/1", " 24/1", "0/0", `${"9".repeat(400)}/1`]) {
    const probe = validProbe();
    assert.throws(() => parseProbe({
      ...probe, streams: [{ ...probe.streams[0], avg_frame_rate: fps }]
    }));
  }
  assert.throws(() => parseProbe({
    streams: [{ codec_type: "video", avg_frame_rate: "bad", r_frame_rate: "24/1" }],
    format: { duration: 1 }
  }));
});

test("probe validates every available duration and enforces a maximum of 180 seconds", () => {
  for (const value of [null, "", " ", true, [], {}, "NaN", "Infinity", "0x10", "-1",
    0, -1, Infinity, NaN, "1e999", 180.001]) {
    assert.throws(() => parseProbe({ ...validProbe(), format: { duration: value } }));
    assert.throws(() => parseProbe({
      streams: [{ ...validProbe().streams[0], duration: value }], format: { duration: 1 }
    }));
  }
  assert.throws(() => parseProbe({ streams: [{ codec_type: "video", avg_frame_rate: "24/1" }] }));
  assert.throws(() => parseProbe(validProbe(), 12));
  for (const max of [0, -1, NaN, Infinity, 181]) assert.throws(() => parseProbe(validProbe(), max));
  assert.equal(parseProbe(validProbe(), 12.5).durationSeconds, 12.5);
});

test("scene windows are deterministic, bounded, and preserve fractional tails", () => {
  const expected = [
    { id: "scene-0001", timecode: { startSeconds: 0, endSeconds: 12 }, frameSeconds: [0, 2, 4, 6, 8, 10] },
    { id: "scene-0002", timecode: { startSeconds: 12, endSeconds: 24 }, frameSeconds: [12, 14, 16, 18, 20, 22] },
    { id: "scene-0003", timecode: { startSeconds: 24, endSeconds: 24.125 }, frameSeconds: [24] }
  ];
  assert.deepEqual(sceneWindows(24.125), expected);
  assert.deepEqual(sceneWindows(24.125), expected);
  assert.deepEqual(sceneWindows(0.001), [
    { id: "scene-0001", timecode: { startSeconds: 0, endSeconds: 0.001 }, frameSeconds: [0] }
  ]);
  assert.deepEqual(sceneWindows(2)[0].frameSeconds, [0]);
  assert.equal(sceneWindows(12).length, 1);
  const full = sceneWindows(180);
  assert.equal(full.length, 15);
  assert.equal(full[14].id, "scene-0015");
  assert.equal(full[14].timecode.endSeconds, 180);
  for (const scene of full) {
    assert.ok(scene.frameSeconds.length <= 6);
    assert.ok(scene.frameSeconds.every(s => s >= scene.timecode.startSeconds && s < scene.timecode.endSeconds));
  }
  for (const seconds of [0, -1, NaN, Infinity, 180.001]) assert.throws(() => sceneWindows(seconds));
});

test("FFmpeg argument arrays seek accurately, map safely, and restrict demuxers and protocols", () => {
  const source = "a space & $(not-a-command).mp4";
  const frame = frameArgs(source, 1.25, "a frame.jpg");
  const clip = clipArgs(source, { startSeconds: 1.25, endSeconds: 2.75 }, "a clip.mp4");
  for (const args of [frame, clip]) {
    assert.equal(args[args.indexOf("-i") + 1], resolve(source));
    assert.ok(args.indexOf("-ss") > args.indexOf("-i"));
    assert.equal(args[args.indexOf("-map") + 1], "0:V:0");
    assert.equal(args[args.indexOf("-ss") + 1], "1.25");
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
    const formats = args[args.indexOf("-format_whitelist") + 1].split(",");
    for (const forbidden of ["hls", "dash", "concat", "image2", "sdp"]) {
      assert.ok(!formats.includes(forbidden));
    }
    assert.ok(args.indexOf("-format_whitelist") < args.indexOf("-i"));
    assert.ok(args.includes("-nostdin"));
  }
  assert.equal(frame.at(-1), resolve("a frame.jpg"));
  assert.equal(frame[frame.indexOf("-frames:v") + 1], "1");
  assert.equal(frame[frame.indexOf("-c:v") + 1], "mjpeg");
  assert.match(frame[frame.indexOf("-vf") + 1], /min\(1024,iw\).*min\(1024,ih\).*decrease/);
  assert.equal(clip[clip.indexOf("-t") + 1], "1.5");
  assert.equal(clip[clip.indexOf("-c:v") + 1], "libx264");
  assert.equal(clip[clip.indexOf("-c:a") + 1], "aac");
  assert.ok(clip.includes("0:a:0?"));
  assert.equal(clip[clip.indexOf("-movflags") + 1], "+faststart");
  assert.equal(clip[clip.indexOf("-f") + 1], "mp4");
  assert.equal(clip[clip.indexOf("-vf") + 1], "pad=ceil(iw/2)*2:ceil(ih/2)*2");
});

test("argument builders reject invalid bounds and protocol paths", () => {
  for (const seconds of [-1, NaN, Infinity, 180, 181]) {
    assert.throws(() => frameArgs("input.mp4", seconds, "output.jpg"));
  }
  for (const timecode of [
    { startSeconds: -1, endSeconds: 1 }, { startSeconds: 1, endSeconds: 1 },
    { startSeconds: 2, endSeconds: 1 }, { startSeconds: 0, endSeconds: 180.1 },
    { startSeconds: NaN, endSeconds: 1 }, { startSeconds: 0, endSeconds: Infinity }
  ]) assert.throws(() => clipArgs("input.mp4", timecode, "output.mp4"));
  assert.ok(clipArgs("input.mp4", { startSeconds: 179.5, endSeconds: 180 }, "output.mp4"));
  for (const path of ["", " ", "a\0.mp4", "https://host/video", "file:input.mp4", "concat:a|b", "pipe:0"]) {
    assert.throws(() => frameArgs(path, 0, "output.jpg"));
    assert.throws(() => frameArgs("input.mp4", 0, path));
    assert.throws(() => clipArgs(path, { startSeconds: 0, endSeconds: 1 }, "output.mp4"));
  }
});

test("pre-aborted operations reject without requiring FFmpeg or archiver", async () => {
  const controller = new AbortController();
  controller.abort("cancelled by test");
  const signal = controller.signal;
  for (const action of [
    () => probeMedia("missing.mp4", signal),
    () => captureFrame("missing.mp4", 0, "unused.jpg", signal),
    () => extractClip("missing.mp4", { startSeconds: 0, endSeconds: 1 }, "unused.mp4", signal),
    () => zipFiles([], "unused.zip", signal)
  ]) await assert.rejects(action, { name: "AbortError" });
});

test("ZIP rejects unsafe, duplicate or self-referencing names before loading archiver", async () => {
  for (const name of ["", "../escape", "/absolute", "a/../escape", "C:drive", "a\\b", "a//b", "./a", "a\0b", "folder/"]) {
    await assert.rejects(zipFiles([{ path: "missing.txt", name }], "out.zip"), /safe relative paths/);
  }
  await assert.rejects(zipFiles([
    { path: "missing.txt", name: "same" }, { path: "other.txt", name: "same" }
  ], "out.zip"), /unique/);
  await assert.rejects(zipFiles([{ path: "out.zip", name: "self.zip" }], "out.zip"), /own destination/);
});

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function scratch(): Promise<string> {
  const root = join(workerRoot, ".work");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "media-test-"));
}

const hasFfmpeg = ["ffmpeg", "ffprobe"].every(command =>
  spawnSync(command, ["-version"], { shell: false, windowsHide: true, timeout: 10_000, stdio: "ignore" }).status === 0
);
const archiverName = "archiver";
const hasArchiver = await import(archiverName).then(() => true, () => false);

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    shell: false, windowsHide: true, timeout: 30_000, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

test("real FFmpeg probes, scales JPEGs, clips with and without audio, and rejects playlists", {
  skip: !hasFfmpeg, timeout: 60_000
}, async () => {
  const dir = await scratch();
  try {
    const source = join(dir, "source with spaces & chars.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1200x600:rate=24", "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=44100", "-t", "2.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
    const probe = await probeMedia(source);
    assert.equal(probe.fps, 24);
    assert.ok(Math.abs(probe.durationSeconds - 2.5) < 0.1);
    const frame = join(dir, "frame.jpg");
    await captureFrame(source, 0.5, frame);
    const jpeg = await readFile(frame);
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    const dimensions = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height",
      "-of", "json", frame], { shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000 });
    assert.equal(dimensions.status, 0, dimensions.stderr);
    const stream = JSON.parse(dimensions.stdout).streams[0];
    assert.equal(stream.width, 1024);
    assert.equal(stream.height, 512);
    for (const audio of [true, false]) {
      const input = audio ? source : join(dir, "silent.mp4");
      if (!audio) ffmpeg(["-i", source, "-an", "-c:v", "copy", input]);
      const output = join(dir, `clip-${audio}.mp4`);
      await extractClip(input, { startSeconds: 0.5, endSeconds: 1.5 }, output);
      assert.ok(Math.abs((await probeMedia(output)).durationSeconds - 1) < 0.15);
      const bytes = await readFile(output);
      assert.ok(bytes.indexOf("moov") > 0 && bytes.indexOf("moov") < bytes.indexOf("mdat"));
    }
    const odd = join(dir, "odd.mkv");
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=321x241:rate=24", "-t", "1",
      "-c:v", "ffv1", odd]);
    const even = join(dir, "even.mp4");
    await extractClip(odd, { startSeconds: 0.125, endSeconds: 0.625 }, even);
    assert.ok(Math.abs((await probeMedia(even)).durationSeconds - 0.5) < 0.15);
    const playlist = join(dir, "disguised.mp4");
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/private\n#EXT-X-ENDLIST\n");
    await assert.rejects(probeMedia(playlist), /ffprobe failed/);
    await assert.rejects(probeMedia(join(dir, "missing.mp4")), /ffprobe failed/);
    const aborted = new AbortController();
    const pending = captureFrame(source, 0.5, join(dir, "cancel.jpg"), aborted.signal);
    aborted.abort();
    await assert.rejects(pending, { name: "AbortError" });
    for (const action of [
      (signal: AbortSignal) => probeMedia(source, signal),
      (signal: AbortSignal) => extractClip(source, { startSeconds: 0, endSeconds: 2 }, join(dir, "cancel.mp4"), signal)
    ]) {
      const controller = new AbortController();
      const operation = action(controller.signal);
      controller.abort();
      await assert.rejects(operation, { name: "AbortError" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Read the ZIP central directory and inflate entries, rather than trusting the extension.
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    entries.set(bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
      method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("real archiver writes complete ZIPs, preserves existing files, and handles failures and cancellation", {
  skip: !hasArchiver, timeout: 30_000
}, async () => {
  const dir = await scratch();
  try {
    const input = join(dir, "input.txt");
    await writeFile(input, "actual file content\n");
    const destination = join(dir, "output.zip");
    await zipFiles([{ path: input, name: "nested/input.txt" }], destination);
    const entries = unzip(await readFile(destination));
    assert.equal(entries.size, 1);
    assert.equal(entries.get("nested/input.txt")?.toString(), "actual file content\n");
    await assert.rejects(zipFiles([], destination), /EEXIST/);
    assert.equal(unzip(await readFile(destination)).size, 1);
    const empty = join(dir, "empty.zip");
    await zipFiles([], empty);
    assert.equal(unzip(await readFile(empty)).size, 0);
    await assert.rejects(zipFiles([{ path: join(dir, "missing"), name: "missing" }], join(dir, "missing.zip")), /ENOENT/);
    await assert.rejects(zipFiles([{ path: dir, name: "directory" }], join(dir, "directory.zip")), /regular files/);
    await assert.rejects(zipFiles([], join(dir, "missing-folder", "bad.zip")), /ENOENT/);
    const controller = new AbortController();
    const cancelled = join(dir, "cancelled.zip");
    const pending = zipFiles([{ path: input, name: "input.txt" }], cancelled, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(readFile(cancelled), /ENOENT/);
    const large = join(dir, "large.bin");
    await writeFile(large, randomBytes(8 * 1024 * 1024));
    const activeController = new AbortController();
    const activeOutput = join(dir, "active.zip");
    const watcher = watch(dir, (_event, name) => {
      if (name === "active.zip") activeController.abort();
    });
    try {
      await assert.rejects(zipFiles([{ path: large, name: "large.bin" }], activeOutput, activeController.signal),
        { name: "AbortError" });
      assert.equal(activeController.signal.aborted, true);
      await assert.rejects(readFile(activeOutput), /ENOENT/);
    } finally {
      watcher.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
