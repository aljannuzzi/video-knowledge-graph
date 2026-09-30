import type { Job, VideoAsset, SceneMetadata } from "./index.js";

export function publicVideo(video: VideoAsset): VideoAsset {
  return {
    id: video.id, title: video.title, filename: video.filename, status: video.status,
    createdAt: video.createdAt, sceneCount: video.sceneCount, jobId: video.jobId, assetUri: video.assetUri,
    ...(video.durationSeconds === undefined ? {} : { durationSeconds: video.durationSeconds }),
    ...(video.fps === undefined ? {} : { fps: video.fps })
  };
}
export function publicJob(job: Job): Job {
  return {
    id: job.id, kind: job.kind, status: job.status, progress: job.progress, stage: job.stage,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.videoId === undefined ? {} : { videoId: job.videoId }),
    ...(job.sceneIds === undefined ? {} : { sceneIds: [...job.sceneIds] }),
    ...(job.outputUri === undefined ? {} : { outputUri: job.outputUri }),
    ...(job.error === undefined ? {} : { error: job.error })
  };
}
export function publicScene(scene: SceneMetadata): SceneMetadata {
  return {
    id: scene.id, videoId: scene.videoId, videoTitle: scene.videoTitle,
    assetUri: scene.assetUri, thumbnailUri: scene.thumbnailUri,
    timecode: { ...scene.timecode }, transcript: scene.transcript, caption: scene.caption,
    entities: scene.entities.map(entity => ({
      id: entity.id, type: entity.type, name: entity.name, confidence: entity.confidence,
      ...(entity.identitySource === "editor" && entity.actorName
        ? { actorName: entity.actorName, identitySource: "editor" as const } : {})
    })),
    relations: scene.relations.map(relation => ({
      id: relation.id, subject: relation.subject, predicate: relation.predicate, object: relation.object,
      confidence: relation.confidence, evidence: relation.evidence, timecode: { ...relation.timecode }
    })),
    tags: [...scene.tags], evidenceFrames: scene.evidenceFrames.map(frame => ({ ...frame })),
    model: scene.model, metadataVersion: scene.metadataVersion,
    boundarySource: scene.boundarySource, graphStatus: scene.graphStatus
  };
}
