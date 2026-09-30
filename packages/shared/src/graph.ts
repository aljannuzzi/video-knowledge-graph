import { createRequire } from "node:module";
import { DEFAULT_MIN_VERSION } from "node:tls";
import type { Config, SceneRecord } from "./types.js";
import type { QueryPlan, Timecode } from "./index.js";
import type { Store } from "./store.js";
import { compileMatch, graphId, intervalsFromRows, occurrenceId, sceneVertexId } from "./graph-plan.js";
import { normalizeLabel } from "./ontology.js";

interface Client {
  submit(script: string, bindings: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ toArray(): unknown[] }>;
  close(): Promise<void>;
}
type Driver = {
  driver: {
    Client: new (url: string, options: Record<string, unknown>) => Client;
    auth: { PlainTextSaslAuthenticator: new (username: string, password: string) => unknown };
  };
};
type GraphNode = { id: string; label: string; type: string };
type GraphEdge = { id: string; source: string; target: string; label: string; startSeconds: number; endSeconds: number };
export type MaterializedGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export function graphFailure(error: unknown): { statusCode: number; retryAfterMs: number } {
  const details = error instanceof Error ? error.message : "";
  const native = error && typeof error === "object" ? error as { statusCode?: unknown; statusAttributes?: unknown } : {};
  const throttled = Number(native.statusCode) === 429 || /RequestRateTooLargeException|TooManyRequests\s*\(429\)/.test(details);
  const attributes = native.statusAttributes instanceof Map
    ? Object.fromEntries(native.statusAttributes) : native.statusAttributes;
  const delay = attributes && typeof attributes === "object"
    ? Number((attributes as Record<string, unknown>)["x-ms-retry-after-ms"]) : NaN;
  return {
    statusCode: throttled ? 429 : Number(native.statusCode) || 503,
    retryAfterMs: Number.isFinite(delay) && delay > 0 ? Math.min(10_000, delay) : 1000
  };
}

function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

export function gremlinOptions(config: Config, driver: Driver): Record<string, unknown> {
  // 3.4.13 passes rejectUnauthorized through to ws/Node TLS, but DOES NOT pass
  // minVersion. Rely on (and verify) Node 22's TLS >=1.2 default, never weaken TLS.
  if (!["TLSv1.2", "TLSv1.3"].includes(DEFAULT_MIN_VERSION)) throw new Error("Gremlin requires TLS 1.2 or newer");
  return {
    authenticator: new driver.driver.auth.PlainTextSaslAuthenticator(
      `/dbs/${config.gremlinDatabase}/colls/${config.gremlinGraph}`, config.gremlinKey),
    traversalSource: "g", mimeType: "application/vnd.gremlin-v2.0+json",
    rejectUnauthorized: true, connectOnStartup: false
  };
}

export class Graph {
  private readonly client: Client;
  constructor(
    private readonly config: Config,
    private readonly store: Pick<Store, "getScene">,
    client?: Client,
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  ) {
    if (client) { this.client = client; return; }
    const require = createRequire(import.meta.url);
    if (require("gremlin/package.json").version !== "3.4.13") throw new Error("Gremlin driver must be pinned to 3.4.13");
    const driver = require("gremlin") as Driver;
    this.client = new driver.driver.Client(config.gremlinEndpoint, gremlinOptions(config, driver));
  }

  private async submit(script: string, bindings: Record<string, unknown>): Promise<unknown[]> {
    for (let attempt = 0; attempt < 6; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.client.submit(script, bindings, { evaluationTimeout: 25_000 }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void this.client.close().catch(() => undefined);
              reject(Object.assign(new Error("Graph request timed out"), { statusCode: 503 }));
            }, 30_000);
          })
        ]);
        return result.toArray().map(plain);
      } catch (error) {
        clearTimeout(timer);
        const failure = graphFailure(error);
        // Cosmos can wrap a data-plane 429 in a Gremlin 500. Retry this
        // deterministic operation instead of restarting the entire scene.
        if (failure.statusCode === 429 && attempt < 5) {
          await this.sleep(Math.min(10_000, failure.retryAfterMs * 2 ** attempt));
          continue;
        }
        console.error(`[graph] request failed status=${failure.statusCode} attempts=${attempt + 1}`);
        throw Object.assign(new Error(`Graph request failed (${failure.statusCode})`), { statusCode: failure.statusCode });
      } finally { clearTimeout(timer); }
    }
    throw new Error("Graph retry budget exhausted");
  }

  private async vertex(id: string, pk: string, label: "Scene" | "Occurrence" | "Actor", properties: Record<string, string | number>): Promise<void> {
    const bindings: Record<string, unknown> = { vertexId: id, pk, pkKey: this.config.gremlinPartitionKey, vertexLabel: label };
    let script = "g.V([pk,vertexId]).fold().coalesce(unfold(),addV(vertexLabel).property('id',vertexId).property(pkKey,pk))";
    Object.entries(properties).forEach(([key, value], index) => {
      bindings[`key${index}`] = key;
      bindings[`value${index}`] = value;
      script += `.property(single,key${index},value${index})`;
    });
    await this.submit(script, bindings);
  }

  private async edge(
    id: string, source: string, sourcePk: string, target: string, targetPk: string,
    label: "contains" | "observed" | "identifiedAs", properties: Record<string, string | number>
  ): Promise<void> {
    const bindings: Record<string, unknown> = { edgeId: id, source, sourcePk, target, targetPk, edgeLabel: label };
    let script = "g.V([sourcePk,source]).coalesce(__.outE(edgeLabel).hasId(edgeId)," +
      "__.addE(edgeLabel).to(__.V([targetPk,target])).property('id',edgeId))";
    Object.entries(properties).forEach(([key, value], index) => {
      bindings[`key${index}`] = key;
      bindings[`value${index}`] = value;
      script += `.property(key${index},value${index})`;
    });
    await this.submit(script, bindings);
  }

  private async assertCurrent(scene: SceneRecord): Promise<void> {
    const active = await this.store.getScene(scene.videoId, scene.id);
    if (!active || active.metadataVersion !== scene.metadataVersion) {
      throw Object.assign(new Error("Projection version superseded"), { statusCode: 412 });
    }
  }

  async project(scene: SceneRecord): Promise<void> {
    await this.assertCurrent(scene);
    const root = sceneVertexId(scene);
    const shared = {
      sceneId: scene.id, metadataVersion: scene.metadataVersion,
      startSeconds: scene.timecode.startSeconds, endSeconds: scene.timecode.endSeconds
    };
    await this.vertex(root, scene.videoId, "Scene", {
      ...shared, displayName: scene.caption, entityType: "scene", projection: "pending"
    });
    for (const entity of scene.entities) {
      const id = occurrenceId(scene, entity.id);
      await this.vertex(id, scene.videoId, "Occurrence", {
        ...shared, entityId: entity.id, entityType: entity.type,
        displayName: entity.name, nameNormalized: normalizeLabel(entity.name),
        confidence: entity.confidence,
        identitySource: entity.identitySource === "editor" ? "editor" : "visual"
      });
      await this.edge(`contains-${graphId(root, id)}`, root, scene.videoId, id, scene.videoId, "contains", shared);
      if (entity.type === "person" && entity.identitySource === "editor" && entity.actorName) {
        const normalized = normalizeLabel(entity.actorName);
        const actorId = `actor-${graphId(normalized)}`;
        const actorPk = "__actors";
        await this.vertex(actorId, actorPk, "Actor", {
          displayName: entity.actorName, nameNormalized: normalized, entityType: "actor", identitySource: "editor"
        });
        await this.edge(`identity-${graphId(id, actorId)}`, id, scene.videoId, actorId, actorPk, "identifiedAs", {
          ...shared, identitySource: "editor"
        });
      }
    }
    for (const relation of scene.relations) {
      await this.edge(
        `observation-${graphId(root, relation.id)}`,
        occurrenceId(scene, relation.subject), scene.videoId,
        occurrenceId(scene, relation.object), scene.videoId, "observed",
        { ...shared, predicate: relation.predicate, confidence: relation.confidence,
          evidence: relation.evidence, startSeconds: relation.timecode.startSeconds, endSeconds: relation.timecode.endSeconds }
      );
    }
    await this.assertCurrent(scene);
    await this.submit("g.V([pk,rootId]).property(single,'projection','ready')", { pk: scene.videoId, rootId: root });
  }

  async match(scene: SceneRecord, plan: QueryPlan): Promise<Timecode[]> {
    const { script, bindings } = compileMatch(plan, scene);
    // Canonical readiness is checked by caller; native readiness also protects
    // against a partially projected graph after a worker outage.
    const ready = script.replace(".as('root')", ".has('projection','ready').as('root')");
    return intervalsFromRows(await this.submit(ready, bindings), plan, scene.timecode);
  }

  async getScene(scene: SceneRecord): Promise<MaterializedGraph> {
    await this.assertCurrent(scene);
    const bindings = { pk: scene.videoId, rootId: sceneVertexId(scene), version: scene.metadataVersion };
    const root = "g.V([pk,rootId]).has('metadataVersion',version).has('projection','ready')";
    const nodes = await this.submit(root +
      ".union(identity(),out('contains'),out('contains').out('identifiedAs')).dedup().limit(64)" +
      ".project('id','label','type').by(id()).by('displayName').by('entityType')", bindings);
    const edges = await this.submit(root +
      ".union(outE('contains'),out('contains').outE('observed'),out('contains').outE('identifiedAs')).dedup().limit(128)" +
      ".project('id','source','target','label','startSeconds','endSeconds')" +
      ".by(id()).by(outV().id()).by(inV().id()).by(coalesce(values('predicate'),label()))" +
      ".by('startSeconds').by('endSeconds')", bindings);
    if (!nodes.length) throw Object.assign(new Error("Graph projection unavailable"), { statusCode: 409 });
    const result: MaterializedGraph = { nodes: [], edges: [] };
    for (const value of nodes) {
      const node = value as GraphNode;
      if (!node || typeof node.id !== "string" || typeof node.label !== "string" || typeof node.type !== "string") {
        throw new Error("Malformed native graph vertex result");
      }
      result.nodes.push(node);
    }
    const ids = new Set(result.nodes.map(node => node.id));
    for (const value of edges) {
      const edge = value as GraphEdge;
      if (!edge || typeof edge.id !== "string" || !ids.has(edge.source) || !ids.has(edge.target) ||
          typeof edge.label !== "string" || !Number.isFinite(edge.startSeconds) ||
          !Number.isFinite(edge.endSeconds) || edge.startSeconds >= edge.endSeconds) {
        throw new Error("Malformed native graph edge result");
      }
      result.edges.push(edge);
    }
    return result;
  }

  async close(): Promise<void> { await this.client.close(); }
}
