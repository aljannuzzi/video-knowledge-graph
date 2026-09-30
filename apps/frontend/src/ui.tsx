import { useState } from "react";
import { mediaUri } from "./lib";

type IconName = "search" | "archive" | "jobs" | "upload" | "arrow" | "close" | "play" | "graph" | "film" | "logout";
const paths: Record<IconName, string> = {
  search: "m21 21-4.5-4.5 M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  archive: "M3 4h18v5H3z M5 9v12h14V9 M9 13h6",
  jobs: "M12 8v5l3 2 M21 12a9 9 0 1 1-9-9 M16 3h5v5 M21 3l-5 5",
  upload: "M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6",
  arrow: "M4 12h16 M14 6l6 6-6 6",
  close: "m6 6 12 12 M6 18 18 6",
  play: "m8 5 12 7-12 7Z",
  graph: "M9 6h6 M7 9l4 7 M17 9l-4 7 M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M15 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  film: "M3 3h18v18H3z M7 3v18 M17 3v18 M3 8h4 M3 16h4 M17 8h4 M17 16h4",
  logout: "M9 3H3v18h6 M9 12h12 M16 7l5 5-5 5"
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Thumbnail({ uri, title }: { uri: string; title: string }) {
  const [failed, setFailed] = useState("");
  const src = mediaUri(uri);
  return <div className="thumbnail">{src && failed !== uri
    ? <img src={src} alt={title} loading="lazy" onError={() => setFailed(uri)} />
    : <div className="thumbnail-fallback"><Icon name="film" size={28} /><span>Prévia indisponível</span></div>}</div>;
}
export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="film" size={30} /></span><h3>{title}</h3><p>{children}</p></div>;
}
