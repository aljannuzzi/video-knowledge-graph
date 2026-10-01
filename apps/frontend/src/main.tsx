import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppConfig, Job, QueryPlan, SceneMetadata, SearchResponse, Timecode, VideoAsset } from "@vkg/shared";
import { api, mediaUri, message, sceneKey, timecode } from "./lib";
import { Empty, Icon, Thumbnail } from "./ui";
import UploadPanel from "./UploadPanel";
import SceneInspector from "./SceneInspector";
import "./styles.css";

type View = "search" | "archive" | "jobs";
type RangeDraft = { start: string; end: string };
const examples = [
  "Pessoa e gato sentados no mesmo sofá",
  "Tony Ramos conversando com uma criança",
  "Pessoas à mesa com enfeites de Natal"
];
const statusLabels: Record<string, string> = { queued: "Na fila", processing: "Processando", running: "Em andamento", ready: "Disponível", completed: "Concluído", failed: "Falhou" };
const kindLabels: Record<Job["kind"], string> = { ingest: "Análise de vídeo", export: "Extração de clips", reindex: "Projeção no grafo" };
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const expire = useCallback(() => setAuthenticated(false), []);
  useEffect(() => {
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, [expire]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void Promise.all([
      api<AppConfig>("/api/config", { signal: controller.signal }),
      api<{ authenticated: boolean }>("/api/session", { signal: controller.signal })
    ]).then(([next, session]) => {
      if (controller.signal.aborted) return;
      setConfig(next); setAuthenticated(session.authenticated || !next.authRequired);
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  if (loading || !config || error) return <div className="gate"><Brand /><section className="panel gate-card">{loading ? <p role="status">Conectando à bancada editorial…</p> : <><h1>Não foi possível abrir a bancada</h1><p className="error" role="alert">{error}</p><button onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></>}</section></div>;
  if (!authenticated) return <Login onAuthenticated={() => setAuthenticated(true)} />;
  return <Workspace config={config} onUnauthorized={expire} />;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><Icon name="film" size={23} /></span><div><strong>CENA<span className="brand-dot">.</span></strong><small>VIDEO KNOWLEDGE GRAPH</small></div></div>;
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    try {
      await api<{ authenticated: boolean }>("/api/session", { method: "POST", body: JSON.stringify({ password }), signal: controller.signal });
      const session = await api<{ authenticated: boolean }>("/api/session", { signal: controller.signal });
      if (!session.authenticated) throw new Error("O servidor não confirmou a sessão. Verifique se os cookies estão habilitados.");
      setPassword(""); onAuthenticated();
    } catch (error) { if (!controller.signal.aborted) setError(message(error)); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  return <div className="gate"><Brand /><section className="panel gate-card"><p className="eyebrow">Acesso à demonstração</p><h1>O acervo começa aqui.</h1><p className="muted">Entre na bancada de busca e revisão editorial.</p><form onSubmit={login}><label className="field">Senha de acesso<input autoFocus type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy || !password}>{busy ? "Entrando…" : "Entrar na bancada"}<Icon name="arrow" /></button></form><p className="gate-note">Sessão protegida por cookie. Nenhuma senha ou token é armazenado no navegador pela aplicação.</p></section><span className="muted">Vídeo, contexto e relações. No mesmo lugar.</span></div>;
}

function Workspace({ config, onUnauthorized }: { config: AppConfig; onUnauthorized: () => void }) {
  const [view, setView] = useState<View>("search");
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ranges, setRanges] = useState<Record<string, RangeDraft>>({});
  const [inspected, setInspected] = useState<SceneMetadata | null>(null);
  const [videoId, setVideoId] = useState("");
  const [scenes, setScenes] = useState<SceneMetadata[]>([]);
  const [scenesLoading, setScenesLoading] = useState(false);
  const [scenesError, setScenesError] = useState("");
  const [sceneRetry, setSceneRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportJob, setExportJob] = useState<Job | null>(null);
  const [exportPollError, setExportPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const searchRequest = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const logoutRequest = useRef<AbortController | null>(null);
  const collectionRequest = useRef<AbortController | null>(null);
  useEffect(() => () => {
    searchRequest.current?.abort(); exportRequest.current?.abort(); logoutRequest.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    collectionRequest.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [videoData, jobData] = await Promise.all([
          api<{ videos: VideoAsset[] }>("/api/videos", { signal: controller.signal }),
          api<{ jobs: Job[] }>("/api/jobs", { signal: controller.signal })
        ]);
        if (controller.signal.aborted) return;
        setVideos(videoData.videos); setJobs(jobData.jobs); setDataError("");
      } catch (error) { if (!controller.signal.aborted) setDataError(message(error)); }
      finally {
        if (!controller.signal.aborted) { setInitialLoading(false); timer = setTimeout(() => void poll(), 5000); }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!videoId) { setScenes([]); return; }
    const controller = new AbortController();
    setScenesLoading(true); setScenesError(""); setScenes([]);
    void api<{ scenes: SceneMetadata[] }>(`/api/videos/${encodeURIComponent(videoId)}/scenes`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setScenes(data.scenes); })
      .catch(error => { if (!controller.signal.aborted) setScenesError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setScenesLoading(false); });
    return () => controller.abort();
  }, [videoId, sceneRetry]);

  const pendingExportId = exportJob && (exportJob.status === "queued" || exportJob.status === "running") ? exportJob.id : "";
  useEffect(() => {
    if (!pendingExportId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const job = await api<Job>(`/api/jobs/${encodeURIComponent(pendingExportId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setExportJob(job); setExportPollError("");
        if (job.status === "completed" || job.status === "failed") { setRefresh(value => value + 1); return; }
      } catch (error) { if (!controller.signal.aborted) setExportPollError(message(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2500);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pendingExportId]);

  async function search(next = query) {
    if (!next.trim()) return;
    searchRequest.current?.abort();
    const controller = new AbortController(); searchRequest.current = controller;
    setSearching(true); setSearchError(""); setResponse(null); setSelected(new Set()); setRanges({});
    setQuery(next); setView("search"); setInspected(null); setNotice("");
    try {
      const result = await api<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify({ query: next.trim(), limit: 12 }), signal: controller.signal });
      if (controller.signal.aborted || searchRequest.current !== controller) return;
      setResponse(result);
      setRanges(Object.fromEntries(result.hits.map(hit => {
        const start = Math.max(hit.scene.timecode.startSeconds, hit.matchedTimecode.startSeconds);
        const end = Math.min(hit.scene.timecode.endSeconds, hit.matchedTimecode.endSeconds);
        const range = start < end ? { startSeconds: start, endSeconds: end } : hit.scene.timecode;
        return [sceneKey(hit.scene), { start: String(range.startSeconds), end: String(range.endSeconds) }];
      })));
    } catch (error) { if (!controller.signal.aborted) setSearchError(message(error)); }
    finally { if (searchRequest.current === controller) { searchRequest.current = null; setSearching(false); } }
  }
  function cancelSearch() {
    searchRequest.current?.abort(); searchRequest.current = null;
    setSearching(false); setNotice("Busca interrompida neste navegador.");
  }
  function rangeFor(scene: SceneMetadata): Timecode | null {
    const range = ranges[sceneKey(scene)];
    if (!range || !range.start.trim() || !range.end.trim()) return null;
    const start = Number(range.start), end = Number(range.end);
    return Number.isFinite(start) && Number.isFinite(end) && start >= scene.timecode.startSeconds && end <= scene.timecode.endSeconds && start < end
      ? { startSeconds: start, endSeconds: end } : null;
  }
  const selectedHits = response?.hits.filter(hit => selected.has(sceneKey(hit.scene))) ?? [];
  const validSelection = selectedHits.length > 0 && selectedHits.every(hit => rangeFor(hit.scene));
  async function extract() {
    if (!validSelection || exportRequest.current || pendingExportId) return;
    const controller = new AbortController(); exportRequest.current = controller;
    setExporting(true); setExportError(""); setExportPollError("");
    try {
      const clips = selectedHits.map(hit => ({ sceneId: hit.scene.id, videoId: hit.scene.videoId, timecode: rangeFor(hit.scene)! }));
      const job = await api<Job>("/api/clips/extract", { method: "POST", body: JSON.stringify({ clips }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setExportJob(job); setRefresh(value => value + 1);
    } catch (error) { if (!controller.signal.aborted) setExportError(`${message(error)} Consulte Processamentos antes de repetir a extração.`); }
    finally { if (!controller.signal.aborted) { exportRequest.current = null; setExporting(false); } }
  }
  async function logout() {
    if (logoutRequest.current) return;
    const controller = new AbortController(); logoutRequest.current = controller;
    setLoggingOut(true);
    try { await api<void>("/api/session", { method: "DELETE", signal: controller.signal }); if (!controller.signal.aborted) onUnauthorized(); }
    catch (error) { if (!aborted(error)) setDataError(message(error)); }
    finally { if (!controller.signal.aborted) { logoutRequest.current = null; setLoggingOut(false); } }
  }
  function updateScene(scene: SceneMetadata, identityEdited = false) {
    setInspected(scene);
    setScenes(current => current.map(item => sceneKey(item) === sceneKey(scene) ? scene : item));
    setResponse(current => current ? { ...current, hits: current.hits.map(hit => sceneKey(hit.scene) === sceneKey(scene) ? { ...hit, scene, graphVerified: identityEdited ? false : hit.graphVerified } : hit) } : null);
    if (identityEdited) setNotice("Anotação atualizada. Execute a busca novamente para revalidar as evidências.");
  }
  const title = { search: "Busca de cenas", archive: "Acervo de vídeos", jobs: "Processamentos" }[view];
  return <div className="app-shell">
    <a className="skip-link" href="#workspace">Ir para o conteúdo</a>
    <aside className="sidebar"><Brand /><div className="sidebar-label">BANCADA EDITORIAL</div><nav aria-label="Navegação principal">
      {([{ id: "search", label: "Busca", icon: "search" }, { id: "archive", label: "Acervo", icon: "archive" }, { id: "jobs", label: "Processamentos", icon: "jobs" }] as const).map(item => <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}><Icon name={item.icon} />{item.label}{view === item.id && <span className="nav-indicator" />}</button>)}
    </nav><div className="sidebar-foot"><span className="sidebar-emblem"><Icon name="graph" size={28} /></span><strong>Uma cena. Todo o contexto.</strong><p>Conecte pessoas, objetos e ações às evidências do seu acervo.</p><span className="sidebar-mode">{config.mode === "azure" ? "AMBIENTE AZURE" : "AMBIENTE LOCAL"}</span>{config.authRequired && <button className="logout" onClick={() => void logout()} disabled={loggingOut}><Icon name="logout" />{loggingOut ? "Saindo…" : "Encerrar sessão"}</button>}</div></aside>
    <div className="app-main"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{title}</strong></div><div className="status-chips"><span className="badge neutral">Cosmos NoSQL · {config.mode === "azure" ? "Azure" : "modo local"}</span><span className={`badge ${config.graphConfigured ? "success" : "warning"}`}><span className="status-dot" />SQL Graph · {config.graphConfigured ? "configurado" : "não configurado"}</span></div></header>
      <main id="workspace" className="workspace">
        <section className="workspace-heading"><div><p className="eyebrow">CENA / EXPLORAÇÃO EDITORIAL</p><h1>{view === "search" ? "Encontre a cena. Confira a evidência." : title}</h1><p className="muted">{view === "search" ? "Busque por contexto, revise os intervalos e leve os melhores momentos para a edição." : view === "archive" ? "Seu material original, organizado em cenas e relações." : "Acompanhe análise, projeção no grafo e extração de arquivos."}</p></div><button className="primary" onClick={() => setUploadOpen(true)} aria-expanded={uploadOpen}><Icon name="upload" />Adicionar vídeo</button></section>
        <div className="model-strip"><span className={`badge ${config.aiConfigured ? "neutral" : "warning"}`}>IA {config.aiConfigured ? "configurada" : "não configurada"}</span><span>Visão <strong>{config.visionModel || "não informado"}</strong></span><i /><span>Embeddings <strong>{config.embeddingModel || "não informado"}</strong></span><span className="model-note">Configuração do servidor</span></div>
        {dataError && <div className="error banner" role="alert"><span>Não foi possível atualizar o acervo: {dataError} Os dados exibidos podem estar desatualizados.</span><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Atualizar</button></div>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {uploadOpen && <UploadPanel maxMb={config.maxUploadMb} onClose={() => setUploadOpen(false)} onUploaded={(video, job) => {
          collectionRequest.current?.abort();
          setVideos(current => [video, ...current.filter(item => item.id !== video.id)]);
          setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
          setRefresh(value => value + 1); setUploadOpen(false); setView("jobs"); setNotice(`“${video.title}” recebido. Acompanhe o processamento abaixo.`);
        }} />}
        {view === "search" && <>
          <section className="panel search-panel"><form onSubmit={event => { event.preventDefault(); void search(); }}><label htmlFor="query">O que você procura no acervo?</label><div className="search-row"><Icon name="search" size={22} /><input id="query" placeholder="Descreva pessoas, objetos e o que acontece entre eles…" value={query} maxLength={2000} onChange={event => setQuery(event.target.value)} /><button className="primary" disabled={!query.trim()} type="submit">{searching ? "Buscar novamente" : "Buscar cenas"}<Icon name="arrow" /></button></div></form><div className="query-examples"><span>Experimente</span>{examples.map((example, index) => <button className="query-chip" onClick={() => void search(example)} key={example}><span>0{index + 1}</span>{example}</button>)}</div><div className="search-disclaimer"><Icon name="graph" size={15} /><span>Busca vetorial + relações no grafo. Resultados não exaustivos; limites de cena podem ser estimados.</span></div></section>
          <div className="editorial-note"><span className="badge">Identidade editorial</span><span>Não há reconhecimento facial nativo nesta demo. Nomes como Tony Ramos dependem de anotação manual na ocorrência da cena.</span></div>
          {searchError && <p className="error" role="alert">{searchError}</p>}
          {searching && <div className="loading-panel" role="status"><span className="spinner" /><span>Interpretando a consulta e verificando relações no grafo…</span><button className="secondary" onClick={cancelSearch}>Interromper busca</button></div>}
          {!searching && response && <QueryEvidence plan={response.plan} />}
          <div className={`workbench ${inspected ? "with-inspector" : ""}`}><section className="results-column" aria-label="Resultados da busca">
            {response && <><div className="results-heading"><div><p className="eyebrow">RESULTADOS DA CONSULTA</p><h2>{response.hits.length} {response.hits.length === 1 ? "cena encontrada" : "cenas encontradas"}</h2></div><span className="muted">Ordenação por relevância</span></div>
              <p className="result-query">“{response.query}”</p>
              {response.hits.length > 0 && <div className="selection-toolbar"><label className="checkbox-label"><input type="checkbox" checked={selected.size === response.hits.length} onChange={event => setSelected(event.target.checked ? new Set(response.hits.map(hit => sceneKey(hit.scene))) : new Set())} />Selecionar todos os resultados ({response.hits.length})</label><span>{selected.size} selecionados</span></div>}
              <div className="results">{response.hits.map((hit, index) => {
                const key = sceneKey(hit.scene), range = ranges[key], valid = rangeFor(hit.scene);
                return <article className={`result-card ${inspected && sceneKey(inspected) === key ? "is-active" : ""}`} key={key}>
                  <button className="result-preview" aria-label={`Reproduzir e inspecionar ${hit.scene.videoTitle}, cena ${index + 1}`} onClick={() => setInspected(hit.scene)}><Thumbnail uri={hit.scene.thumbnailUri} title={`Quadro da cena: ${hit.scene.caption}`} /><span className="preview-play"><Icon name="play" /></span><span className="preview-number">CENA {String(index + 1).padStart(2, "0")}</span></button>
                  <div className="result-body"><div className="result-title"><h3>{hit.scene.videoTitle}</h3><label className="checkbox-label"><input type="checkbox" aria-label={`Selecionar cena ${index + 1} de ${hit.scene.videoTitle}`} checked={selected.has(key)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />Clip</label></div><p className="caption">{hit.scene.caption}</p><div className="badges"><span className={`badge ${hit.graphVerified ? "success" : "warning"}`}>{hit.graphVerified ? "Relações verificadas no grafo" : "Sem confirmação do grafo"}</span><span className="badge neutral">Score {Number.isFinite(hit.score) ? hit.score.toFixed(3) : "—"} · ranking, não probabilidade</span>{hit.scene.entities.some(entity => entity.identitySource === "editor") && <span className="badge">Identidade editorial</span>}</div><p className="rationale">{hit.rationale}</p>
                    <div className="scene-timeline"><span className="timeline-dot" /><span className="timecode">{timecode(hit.scene.timecode.startSeconds)}</span><span className="timeline-track" /><span className="timecode">{timecode(hit.scene.timecode.endSeconds)}</span><span className="timeline-dot" /></div>
                    <p className="boundary-note">{hit.scene.boundarySource === "model-estimate" ? "Limites estimados pelo modelo · revise antes de extrair." : "Limites definidos editorialmente."} Correspondência: <span className="timecode">{timecode(hit.matchedTimecode.startSeconds)} → {timecode(hit.matchedTimecode.endSeconds)}</span></p>
                    <div className="range-editor"><label>IN · segundos<input type="number" aria-label={`Início do clip ${index + 1} em segundos`} min={hit.scene.timecode.startSeconds} max={hit.scene.timecode.endSeconds} step="0.001" value={range?.start ?? ""} aria-invalid={!valid} onChange={event => setRanges(current => ({ ...current, [key]: { ...current[key], start: event.target.value } }))} /></label><label>OUT · segundos<input type="number" aria-label={`Fim do clip ${index + 1} em segundos`} min={hit.scene.timecode.startSeconds} max={hit.scene.timecode.endSeconds} step="0.001" value={range?.end ?? ""} aria-invalid={!valid} onChange={event => setRanges(current => ({ ...current, [key]: { ...current[key], end: event.target.value } }))} /></label><button className="text-button" onClick={() => setInspected(hit.scene)}>Inspecionar cena<Icon name="arrow" size={15} /></button></div>
                    {!valid && <p className="error">Informe IN menor que OUT, dentro dos limites da cena.</p>}
                  </div>
                </article>;
              })}</div>
              {response.hits.length === 0 && <Empty title="Nenhuma cena para esta consulta">Tente outra descrição ou confira se o material concluiu a análise. A ausência de resultados não prova a ausência do conteúdo no acervo.</Empty>}
              {response.hits.length > 0 && <div className="export-bar"><div><strong>{selected.size} clips para revisão</strong><span>Somente os resultados selecionados · MP4 + manifesto JSON em ZIP</span></div><button className="primary" disabled={!validSelection || exporting || !!pendingExportId} onClick={() => void extract()}>{exporting ? "Solicitando extração…" : pendingExportId ? "Extração em andamento…" : "Extrair clips selecionados"}<Icon name="arrow" /></button></div>}
            </>}
            {!response && !searching && !searchError && <Empty title={videos.length ? "O próximo corte começa com uma pergunta." : initialLoading ? "Carregando o acervo…" : dataError ? "Acervo temporariamente indisponível" : "Seu acervo ainda está em branco."}>{videos.length ? "Descreva uma cena ou use um exemplo acima. As evidências aparecem junto de cada resultado." : initialLoading ? "Consultando os vídeos disponíveis no servidor." : dataError ? "Tente atualizar a conexão antes de iniciar uma busca." : "Adicione seu primeiro vídeo para começar. Nenhum vídeo ou resultado de demonstração é pré-carregado."}</Empty>}
          </section>{inspected && <SceneInspector key={sceneKey(inspected)} scene={inspected} previewTimecode={rangeFor(inspected) ?? undefined} onClose={() => setInspected(null)} onUpdated={updateScene} onUnauthorized={onUnauthorized} />}</div>
          {exportError && <p className="error" role="alert">{exportError}</p>}
          {exportPollError && <p className="error" role="alert">Atualização da extração indisponível: {exportPollError} Tentaremos novamente automaticamente.</p>}
          {exportJob && <div className="panel export-status" role="status"><JobRow job={exportJob} videos={videos} /></div>}
        </>}
        {view === "archive" && <div className={`workbench ${inspected ? "with-inspector" : ""}`}><section className="results-column"><div className="results-heading"><h2>Material original</h2><span className="muted">{initialLoading ? "Carregando…" : `${videos.length} vídeos no acervo`}</span></div>
          {!videos.length && !initialLoading && <Empty title={dataError ? "Não foi possível consultar o acervo" : "Um acervo só seu."}>{dataError ? "Confira a conexão e tente atualizar." : "Envie um vídeo local. As cenas aparecerão aqui após o processamento real."}</Empty>}
          <div className="video-list">{videos.map(video => <button key={video.id} className={`video-row ${videoId === video.id ? "is-active" : ""}`} onClick={() => { setVideoId(video.id); setSceneRetry(value => value + 1); setInspected(null); }}><span className="video-icon"><Icon name="film" size={23} /></span><span className="video-info"><strong>{video.title}</strong><small>{video.filename}</small></span><span className="video-facts"><span className={`badge ${video.status === "ready" ? "success" : video.status === "failed" ? "danger" : "warning"}`}>{statusLabels[video.status]}</span><small>{video.sceneCount} cenas{video.durationSeconds !== undefined ? ` · ${timecode(video.durationSeconds)}` : ""}</small></span><Icon name="arrow" /></button>)}</div>
          {videoId && <section className="archive-scenes"><div className="section-heading"><h2>Cenas do vídeo</h2><button className="secondary" onClick={() => setSceneRetry(value => value + 1)} disabled={scenesLoading}>Atualizar cenas</button></div>{scenesLoading && <p role="status">Carregando cenas…</p>}{scenesError && <p className="error" role="alert">{scenesError}</p>}{!scenesLoading && !scenesError && !scenes.length && <Empty title="Ainda não há cenas disponíveis">Confira o processamento deste vídeo. Nenhum conteúdo ilustrativo é exibido no lugar das cenas reais.</Empty>}<div className="scene-grid">{scenes.map(scene => <button className="archive-scene" key={sceneKey(scene)} onClick={() => setInspected(scene)}><Thumbnail uri={scene.thumbnailUri} title={scene.caption} /><span className="archive-scene-body"><span className="timecode">{timecode(scene.timecode.startSeconds)} → {timecode(scene.timecode.endSeconds)}</span><strong>{scene.caption}</strong><span className="text-link">Abrir evidências <Icon name="arrow" size={14} /></span></span></button>)}</div></section>}
        </section>{inspected && <SceneInspector key={sceneKey(inspected)} scene={inspected} onClose={() => setInspected(null)} onUpdated={updateScene} onUnauthorized={onUnauthorized} />}</div>}
        {view === "jobs" && <section className="panel jobs-panel"><div className="section-heading"><div><h2>Fila de trabalho</h2><p className="muted">Atualização automática a cada 5 segundos. Interromper uma consulta não cancela o trabalho no servidor.</p></div><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Atualizar</button></div>{initialLoading ? <p role="status">Consultando processamentos…</p> : !jobs.length ? <Empty title={dataError ? "Fila indisponível" : "Nenhum processamento por aqui."}>{dataError ? "Tente atualizar para consultar o estado real dos trabalhos." : "Envie um vídeo ou extraia clips de uma busca. O andamento de cada operação aparecerá aqui."}</Empty> : <div className="job-list">{jobs.map(job => <JobRow key={job.id} job={job} videos={videos} />)}</div>}</section>}
        <footer className="workspace-footer"><span>CENA / Video Knowledge Graph</span><span>IA sugere. Evidências sustentam. Você edita.</span></footer>
      </main>
    </div>
  </div>;
}

function QueryEvidence({ plan }: { plan: QueryPlan }) {
  const name = (id: string) => plan.entities.find(entity => entity.variable === id)?.name ?? id;
  return <details className="panel query-plan" open><summary><span><Icon name="graph" />Plano da consulta <span className="badge neutral">Evidência estruturada</span></span><span className="muted">Inspecionar relações</span></summary><div className="query-plan-body"><p>{plan.explanation}</p><div className="plan-relations">{plan.relations.map((relation, index) => <div className="plan-relation" key={index}><span>{name(relation.subject)}<small>{relation.subject}</small></span><span className="relation-arrow">— {relation.predicate} →</span><span>{name(relation.object)}<small>{relation.object}</small></span></div>)}</div>{(plan.semanticConstraints ?? []).map((constraint, index) => <p key={index}><strong>{name(constraint.variable)}:</strong> {constraint.description} <span className="badge neutral">Exige evidência da ação</span></p>)}{!plan.relations.length && !plan.semanticConstraints?.length && <p className="muted">Busca por ocorrência da entidade; o intervalo retornado é a janela de análise.</p>}<p className="plan-note">O plano expressa a intenção, não a prova. No inspetor, confira se as relações apontam para o mesmo objeto e se seus intervalos temporais coincidem.</p></div></details>;
}

function JobRow({ job, videos }: { job: Job; videos: VideoAsset[] }) {
  const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0;
  const output = job.outputUri ? mediaUri(job.outputUri) : "";
  return <article className="job-row"><span className="job-icon"><Icon name={job.kind === "export" ? "film" : "jobs"} size={22} /></span><div className="job-info"><div className="job-title"><strong>{kindLabels[job.kind]}</strong><span className={`badge ${job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "warning"}`}>{statusLabels[job.status]}</span></div><p>{videos.find(video => video.id === job.videoId)?.title ?? (job.kind === "export" ? "Clips selecionados" : job.videoId ?? "Acervo")}</p><span className="muted">{job.stage}</span>{(job.status === "running" || job.status === "queued") && <div className="job-progress"><progress value={progress} max={100} aria-label={`Progresso de ${kindLabels[job.kind]}`} /><span>{Math.round(progress)}%</span></div>}{job.error && <p className="error">{job.error}</p>}<small className="job-id">{job.id} · {new Date(job.updatedAt).toLocaleString("pt-BR")}</small></div>{job.status === "completed" && output && <a className="button secondary" href={output} download><Icon name="arrow" />{job.kind === "export" ? "Baixar ZIP · MP4 + JSON" : "Baixar resultado"}</a>}{job.status === "completed" && job.kind === "export" && !output && <span className="muted">Link de saída indisponível</span>}</article>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
