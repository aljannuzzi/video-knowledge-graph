export class ApiError extends Error {
  constructor(public status: number, text: string) {
    super(text);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init.headers }
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error : `Não foi possível concluir a solicitação (HTTP ${response.status}).`;
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : "Ocorreu um erro inesperado. Tente novamente.";
}

export function timecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  return `${Math.floor(total / 3600000).toString().padStart(2, "0")}:${Math.floor(total / 60000 % 60).toString().padStart(2, "0")}:${Math.floor(total / 1000 % 60).toString().padStart(2, "0")}.${(total % 1000).toString().padStart(3, "0")}`;
}

export function mediaUri(uri: string): string {
  try {
    const url = new URL(uri, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/media/") ? url.href : "";
  } catch { return ""; }
}

export function sceneKey(scene: { videoId: string; id: string }): string {
  return `${scene.videoId}:${scene.id}`;
}
