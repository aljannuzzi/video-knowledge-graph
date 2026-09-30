import { useEffect, useRef, useState } from "react";
import type { Job, VideoAsset } from "@vkg/shared";
import { Icon } from "./ui";

export default function UploadPanel({ maxMb, onUploaded, onClose }: {
  maxMb: number;
  onUploaded: (video: VideoAsset, job: Job) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const request = useRef<XMLHttpRequest | null>(null);
  useEffect(() => () => {
    const current = request.current;
    request.current = null;
    current?.abort();
  }, []);

  function choose(next: File | undefined) {
    if (!next || busy) return;
    if (next.size > maxMb * 1024 * 1024) { setFile(null); setError(`O arquivo excede o limite de ${maxMb} MB.`); return; }
    if (!next.type.startsWith("video/") && !/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(next.name)) {
      setFile(null); setError("Escolha um arquivo de vídeo."); return;
    }
    setFile(next); setError("");
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }
  function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !title.trim() || request.current) return;
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    setBusy(true); setProgress(0); setError("");
    const finishError = (text: string) => {
      if (request.current !== xhr) return;
      request.current = null; setBusy(false); setError(text);
    };
    xhr.open("POST", "/api/videos");
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = event => {
      if (request.current === xhr && event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = () => finishError("Conexão interrompida. Verifique o acervo antes de enviar novamente.");
    xhr.ontimeout = () => finishError("O envio excedeu o tempo de espera. Verifique o acervo antes de repetir.");
    xhr.onload = () => {
      if (request.current !== xhr) return;
      if (xhr.status === 401) { finishError("Sua sessão expirou."); window.dispatchEvent(new Event("session-expired")); return; }
      try {
        const payload: unknown = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) {
          const detail = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Falha no envio (HTTP ${xhr.status}).`;
          finishError(detail); return;
        }
        if (!payload || typeof payload !== "object" || !("video" in payload) || !("job" in payload)) throw new Error("Resposta inválida");
        const data = payload as { video: VideoAsset; job: Job };
        request.current = null; setBusy(false);
        onUploaded(data.video, data.job);
      } catch { finishError("Resposta inesperada. Verifique o acervo antes de reenviar."); }
    };
    const form = new FormData();
    form.append("video", file); form.append("title", title.trim());
    xhr.send(form);
  }
  function cancel() {
    const xhr = request.current;
    request.current = null;
    xhr?.abort(); setBusy(false);
    setError("Envio interrompido neste navegador. Se o servidor já recebeu o vídeo, o processamento poderá continuar; confira o acervo.");
  }
  return <section className="panel upload-panel" aria-labelledby="upload-title">
    <div className="section-heading"><div><p className="eyebrow">Novo material</p><h2 id="upload-title">Adicionar ao acervo</h2></div><button className="icon-button" aria-label="Fechar envio" onClick={onClose} disabled={busy}><Icon name="close" /></button></div>
    <form onSubmit={upload}>
      <div className={`dropzone ${drag ? "dragging" : ""}`} onDragOver={event => { event.preventDefault(); if (!busy) setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); choose(event.dataTransfer.files[0]); }}>
        <Icon name="upload" size={26} /><strong>{file ? file.name : "Arraste um vídeo para cá"}</strong><span>ou escolha um arquivo local · até {maxMb} MB</span>
        <input aria-label="Escolher arquivo de vídeo" type="file" accept="video/*,.mkv" disabled={busy} onChange={event => choose(event.target.files?.[0])} />
      </div>
      <label className="field">Título editorial<input value={title} maxLength={200} required disabled={busy} placeholder="Como este vídeo deve aparecer no acervo?" onChange={event => setTitle(event.target.value)} /></label>
      {busy && <div className="upload-progress" role="status"><progress aria-label="Progresso de envio" max={100} value={progress} /><span>{progress < 100 ? `Enviando arquivo · ${progress}%` : "Arquivo enviado · aguardando confirmação do servidor…"}</span></div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-footer"><p className="muted">Após o envio, a análise e a projeção no grafo continuam em segundo plano.</p>{busy ? <button type="button" className="secondary" onClick={cancel}>Interromper envio</button> : <button className="primary" disabled={!file || !title.trim()}><Icon name="upload" />Enviar e processar</button>}</div>
    </form>
  </section>;
}
