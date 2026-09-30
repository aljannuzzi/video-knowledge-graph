import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { z } from "zod";
import type { AppConfig, ClipExtractionRequest } from "@vkg/shared";
import {
  clipRequestSchema, identityRequestSchema, publicJob, publicScene, publicVideo,
  search, searchRequestSchema, type createServices
} from "@vkg/shared/server";
import { createAuth } from "./auth.js";
import { asyncRoute, HttpError, identifier, rateLimit } from "./http.js";
import { mediaHandler } from "./media.js";
import { dispatch, MAX_UPLOAD_MB, projectRoot, uploadHandler } from "./upload.js";
import { validateClip } from "./validation.js";

type Services = ReturnType<typeof createServices>;

export function createApp(services: Services) {
  const { config, store } = services;
  const app = express();
  const auth = createAuth(config);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    if (config.environment === "azure") response.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "video-kg-api" }));
  app.use("/api", rateLimit(600, 60_000), (_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.get("/api/config", (_request, response) => {
    const publicConfig: AppConfig = {
      name: "Video Knowledge Graph",
      mode: config.environment,
      authRequired: !config.authDisabled,
      aiConfigured: true,
      graphConfigured: true,
      visionModel: config.visionDeployment,
      embeddingModel: config.embeddingDeployment,
      maxUploadMb: MAX_UPLOAD_MB
    };
    response.json(publicConfig);
  });
  app.use("/api", auth.csrf);
  app.get("/api/session", auth.status);
  app.post("/api/session", auth.loginLimit, express.json({ limit: "8kb" }), auth.login);
  app.delete("/api/session", auth.logout);
  app.use("/api", auth.requireAuth);
  app.use("/api", express.json({ limit: "128kb" }));

  app.get("/api/videos", asyncRoute(async (_request, response) => {
    response.json({ videos: (await store.listVideos()).map(publicVideo) });
  }));
  app.get("/api/videos/:videoId", asyncRoute(async (request, response) => {
    const video = await store.getVideo(identifier(request.params.videoId));
    if (!video) throw new HttpError(404, "video_not_found");
    response.json(publicVideo(video));
  }));
  app.post("/api/videos", asyncRoute(uploadHandler(services)));
  app.get("/api/jobs", asyncRoute(async (_request, response) => {
    response.json({ jobs: (await store.listDurableJobs()).map(publicJob) });
  }));
  app.get("/api/jobs/:jobId", asyncRoute(async (request, response) => {
    const job = await store.durableJob(identifier(request.params.jobId));
    if (!job) throw new HttpError(404, "job_not_found");
    response.json(publicJob(job));
  }));
  app.get(["/api/videos/:videoId/scenes", "/api/scenes"], asyncRoute(async (request, response) => {
    const suppliedId = request.params.videoId ?? request.query.videoId;
    if (suppliedId === undefined) {
      const scenes = [];
      for (const video of await store.listVideos()) {
        scenes.push(...(await store.listScenes(video.id)).map(publicScene));
      }
      response.json({ scenes });
      return;
    }
    const videoId = identifier(suppliedId);
    if (!await store.getVideo(videoId)) throw new HttpError(404, "video_not_found");
    response.json({ scenes: (await store.listScenes(videoId)).map(publicScene) });
  }));
  const getScene = async (videoId: unknown, sceneId: unknown) => {
    const scene = await store.getScene(identifier(videoId), identifier(sceneId));
    if (!scene) throw new HttpError(404, "scene_not_found");
    return scene;
  };
  app.get(["/api/videos/:videoId/scenes/:sceneId", "/api/scenes/:videoId/:sceneId"], asyncRoute(async (request, response) => {
    response.json(publicScene(await getScene(request.params.videoId, request.params.sceneId)));
  }));
  app.get(["/api/videos/:videoId/scenes/:sceneId/graph", "/api/graph/:videoId/:sceneId"], asyncRoute(async (request, response) => {
    const scene = await getScene(request.params.videoId, request.params.sceneId);
    if (scene.graphStatus !== "ready") {
      response.status(409).json({ error: "graph_not_ready", graphStatus: scene.graphStatus });
      return;
    }
    const graph = await services.graph.getScene(scene);
    // Do not return a formerly active graph when an editor changed the occurrence during traversal.
    const current = await getScene(scene.videoId, scene.id);
    if (current.metadataVersion !== scene.metadataVersion || current.graphStatus !== "ready") {
      throw new HttpError(409, "graph_not_ready");
    }
    response.json(graph);
  }));
  app.patch(["/api/videos/:videoId/scenes/:sceneId/identity", "/api/scenes/:videoId/:sceneId/identity"], asyncRoute(async (request, response) => {
    const payload = identityRequestSchema.parse(request.body);
    const scene = await getScene(request.params.videoId, request.params.sceneId);
    const entity = scene.entities.find((candidate) => candidate.id === payload.entityId);
    if (!entity) throw new HttpError(404, "entity_not_found");
    if (entity.type !== "person") throw new HttpError(400, "identity_requires_person");
    const updated = await store.updateIdentity(scene.videoId, scene.id, payload.entityId, payload.actorName);
    let job = store.pendingReindexJob(updated);
    try {
      job = await store.createJob({
        kind: "reindex", videoId: updated.videoId, sceneIds: [updated.id],
        payload: { videoId: updated.videoId, sceneId: updated.id, metadataVersion: updated.metadataVersion }
      });
      await dispatch(services, job);
    } catch {
      console.error(JSON.stringify({ event: "scene_reindex_job_deferred", sceneId: updated.id, jobId: job.id }));
    }
    response.setHeader("Location", `/api/jobs/${encodeURIComponent(job.id)}`);
    response.setHeader("X-Identity-Scope", "This scene occurrence only; no cross-scene identity inference");
    response.status(202).json(publicScene(updated));
  }));
  app.post("/api/search", asyncRoute(async (request, response) => {
    const result = await search(services, searchRequestSchema.parse(request.body));
    response.json(result);
  }));
  app.post(["/api/clips/extract", "/api/clips"], asyncRoute(async (request, response) => {
    const payload: ClipExtractionRequest = clipRequestSchema.parse(request.body);
    if (payload.clips.length > 30 || payload.clips.length === 0) throw new HttpError(400, "invalid_clip_count");
    for (const clip of payload.clips) {
      identifier(clip.videoId);
      identifier(clip.sceneId);
      const [video, scene] = await Promise.all([
        store.getVideo(clip.videoId), store.getScene(clip.videoId, clip.sceneId)
      ]);
      validateClip(clip, video, scene);
    }
    const videoIds = new Set(payload.clips.map((clip) => clip.videoId));
    const job = await store.createJob({
      kind: "export", videoId: videoIds.size === 1 ? payload.clips[0].videoId : undefined,
      sceneIds: [...new Set(payload.clips.map((clip) => clip.sceneId))], payload
    });
    await dispatch(services, job);
    response.status(202).json(publicJob(job));
  }));
  app.get("/api/media/:container/*", asyncRoute(mediaHandler(services)));
  app.use("/api", (_request, response) => response.status(404).json({ error: "not_found" }));

  const frontend = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.join(projectRoot, "apps", "frontend", "dist");
  if (existsSync(path.join(frontend, "index.html"))) {
    app.use(express.static(frontend, { index: false, dotfiles: "deny" }));
    app.get("*", (request, response, next) => {
      if (!request.accepts("html")) return next();
      response.setHeader("Cache-Control", "no-cache");
      response.sendFile(path.join(frontend, "index.html"));
    });
  }
  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) return next(error);
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "invalid_request", details: error.flatten() });
    } else if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.code });
    } else if (error instanceof URIError) {
      response.status(400).json({ error: "invalid_uri" });
    } else if (error instanceof multer.MulterError) {
      response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: error.code === "LIMIT_FILE_SIZE" ? "upload_too_large" : "invalid_upload"
      });
    } else if (error && typeof error === "object" && "type" in error &&
      ["entity.parse.failed", "entity.too.large", "encoding.unsupported", "charset.unsupported",
        "request.aborted", "request.size.invalid"].includes(String(error.type))) {
      response.status(error.type === "entity.too.large" ? 413 : 400).json({ error: "invalid_request_body" });
    } else {
      console.error(JSON.stringify({ event: "api_request_failed", name: error instanceof Error ? error.name : "Error" }));
      response.status(500).json({ error: "internal_error" });
    }
  });
  return app;
}
