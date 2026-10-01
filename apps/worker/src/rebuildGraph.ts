import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServices, loadConfig } from "@vkg/shared/server";

export async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  let projected = 0;
  let markedReady = 0;
  let skippedStale = 0;
  let failures = 0;
  try {
    const videos = await services.store.listVideos();
    console.error(`[rebuild-graph] videos=${videos.length}`);
    for (const video of videos) {
      const scenes = await services.store.listScenes(video.id);
      console.error(`[rebuild-graph] video=${video.id} scenes=${scenes.length}`);
      for (const scene of scenes) {
        try {
          await services.graph.project(scene);
          projected++;
          const latest = await services.store.getScene(scene.videoId, scene.id);
          if (!latest || latest.metadataVersion !== scene.metadataVersion) {
            skippedStale++;
            console.error(`[rebuild-graph] stale ${scene.videoId}/${scene.id}@${scene.metadataVersion}`);
            continue;
          }
          if (latest.graphStatus !== "ready") {
            await services.store.saveScene({ ...latest, graphStatus: "ready" });
            markedReady++;
          }
        } catch (error) {
          failures++;
          const message = error instanceof Error ? error.message : "unknown";
          console.error(`[rebuild-graph] failed ${scene.videoId}/${scene.id}@${scene.metadataVersion}: ${message}`);
        }
      }
    }
  } finally {
    await services.graph.close();
  }
  console.error(`[rebuild-graph] projected=${projected} markedReady=${markedReady} skippedStale=${skippedStale} failures=${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`[rebuild-graph] fatal: ${message}`);
    process.exitCode = 1;
  });
}
