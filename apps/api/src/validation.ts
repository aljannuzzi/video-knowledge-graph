import type { ClipExtractionRequest, SceneMetadata, VideoAsset } from "@vkg/shared";
import { HttpError } from "./http.js";

export function validateClip(
  clip: ClipExtractionRequest["clips"][number],
  video: VideoAsset | undefined,
  scene: SceneMetadata | undefined
): void {
  if (!video || !scene || video.id !== clip.videoId || scene.videoId !== video.id || scene.id !== clip.sceneId) {
    throw new HttpError(404, "scene_not_found");
  }
  const { startSeconds: start, endSeconds: end } = clip.timecode;
  if (
    !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
    !Number.isFinite(scene.timecode.startSeconds) || !Number.isFinite(scene.timecode.endSeconds) ||
    start < scene.timecode.startSeconds || end > scene.timecode.endSeconds ||
    !Number.isFinite(video.durationSeconds) || end > video.durationSeconds!
  ) {
    throw new HttpError(400, "invalid_clip_bounds");
  }
  if (video.status !== "ready") throw new HttpError(409, "video_not_ready");
}

export type ByteRange = { offset: number; count: number };
export function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new HttpError(416, "invalid_range");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpError(416, "invalid_range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new HttpError(416, "invalid_range");
    }
    end = Math.min(end, size - 1);
  }
  return { offset: start, count: end - start + 1 };
}

export function mediaPath(container: string, name: string): { container: "videos" | "evidence" | "exports"; name: string } {
  if (!["videos", "evidence", "exports"].includes(container)) throw new HttpError(404, "media_not_found");
  if (!name || name.length > 1024 || /[\\%?#\u0000-\u001f\u007f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "invalid_media_path");
  }
  return { container: container as "videos" | "evidence" | "exports", name };
}
