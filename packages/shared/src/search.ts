import type { SearchRequest, SearchResponse, SearchHit } from "./index.js";
import { publicScene } from "./public.js";
import { searchRequestSchema } from "./schemas.js";
import type { AI } from "./ai.js";
import type { Store } from "./store.js";
import type { Graph } from "./graph.js";
import { entityMatches } from "./temporal.js";

export async function search(
  services: {
    ai: Pick<AI, "embed" | "plan" | "verifyAction">;
    store: Pick<Store, "vectorCandidates" | "getScene">;
    graph: Pick<Graph, "match" | "matchEvidence">
  },
  input: SearchRequest
): Promise<SearchResponse> {
  const request = searchRequestSchema.parse(input);
  const plan = await services.ai.plan(request.query);
  const embedding = await services.ai.embed(request.query);
  const candidates = await services.store.vectorCandidates(embedding, Math.min(100, (request.limit ?? 10) * 5));
  const hits: SearchHit[] = [];
  const needsActionEvidence = !!plan.semanticConstraints?.length;
  let evidenceCalls = 0;
  for (const candidate of candidates) {
    const scene = await services.store.getScene(candidate.scene.videoId, candidate.scene.id);
    if (!scene || scene.graphStatus !== "ready" || scene.metadataVersion !== candidate.scene.metadataVersion ||
        !Number.isFinite(candidate.distance)) continue;
    // Reject impossible candidates before the cross-region graph call; every
    // surviving result still requires native MATCH and active-version checks.
    if (!plan.entities.every(expected => scene.entities.some(entity => entityMatches(entity, expected)))) continue;
    const intervals = await services.graph.match(scene, plan);
    if (!intervals.length) continue;
    let matchedTimecode = intervals[0];
    let semanticExplanation = "";
    if (needsActionEvidence) {
      // Bound model work independently of vector top-K; response remains non-exhaustive.
      if (evidenceCalls >= 20) break;
      evidenceCalls++;
      const proof = await services.ai.verifyAction(request.query, plan, scene);
      if (!proof.matched) continue;
      const verified = await services.graph.matchEvidence(scene, plan, proof);
      if (!verified) continue;
      matchedTimecode = verified;
      semanticExplanation = ` Ação conferida nas evidências temporais: ${proof.explanation}`;
    }
    const current = await services.store.getScene(scene.videoId, scene.id);
    if (!current || current.graphStatus !== "ready" || current.metadataVersion !== scene.metadataVersion) continue;
    hits.push({
      scene: publicScene(current), score: Math.max(0, Math.min(1, 1 - candidate.distance)),
      rationale: `${plan.explanation}${semanticExplanation} Relações verificadas no grafo nativo, versão ${scene.metadataVersion}; ` +
        "este intervalo visual é estimado. A recuperação de candidatos não é exaustiva.",
      matchedTimecode, graphVerified: true
    });
    if (hits.length >= (request.limit ?? 10)) break;
  }
  return { query: request.query, hits, plan, retrieval: "vector-graph", exhaustive: false };
}
