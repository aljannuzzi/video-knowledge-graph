import assert from "node:assert/strict";
import test from "node:test";
import type { ClipExtractionRequest, SceneMetadata, VideoAsset } from "@vkg/shared";
import { identifier, HttpError } from "./http.js";
import { mediaPath, parseRange, validateClip } from "./validation.js";

test("single byte ranges include bounded, open, suffix and clipped end", () => {
  assert.equal(parseRange(undefined, 100), undefined);
  assert.deepEqual(parseRange("bytes=0-9", 100), { offset: 0, count: 10 });
  assert.deepEqual(parseRange("bytes=90-", 100), { offset: 90, count: 10 });
  assert.deepEqual(parseRange("bytes=-10", 100), { offset: 90, count: 10 });
  assert.deepEqual(parseRange("bytes=-200", 100), { offset: 0, count: 100 });
  assert.deepEqual(parseRange("bytes=95-200", 100), { offset: 95, count: 5 });
});

test("unsatisfiable, multiple and malformed ranges produce 416", () => {
  for (const header of ["bytes=100-", "bytes=3-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4",
    "items=1-2", "bytes=1.5-2", "bytes=9007199254740992-", "bytes=-9007199254740992"]) {
    assert.throws(() => parseRange(header, 100), (error: unknown) => error instanceof HttpError && error.status === 416);
  }
  assert.throws(() => parseRange("bytes=0-", 0), HttpError);
});

test("private media allows only known containers and traversal-free paths", () => {
  assert.deepEqual(mediaPath("videos", "video-id/source.mp4"), { container: "videos", name: "video-id/source.mp4" });
  assert.deepEqual(mediaPath("exports", "job-id/clips.zip"), { container: "exports", name: "job-id/clips.zip" });
  for (const name of ["../secret", "./source.mp4", "video/../source", "video\\source", "/absolute", "video//x",
    "video/%2e%2e/x", "video/x?query", "video/x#hash", "video/\0x"]) {
    assert.throws(() => mediaPath("videos", name), HttpError);
  }
  assert.throws(() => mediaPath("private-secrets", "source.mp4"), HttpError);
});

test("route identifiers reject paths and non-string values", () => {
  assert.equal(identifier("scene-123_456"), "scene-123_456");
  for (const id of ["../scene", "a/b", "", "%2f", ["x"], undefined]) assert.throws(() => identifier(id), HttpError);
});

const scene = {
  id: "scene-1", videoId: "video-1", timecode: { startSeconds: 10, endSeconds: 20 }
} as SceneMetadata;
const video = { id: "video-1", durationSeconds: 30, status: "ready" } as VideoAsset;
const clip = {
  sceneId: "scene-1", videoId: "video-1", timecode: { startSeconds: 10, endSeconds: 20 }
} as ClipExtractionRequest["clips"][number];

test("clip validation accepts scene boundaries and rejects cross-video/cross-scene requests", () => {
  assert.doesNotThrow(() => validateClip(clip, video, scene));
  assert.throws(() => validateClip(clip, undefined, scene), HttpError);
  assert.throws(() => validateClip(clip, video, undefined), HttpError);
  assert.throws(() => validateClip(clip, video, { ...scene, videoId: "other" }), HttpError);
  assert.throws(() => validateClip(clip, video, { ...scene, id: "other" }), HttpError);
});

test("clip bounds must fit finite positive intervals in both scene and video", () => {
  for (const [startSeconds, endSeconds] of [[9, 20], [10, 21], [20, 10], [10, 10], [-1, 15], [NaN, 15], [10, Infinity]]) {
    assert.throws(() => validateClip({ ...clip, timecode: { startSeconds, endSeconds } }, video, scene), HttpError);
  }
  assert.throws(() => validateClip(clip, { ...video, durationSeconds: 19 }, scene), HttpError);
  assert.throws(() => validateClip(clip, { ...video, durationSeconds: undefined }, scene), HttpError);
  assert.throws(() => validateClip(clip, { ...video, status: "processing" }, scene), HttpError);
});
