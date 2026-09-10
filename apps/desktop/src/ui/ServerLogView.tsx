import { useEffect, useRef } from "react";
import "./serverTool.css";

export interface ServerLogLine { id: number; timestamp: number; metadata: string; message: string }
export function ServerLogView({ entries, label, empty }: { entries: ServerLogLine[]; label: string; empty: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (follow.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => { const el = viewport.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [entries]);
  return <div className="server-log-view" ref={viewport} tabIndex={0} aria-label={label} onScroll={(event) => {
    const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
  }}>
    {!entries.length && <p className="server-log-empty">{empty}</p>}
    {entries.map((entry) => <div className="server-log-line" key={entry.id}>
      <div className="server-log-meta"><time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}.{String(entry.timestamp % 1000).padStart(3, "0")}</time><span>{entry.metadata}</span></div>
      <pre>{entry.message}</pre>
    </div>)}
  </div>;
}
