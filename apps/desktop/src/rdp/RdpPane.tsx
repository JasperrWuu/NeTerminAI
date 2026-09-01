import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RdpConnection } from "../connections/types";
import { invokeInBackground } from "../platform/tauri";

interface RdpBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RdpRuntimeStatus {
  state: "initializing" | "connecting" | "connected" | "disconnected";
  disconnectReason: string | null;
}

type RdpViewStatus = "initializing" | "connecting" | "ready" | "error";

export function RdpPane({ active, connection, connectionId, paneId, tabId }: { active: boolean; connection: RdpConnection; connectionId?: string; paneId?: string; tabId?: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hostReadyRef = useRef(false);
  const activeRef = useRef(active);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<RdpViewStatus>("initializing");
  const [error, setError] = useState("");

  activeRef.current = active;

  const focusRemoteDesktop = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) invokeInBackground("focus_rdp", { sessionId });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    viewport.closest<HTMLElement>(".rdp-pane")?.setAttribute("data-session-id", sessionId);
    hostReadyRef.current = false;
    setStatus("initializing");
    setError("");
    let disposed = false;
    let resizeFrame: number | undefined;
    let statusTimer: number | undefined;
    let disconnectedSince: number | undefined;
    let lastRuntimeState: RdpRuntimeStatus["state"] | undefined;

    const syncBounds = (visible: boolean) => {
      if (!hostReadyRef.current || disposed) return;
      invokeInBackground("resize_rdp", { sessionId, bounds: readBounds(viewport), visible });
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
        hostReadyRef.current = true;
        setStatus("connecting");
        syncBounds(activeRef.current);
        const pollStatus = async () => {
          if (disposed) return;
          try {
            const runtime = await invoke<RdpRuntimeStatus>("get_rdp_status", { sessionId });
            if (disposed) return;
            if (runtime.state !== lastRuntimeState) syncBounds(activeRef.current);
            lastRuntimeState = runtime.state;
            if (runtime.state === "connected") {
              disconnectedSince = undefined;
              setStatus("ready");
            } else if (runtime.state === "disconnected") {
              disconnectedSince ??= performance.now();
              if (runtime.disconnectReason || performance.now() - disconnectedSince > 15_000) {
                setStatus("error");
                setError(runtime.disconnectReason || "连接没有建立。请确认虚拟机已开启远程桌面，并检查地址、端口和网络策略。");
                invokeInBackground("resize_rdp", { sessionId, bounds: readBounds(viewport), visible: false });
                return;
              }
              setStatus("connecting");
            } else {
              disconnectedSince = undefined;
              setStatus(runtime.state === "initializing" ? "initializing" : "connecting");
            }
            statusTimer = window.setTimeout(pollStatus, 650);
          } catch (reason) {
            if (!disposed) {
              setStatus("error");
              setError(String(reason));
              invokeInBackground("resize_rdp", { sessionId, bounds: readBounds(viewport), visible: false });
            }
          }
        };
        void pollStatus();
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
      hostReadyRef.current = false;
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleResize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      if (statusTimer !== undefined) window.clearTimeout(statusTimer);
      if (sessionIdRef.current === sessionId) sessionIdRef.current = null;
      viewport.closest<HTMLElement>(".rdp-pane")?.removeAttribute("data-session-id");
      invokeInBackground("close_rdp", { sessionId });
    };
  }, [attempt, connection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const sessionId = sessionIdRef.current;
    if (!viewport || !sessionId || !hostReadyRef.current) return;
    invokeInBackground("resize_rdp", { sessionId, bounds: readBounds(viewport), visible: active });
    if (active && status === "ready") focusRemoteDesktop();
  }, [active, focusRemoteDesktop, status]);

  useEffect(() => {
    if (!active || status !== "ready") return;
    window.addEventListener("focus", focusRemoteDesktop);
    return () => window.removeEventListener("focus", focusRemoteDesktop);
  }, [active, focusRemoteDesktop, status]);

  return (
    <section aria-hidden={!active} className="rdp-pane workspace-view" data-active={active} data-connection-id={connectionId} data-pane-id={paneId} data-tab-id={tabId}>
      <header className="rdp-session-toolbar">
        <span className="rdp-session-badge">RDP</span>
        <span className="rdp-session-title">{connection.name.trim() || connection.host}</span>
        <span className="rdp-session-address">{connection.host}:{connection.port}</span>
        <span className="rdp-session-spacer" />
        <span className="rdp-session-state" data-status={status}>
          <i />{rdpStatusLabel(status)}
        </span>
      </header>
      <div className="rdp-native-viewport" onPointerDown={focusRemoteDesktop} ref={viewportRef}>
        {status !== "ready" && (
          <div className="rdp-status-card" data-status={status}>
            <div className="rdp-status-icon">RDP</div>
            <div className="rdp-status-copy">
              <span className="eyebrow">应用内远程桌面</span>
              <h1>{connection.name.trim() || connection.host}</h1>
              <p>{connection.host}:{connection.port}{connection.username ? ` · ${connection.username}` : ""}</p>
              <div className="rdp-launch-state" aria-live="polite">
                {status === "initializing"
                  ? "正在初始化 Windows 远程桌面控件…"
                  : status === "connecting"
                    ? "正在建立连接；如需凭据，Windows 会在此窗口内提示。"
                    : error || "无法创建应用内远程桌面"}
              </div>
              {status === "error" && (
                <button className="secondary-button rdp-retry-button" onClick={() => setAttempt((current) => current + 1)} type="button">
                  重新连接
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function rdpStatusLabel(status: RdpViewStatus) {
  if (status === "initializing") return "正在初始化";
  if (status === "connecting") return "正在连接";
  if (status === "ready") return "已连接";
  return "连接失败";
}

function readBounds(element: HTMLElement): RdpBounds {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}
