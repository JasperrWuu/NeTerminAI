import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RdpConnection } from "../connections/types";

interface RdpBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function RdpPane({ active, connection }: { active: boolean; connection: RdpConnection }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const activeRef = useRef(active);
  const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState("");

  activeRef.current = active;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    readyRef.current = false;
    setStatus("connecting");
    setError("");
    let disposed = false;
    let resizeFrame: number | undefined;

    const syncBounds = (visible: boolean) => {
      if (!readyRef.current || disposed) return;
      void invoke("resize_rdp", { sessionId, bounds: readBounds(viewport), visible });
    };
    const scheduleResize = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        syncBounds(activeRef.current);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(viewport);
    window.addEventListener("resize", scheduleResize);

    const connect = async () => {
      try {
        await invoke("create_rdp", {
          sessionId,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          adminSession: connection.adminSession,
          bounds: readBounds(viewport),
        });
        if (disposed) {
          await invoke("close_rdp", { sessionId });
          return;
        }
        readyRef.current = true;
        setStatus("ready");
        syncBounds(activeRef.current);
      } catch (reason) {
        if (!disposed) {
          setStatus("error");
          setError(String(reason));
        }
      }
    };
    void connect();

    return () => {
      disposed = true;
      readyRef.current = false;
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleResize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      if (sessionIdRef.current === sessionId) sessionIdRef.current = null;
      void invoke("close_rdp", { sessionId });
    };
  }, [connection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const sessionId = sessionIdRef.current;
    if (!viewport || !sessionId || !readyRef.current) return;
    void invoke("resize_rdp", { sessionId, bounds: readBounds(viewport), visible: active });
  }, [active, status]);

  return (
    <section aria-hidden={!active} className="rdp-pane workspace-view" data-active={active}>
      <header className="rdp-session-toolbar">
        <span className="rdp-session-badge">RDP</span>
        <span className="rdp-session-title">{connection.name.trim() || connection.host}</span>
        <span className="rdp-session-address">{connection.host}:{connection.port}</span>
        <span className="rdp-session-spacer" />
        <span className="rdp-session-state" data-status={status}>
          <i />{status === "connecting" ? "正在初始化" : status === "ready" ? "RDP 控件运行中" : "连接失败"}
        </span>
      </header>
      <div className="rdp-native-viewport" ref={viewportRef}>
        {status !== "ready" && (
          <div className="rdp-status-card" data-status={status}>
            <div className="rdp-status-icon">RDP</div>
            <div className="rdp-status-copy">
              <span className="eyebrow">应用内远程桌面</span>
              <h1>{connection.name.trim() || connection.host}</h1>
              <p>{connection.host}:{connection.port}{connection.username ? ` · ${connection.username}` : ""}</p>
              <div className="rdp-launch-state" aria-live="polite">
                {status === "connecting" ? "正在初始化 Windows 远程桌面控件…" : error || "无法创建应用内远程桌面"}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function readBounds(element: HTMLElement): RdpBounds {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}
