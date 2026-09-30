import type { SearchRequest, SearchResponse, SearchHit } from "./index.js";
import { publicScene } from "./public.js";
import { searchRequestSchema } from "./schemas.js";
import type { AI } from "./ai.js";
import type { Store } from "./store.js";
import type { Graph } from "./graph.js";

export async function search(
  services: { ai: Pick<AI, "embed" | "plan">; store: Pick<Store, "vectorCandidates" | "getScene">; graph: Pick<Graph, "match"> },
  input: SearchRequest
): Promise<SearchResponse> {
  const request = searchRequestSchema.parse(input);
  const plan = await services.ai.plan(request.query);
  const embedding = await services.ai.embed(request.query);
  const candidates = await services.store.vectorCandidates(embedding, Math.min(100, (request.limit ?? 10) * 5));
  const hits: SearchHit[] = [];
  for (const candidate of candidates) {
    const scene = await services.store.getScene(candidate.scene.videoId, candidate.scene.id);
    if (!scene || scene.graphStatus !== "ready" || scene.metadataVersion !== candidate.scene.metadataVersion ||
        !Number.isFinite(candidate.distance)) continue;
    const intervals = await services.graph.match(scene, plan);
    if (!intervals.length) continue;
    const current = await services.store.getScene(scene.videoId, scene.id);
    if (!current || current.graphStatus !== "ready" || current.metadataVersion !== scene.metadataVersion) continue;
    hits.push({
      scene: publicScene(current), score: Math.max(0, Math.min(1, 1 - candidate.distance)),
      rationale: `${plan.explanation} Native graph bindings verified against active version ${scene.metadataVersion}; ` +
        "relations share this estimated visual interval. Vector candidate retrieval is non-exhaustive.",
      matchedTimecode: intervals[0], graphVerified: true
    });
    if (hits.length >= (request.limit ?? 10)) break;
  }
  return { query: request.query, hits, plan, retrieval: "vector-graph", exhaustive: false };
}
