import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { VideoAsset } from "@vkg/shared";
import { publicJob, publicVideo, type createServices } from "@vkg/shared/server";
import { contentType } from "./media.js";
import { HttpError } from "./http.js";

type Services = ReturnType<typeof createServices>;
type JobRecord = Awaited<ReturnType<Services["store"]["createJob"]>>;
export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const MAX_UPLOAD_MB = 200;
const allowedExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi", ".mpeg", ".mpg"]);
const titleSchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();

export async function dispatch(services: Services, job: JobRecord): Promise<void> {
  try {
    await services.queue.dispatch(job);
  } catch {
    // The persisted job is the outbox; a queue outage must not undo acceptance.
    console.error(JSON.stringify({ event: "queue_dispatch_deferred", jobId: job.id }));
  }
}

export function uploadHandler(services: Services) {
  return async (request: Request, response: Response) => {
    const uploadRoot = process.env.API_UPLOAD_ROOT ?? path.join(homedir(), ".work", "uploads");
    if (!uploadRoot.trim()) throw new Error("API_UPLOAD_ROOT must not be empty");
    const directory = path.join(uploadRoot, randomUUID());
    await mkdir(directory, { recursive: true });
    const receive = multer({
      storage: multer.diskStorage({
        destination: directory,
        filename: (_request, _file, done) => done(null, randomUUID())
      }),
      limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 1, parts: 3, fieldSize: 1024 },
      fileFilter: (_request, file, done) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.has(extension)) {
          done(new HttpError(400, "unsupported_video_format"));
          return;
        }
        done(null, true);
      }
    }).single("video");
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new HttpError(400, "upload_aborted"));
        request.once("aborted", aborted);
        receive(request, response, (error: unknown) => {
          request.off("aborted", aborted);
          if (error instanceof Error && /^(Unexpected end of (form|file|field)|Malformed part header|Multipart: Boundary not found)/.test(error.message)) {
            reject(new HttpError(400, "invalid_upload"));
          } else if (error) reject(error);
          else resolve();
        });
        if (request.aborted) aborted();
      });
      if (!request.file || request.file.size === 0) throw new HttpError(400, "video_required");
      const { title } = titleSchema.parse(request.body);
      const id = randomUUID();
      const originalName = path.posix.basename(request.file.originalname.replace(/\\/g, "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
      const extension = path.extname(originalName).toLowerCase();
      if (!allowedExtensions.has(extension)) throw new HttpError(400, "unsupported_video_format");
      const name = `${id}/source${extension}`;
      const assetUri = await services.blobs.uploadFile("videos", name, request.file.path, contentType(name));
      const createdAt = new Date().toISOString();
      const video: VideoAsset = {
        id, title: title ?? originalName, filename: originalName, status: "queued",
        createdAt, sceneCount: 0, jobId: "", assetUri
      };
      let job = services.store.pendingIngestJob(video);
      video.jobId = job.id;
      await services.store.saveVideo(video);
      try {
        job = await services.store.createJob({ kind: "ingest", videoId: id, payload: { sourceUri: video.assetUri } });
        await dispatch(services, job);
      } catch {
        console.error(JSON.stringify({ event: "video_job_create_deferred", videoId: id, jobId: job.id }));
      }
      response.status(202).json({ video: publicVideo(video), job: publicJob(job) });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}
