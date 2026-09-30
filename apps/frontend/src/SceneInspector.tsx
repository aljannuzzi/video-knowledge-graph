import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, SyntheticEvent } from "react";
import type { SceneMetadata, Timecode } from "@vkg/shared";
import { api, mediaUri, message, timecode } from "./lib";
import { Thumbnail } from "./ui";

type Props = {
  scene: SceneMetadata;
  previewTimecode?: Timecode;
  onClose: () => void;
  onUpdated: (scene: SceneMetadata, identityEdited?: boolean) => void;
  onUnauthorized: () => void;
};

type SceneGraph = {
  nodes: Array<{ id: string; label: string; type: string }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    startSeconds: number;
    endSeconds: number;
  }>;
};

type IdentityDraft = { entityId: string; actorName: string; dirty: boolean };

const entityTypes: Record<string, string> = {
  person: "Pessoa",
  animal: "Animal",
  object: "Objeto",
  place: "Lugar",
  action: "Ação",
  concept: "Conceito",
};

function unauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 401 || error.status === 403)
  );
}

function initialIdentity(scene: SceneMetadata): IdentityDraft {
  const person = scene.entities.find((entity) => entity.type === "person");
  return { entityId: person?.id ?? "", actorName: person?.actorName ?? "", dirty: false };
}

function GraphView({ graph }: { graph: SceneGraph }) {
  const markerId = `arrow-${useId().replace(/:/g, "")}`;
  const width = 760;
  const height = Math.max(360, graph.nodes.length * 48);
  const positions = new Map(
    graph.nodes.map((node, index) => {
      const angle = (2 * Math.PI * index) / Math.max(1, graph.nodes.length) - Math.PI / 2;
      return [
        node.id,
        {
          x: graph.nodes.length === 1 ? width / 2 : width / 2 + Math.cos(angle) * 260,
          y: graph.nodes.length === 1 ? height / 2 : height / 2 + Math.sin(angle) * (height / 2 - 65),
        },
      ] as const;
    }),
  );
  const names = new Map(graph.nodes.map((node) => [node.id, node.label]));

  return (
    <>
      <svg
        className="graph"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="Grafo da cena. A lista completa de entidades e relações está logo abaixo."
      >
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {graph.edges.map((edge, index) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const distance = Math.hypot(target.x - source.x, target.y - source.y);
          const dx = distance ? (target.x - source.x) / distance : 0;
          const dy = distance ? (target.y - source.y) / distance : 0;
          const siblings = graph.edges.filter(
            (candidate) =>
              (candidate.source === edge.source && candidate.target === edge.target) ||
              (candidate.source === edge.target && candidate.target === edge.source),
          );
          const siblingIndex = siblings.indexOf(edge);
          const bend = (siblingIndex - (siblings.length - 1) / 2) * 40;
          const direction = edge.source < edge.target ? 1 : -1;
          const controlX = (source.x + target.x) / 2 - dy * bend * direction;
          const controlY = (source.y + target.y) / 2 + dx * bend * direction;
          const self = edge.source === edge.target;
          const path = self
            ? `M ${source.x - 18} ${source.y - 20} C ${source.x - 85} ${source.y - 85}, ${source.x + 85} ${source.y - 85}, ${source.x + 18} ${source.y - 20}`
            : `M ${source.x + dx * 32} ${source.y + dy * 32} Q ${controlX} ${controlY}, ${target.x - dx * 36} ${target.y - dy * 36}`;
          return (
            <g className="graph-edge" key={`${edge.id}-${index}`}>
              <title>{`${names.get(edge.source) ?? edge.source} → ${edge.label} → ${names.get(edge.target) ?? edge.target}; ${timecode(edge.startSeconds)}–${timecode(edge.endSeconds)}`}</title>
              <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />
              <text
                x={self ? source.x : (source.x + target.x + 2 * controlX) / 4}
                y={self ? source.y - 64 : (source.y + target.y + 2 * controlY) / 4 - 7}
                textAnchor="middle"
                fill="currentColor"
                fontSize="11"
              >
                {edge.label.length > 28 ? `${edge.label.slice(0, 27)}…` : edge.label}
              </text>
            </g>
          );
        })}
        {graph.nodes.map((node) => {
          const point = positions.get(node.id);
          if (!point) return null;
          return (
            <g className="graph-node" key={node.id} transform={`translate(${point.x}, ${point.y})`}>
              <title>{`${node.label} (${entityTypes[node.type] ?? node.type})`}</title>
              <circle r="29" fill="var(--cp-surface)" stroke="currentColor" strokeWidth="2" />
              <text textAnchor="middle" y="4" fill="currentColor" fontSize="12">
                {node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label}
              </text>
              <text textAnchor="middle" y="46" fill="currentColor" fontSize="11">
                {entityTypes[node.type] ?? node.type}
              </text>
            </g>
          );
        })}
      </svg>
      <h4>Entidades do grafo</h4>
      <ul className="evidence-list">
        {graph.nodes.map((node) => (
          <li key={node.id}>
            <strong>{node.label}</strong> <span className="muted">· {entityTypes[node.type] ?? node.type} · {node.id}</span>
          </li>
        ))}
      </ul>
      <h4>Relações e intervalos</h4>
      {graph.edges.length === 0 ? (
        <p className="empty-state">Nenhuma relação foi retornada pelo grafo.</p>
      ) : (
        <ul className="evidence-list">
          {graph.edges.map((edge, index) => (
            <li key={`${edge.id}-${index}`}>
              <strong>{names.get(edge.source) ?? edge.source}</strong> → {edge.label} →{" "}
              <strong>{names.get(edge.target) ?? edge.target}</strong>{" "}
              <span className="timecode">{timecode(edge.startSeconds)}–{timecode(edge.endSeconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function SceneInspector(props: Props) {
  return <InspectorContent key={JSON.stringify([props.scene.videoId, props.scene.id])} {...props} />;
}

function InspectorContent({ scene, previewTimecode, onClose, onUpdated, onUnauthorized }: Props) {
  const [current, setCurrent] = useState(scene);
  const [graph, setGraph] = useState<SceneGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [graphError, setGraphError] = useState("");
  const [revision, setRevision] = useState(0);
  const [identity, setIdentity] = useState<IdentityDraft>(() => initialIdentity(scene));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [playerError, setPlayerError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const readRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const callbacks = useRef({ onUpdated, onUnauthorized });
  callbacks.current = { onUpdated, onUnauthorized };
  const id = useId();
  const path = `/api/scenes/${encodeURIComponent(scene.videoId)}/${encodeURIComponent(scene.id)}`;
  const graphPath = `/api/graph/${encodeURIComponent(scene.videoId)}/${encodeURIComponent(scene.id)}`;
  const people = current.entities.filter((entity) => entity.type === "person");
  const asset = mediaUri(current.assetUri);
  const thumbnail = mediaUri(current.thumbnailUri);
  const start = Math.max(0, current.timecode.startSeconds, previewTimecode?.startSeconds ?? current.timecode.startSeconds);
  const end = Math.min(current.timecode.endSeconds, previewTimecode?.endSeconds ?? current.timecode.endSeconds);
  const validInterval = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const labels = new Map(current.entities.map((entity) => [entity.id, entity.actorName || entity.name]));

  useEffect(() => {
    setIdentity((draft) => {
      const person = current.entities.find((entity) => entity.type === "person" && entity.id === draft.entityId);
      if (!person) return initialIdentity(current);
      return draft.dirty ? draft : { ...draft, actorName: person.actorName ?? "" };
    });
  }, [current]);

  useEffect(() => {
    const controller = new AbortController();
    readRequest.current = controller;
    const requestGeneration = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let projectionPending = current.graphStatus === "pending";
    const active = () => !controller.signal.aborted && generation.current === requestGeneration;
    const scheduleRefresh = () => {
      timer = setTimeout(() => {
        if (active()) void refresh();
      }, 3000);
    };
    setLoading(true);
    setLoadError("");
    setGraphError("");
    setGraph(null);

    async function refresh() {
      if (!active()) return;
      setLoading(true);
      try {
        const latest = await api<SceneMetadata>(path, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!active()) return;
        projectionPending = latest.graphStatus === "pending";
        setCurrent(latest);
        setGraph(null);
        setLoadError("");
        callbacks.current.onUpdated(latest);
        try {
          const projection = await api<SceneGraph>(graphPath, {
            signal: controller.signal,
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!active()) return;
          setGraph(projection);
          setGraphError("");
        } catch (error: unknown) {
          if (!active()) return;
          setGraph(null);
          setGraphError(message(error));
          if (unauthorized(error)) {
            callbacks.current.onUnauthorized();
            return;
          }
        }
        if (active() && projectionPending) scheduleRefresh();
      } catch (error: unknown) {
        if (!active()) return;
        setLoadError(message(error));
        if (unauthorized(error)) callbacks.current.onUnauthorized();
        else if (projectionPending) scheduleRefresh();
      } finally {
        if (active()) setLoading(false);
      }
    }

    void refresh();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [path, graphPath, revision]);

  useEffect(() => () => {
    generation.current += 1;
    saveRequest.current?.abort();
  }, []);

  useEffect(() => {
    setPlayerError("");
  }, [asset, start, end]);

  function clampPlayback(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    if (!validInterval) {
      video.pause();
      return;
    }
    if (video.currentTime < start) video.currentTime = start;
    if (video.currentTime >= end) {
      video.pause();
      if (video.currentTime > end) video.currentTime = end;
    }
  }

  function seek(seconds: number) {
    if (!player.current || !validInterval) return;
    player.current.currentTime = Math.min(end, Math.max(start, seconds));
    if (seconds >= end) player.current.pause();
    player.current.focus();
  }

  async function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveRequest.current || !identity.entityId || !identity.actorName.trim()) return;
    readRequest.current?.abort();
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setLoading(false);
    setSaveError("");
    setSaveNotice("");
    try {
      const updated = await api<SceneMetadata>(`${path}/identity`, {
        method: "PATCH",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: identity.entityId, actorName: identity.actorName.trim() }),
      });
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setCurrent(updated);
      setIdentity((draft) => ({ ...draft, dirty: false, actorName: identity.actorName.trim() }));
      setGraph(null);
      setSaveNotice("Identidade editorial salva. Verificando a projeção do grafo…");
      callbacks.current.onUpdated(updated, true);
      setRevision((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setSaveError(message(error));
      if (unauthorized(error)) callbacks.current.onUnauthorized();
      else setRevision((value) => value + 1);
    } finally {
      if (!controller.signal.aborted && generation.current === requestGeneration) setSaving(false);
      if (saveRequest.current === controller) saveRequest.current = null;
    }
  }

  const graphRelations = graph?.edges.map((edge) => ({
    id: edge.id, subject: edge.source, predicate: edge.label, object: edge.target,
    timecode: { startSeconds: edge.startSeconds, endSeconds: edge.endSeconds },
  })) ?? [];
  const commonObjects = (current.graphStatus === "ready" ? graph?.nodes ?? [] : [])
    .filter((entity) => entity.type === "object")
    .map((object) => {
      const related = graphRelations.filter((relation) => relation.object === object.id);
      const overlaps = related.flatMap((left, index) =>
        related.slice(index + 1).flatMap((right) => {
          const overlapStart = Math.max(start, left.timecode.startSeconds, right.timecode.startSeconds);
          const overlapEnd = Math.min(end, left.timecode.endSeconds, right.timecode.endSeconds);
          return left.subject !== right.subject && overlapStart < overlapEnd
            ? [{ left, right, start: overlapStart, end: overlapEnd }]
            : [];
        }),
      );
      return { object, overlaps };
    })
    .filter(({ overlaps }) => overlaps.length > 0);

  return (
    <aside className="panel inspector" aria-labelledby={`${id}-title`}>
      <header className="section-heading">
        <div>
          <p className="eyebrow">Inspeção de cena</p>
          <h2 id={`${id}-title`}>{current.videoTitle}</h2>
          <p className="muted">Cena {current.id} · <span className="timecode">{timecode(start)}–{timecode(end)}</span></p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Fechar inspeção de cena">×</button>
      </header>

      <div className="section-heading">
        <span className={`badge ${current.graphStatus === "ready" ? "success" : current.graphStatus === "failed" ? "danger" : "warning"}`}>
          {current.graphStatus === "ready" ? "Grafo projetado" : current.graphStatus === "failed" ? "Falha na projeção" : "Projeção pendente"}
        </span>
        <button className="secondary" type="button" disabled={loading || saving} onClick={() => setRevision((value) => value + 1)}>
          Atualizar dados
        </button>
      </div>
      {loading && <p className="muted" role="status"><span className="spinner" aria-hidden="true" /> Carregando cena e grafo…</p>}
      {loadError && <p className="error" role="alert">Não foi possível atualizar a cena: {loadError}. Os metadados exibidos podem estar desatualizados.</p>}
      {current.graphStatus === "pending" && (
        <p className="notice" role="status">Os metadados estão disponíveis, mas a projeção do grafo ainda está pendente. Consultamos o estado automaticamente a cada 3 segundos enquanto este painel está aberto.</p>
      )}
      {current.graphStatus === "failed" && (
        <p className="error" role="alert">A projeção do grafo falhou. Atualizar consulta o estado novamente; não inicia um reprocessamento.</p>
      )}

      <section className="inspector-section" aria-labelledby={`${id}-playback`}>
        <h3 id={`${id}-playback`}>{previewTimecode ? "Prévia do clip em revisão" : "Trecho da cena"}</h3>
        {asset && validInterval ? (
          <video
            key={`${asset}-${start}-${end}`}
            className="inspector-player"
            ref={player}
            controls
            playsInline
            preload="metadata"
            poster={thumbnail || undefined}
            src={`${asset.split("#")[0]}#t=${start},${end}`}
            aria-label={`Reproduzir cena de ${timecode(start)} a ${timecode(end)}`}
            aria-describedby={`${id}-transcript`}
            onLoadedMetadata={(event) => {
              if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration <= start) {
                setPlayerError("O intervalo desta cena está fora da duração do arquivo.");
                event.currentTarget.pause();
                return;
              }
              event.currentTarget.currentTime = start;
            }}
            onTimeUpdate={clampPlayback}
            onSeeking={clampPlayback}
            onSeeked={clampPlayback}
            onPlay={(event) => {
              if (event.currentTarget.currentTime >= end || event.currentTarget.currentTime < start) {
                event.currentTarget.currentTime = start;
              }
            }}
            onError={() => setPlayerError("Não foi possível carregar o vídeo. Verifique a disponibilidade da mídia.")}
          >
            Seu navegador não oferece suporte à reprodução de vídeo.
          </video>
        ) : <p className="empty-state">Vídeo indisponível: mídia não autorizada ou intervalo de cena inválido.</p>}
        {playerError && <p className="error" role="alert">{playerError}</p>}
        <p className="muted">A reprodução e a navegação ficam limitadas ao intervalo {previewTimecode ? "IN / OUT em revisão" : "desta cena"}. Limites da cena {current.boundarySource === "editor" ? "definidos por um editor" : "estimados pelo modelo"}.</p>
        <h4>Descrição visual</h4>
        <p>{current.caption || "Sem descrição visual disponível."}</p>
        <h4>Transcrição</h4>
        <p id={`${id}-transcript`}>{current.transcript || "Sem transcrição disponível para esta cena."}</p>
        {current.tags.length > 0 && <p>{current.tags.map((tag, index) => <span className="badge" key={`${tag}-${index}`}>{tag} </span>)}</p>}
      </section>

      <section className="inspector-section" aria-labelledby={`${id}-frames`}>
        <h3 id={`${id}-frames`}>Quadros de evidência</h3>
        <div className="evidence-frames">
          {current.evidenceFrames.map((frame, index) => {
            const uri = mediaUri(frame.uri);
            return (
              <figure key={`${frame.seconds}-${index}`}>
                {uri ? (
                  <a href={uri} target="_blank" rel="noreferrer" aria-label={`Abrir quadro original em ${timecode(frame.seconds)}`}>
                    <Thumbnail uri={uri} title={`Quadro da cena em ${timecode(frame.seconds)}`} />
                  </a>
                ) : <p className="empty-state">Quadro indisponível</p>}
                <figcaption>
                  <button className="secondary timecode" type="button" onClick={() => seek(frame.seconds)} disabled={!asset || !validInterval || frame.seconds < start || frame.seconds > end}>
                    Ir para {timecode(frame.seconds)}
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
        {current.evidenceFrames.length === 0 && <p className="empty-state">Nenhum quadro de evidência foi fornecido.</p>}
      </section>

      <section className="inspector-section" aria-labelledby={`${id}-graph`}>
        <h3 id={`${id}-graph`}>Grafo de conhecimento</h3>
        <p className="muted">Entidades e conexões retornadas pela API de grafo, sem relações simuladas.</p>
        {graphError && <p className="error" role="alert">Não foi possível consultar o grafo: {graphError}</p>}
        {graph && current.graphStatus !== "ready" && <p className="notice">A projeção retornada ainda não está confirmada como atualizada; ela pode refletir uma versão anterior.</p>}
        {graph && (graph.nodes.length > 0 || graph.edges.length > 0)
          ? <GraphView graph={graph} />
          : !loading && !graphError && <p className="empty-state">Nenhum grafo disponível para esta cena.</p>}
      </section>

      <section className="inspector-section" aria-labelledby={`${id}-evidence`}>
        <h3 id={`${id}-evidence`}>Relações e prova temporal</h3>
        <p className="muted">Evidências dos metadados da cena. Confiança do modelo não equivale a verificação humana.</p>
        {current.relations.length === 0 ? <p className="empty-state">Nenhuma relação registrada nos metadados.</p> : (
          <ul className="evidence-list">
            {current.relations.map((relation) => (
              <li key={relation.id}>
                <p><strong>{labels.get(relation.subject) ?? relation.subject}</strong> → {relation.predicate} → <strong>{labels.get(relation.object) ?? relation.object}</strong></p>
                <p>{relation.evidence || "Sem descrição de evidência."}</p>
                <p className="muted"><span className="timecode">{timecode(relation.timecode.startSeconds)}–{timecode(relation.timecode.endSeconds)}</span> · Confiança: {Math.round(relation.confidence * 100)}%</p>
              </li>
            ))}
          </ul>
        )}
        <h4>Objeto em comum · prova do grafo</h4>
        <p className="muted">Cruzamento das arestas retornadas pelo grafo no intervalo em revisão.</p>
        {!graph || current.graphStatus !== "ready" ? (
          <p className="empty-state">Prova indisponível enquanto o grafo não estiver acessível e sua projeção atualizada.</p>
        ) : commonObjects.length === 0 ? (
          <p className="empty-state">Não há relações de sujeitos distintos com o mesmo objeto e intervalos sobrepostos nesta cena. A simples presença na cena não comprova simultaneidade.</p>
        ) : (
          <ul className="evidence-list">
            {commonObjects.map(({ object, overlaps }) => (
              <li key={object.id}>
                <strong>{object.label}</strong>
                <ul>
                  {overlaps.map(({ left, right, start: overlapStart, end: overlapEnd }) => (
                    <li key={`${left.id}-${right.id}`}>
                      {labels.get(left.subject) ?? left.subject} ({left.predicate}) e {labels.get(right.subject) ?? right.subject} ({right.predicate}) referenciam o mesmo objeto ({object.id}).
                      {" "}Sobreposição: <span className="timecode">{timecode(overlapStart)}–{timecode(overlapEnd)}</span>.
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">Uma sobreposição sustenta apenas as relações descritas e seu intervalo, não outras ações ou identidades.</p>
      </section>

      <section className="inspector-section" aria-labelledby={`${id}-identity`}>
        <h3 id={`${id}-identity`}>Identidade editorial</h3>
        <p className="notice" id={`${id}-identity-scope`}>Esta associação é editorial e se aplica somente à ocorrência de pessoa selecionada nesta cena. Não é reconhecimento facial nativo e não identifica automaticamente a pessoa em outros vídeos ou cenas.</p>
        {people.length === 0 ? <p className="empty-state">Nenhuma entidade do tipo pessoa disponível para edição.</p> : (
          <form className="identity-form" onSubmit={(event) => void saveIdentity(event)} aria-describedby={`${id}-identity-scope`} aria-busy={saving}>
            <div className="field">
              <label htmlFor={`${id}-person`}>Ocorrência de pessoa</label>
              <select
                id={`${id}-person`}
                value={identity.entityId}
                disabled={saving || loading}
                required
                onChange={(event) => {
                  const selected = people.find((person) => person.id === event.target.value);
                  setIdentity({ entityId: event.target.value, actorName: selected?.actorName ?? "", dirty: false });
                  setSaveError("");
                  setSaveNotice("");
                }}
              >
                {people.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.id}{person.actorName ? ` · ${person.actorName}` : ""}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-actor`}>Nome do ator ou da pessoa</label>
              <input
                id={`${id}-actor`}
                value={identity.actorName}
                onChange={(event) => {
                  setIdentity((draft) => ({ ...draft, actorName: event.target.value, dirty: true }));
                  setSaveNotice("");
                }}
                placeholder="Ex.: Tony Ramos (verificado editorialmente)"
                maxLength={200}
                autoComplete="off"
                required
                disabled={saving || loading}
              />
            </div>
            <button className="primary" type="submit" disabled={saving || loading || !identity.entityId || !identity.actorName.trim()}>
              {saving ? "Salvando identidade…" : "Salvar associação editorial"}
            </button>
          </form>
        )}
        {saveError && <p className="error" role="alert">Não foi possível salvar a identidade: {saveError}</p>}
        {saveNotice && (
          <p className="notice" role="status">
            {current.graphStatus === "ready" && graph !== null && !loading && !graphError && !loadError
              ? "Identidade editorial salva e projeção do grafo atualizada."
              : current.graphStatus === "failed"
                ? "Identidade editorial salva, mas a projeção do grafo falhou."
                : saveNotice}
          </p>
        )}
      </section>
      <footer className="muted">Modelo: {current.model} · Metadados: {current.metadataVersion}</footer>
    </aside>
  );
}
