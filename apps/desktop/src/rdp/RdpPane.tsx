import { useEffect, useRef, useState } from "react";
import type { RdpConnection } from "../connections/types";
import {
  RdpSessionRegistry,
  type RdpSessionRuntimeSnapshot,
} from "./RdpSessionRegistry";

interface RdpPaneProps {
  active: boolean;
  paneActive: boolean;
  connection: RdpConnection;
  paneId: string;
  tabId: string;
  registry: RdpSessionRegistry;
  onActivate: () => void;
}

export function RdpPane({ active, paneActive, connection, paneId, tabId, registry, onActivate }: RdpPaneProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<RdpSessionRuntimeSnapshot | undefined>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const runtime = registry.acquire(tabId, connection, {
      container: viewport,
      active,
      paneActive,
      onActivate,
    });
    setSnapshot(runtime.getSnapshot());
    const unsubscribe = registry.subscribe(tabId, () => {
      setSnapshot(runtime.getSnapshot());
    });
    return () => {
      unsubscribe();
      registry.releaseView(tabId, viewport);
    };
  }, [attempt, connection, registry, tabId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const runtime = registry.get(tabId);
    runtime?.updateView({ container: viewport, active, paneActive, onActivate });
    if (active) runtime?.focus();
  }, [active, onActivate, paneActive, registry, tabId]);

  const status = viewStatus(snapshot);
  const error = snapshot?.error ?? "";
  const retry = () => {
    registry.restart(tabId);
    setSnapshot(undefined);
    setAttempt((value) => value + 1);
  };

  return (
    <section
      aria-hidden={!active}
      className="rdp-pane workspace-view"
      data-active={active}
      data-pane-id={paneId}
      data-session-id={snapshot?.sessionId ?? ""}
      onPointerDown={onActivate}
    >
      <header className="rdp-session-toolbar">
        <span className="rdp-session-badge">RDP</span>
        <span className="rdp-session-title">{connection.name.trim() || connection.host}</span>
        <span className="rdp-session-address">{connection.host}:{connection.port}</span>
        <span className="rdp-session-spacer" />
        <span className="rdp-session-state" data-status={status}>
          <i />{rdpStatusLabel(status)}
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
              <div aria-live="polite" className="rdp-launch-state">
                {status === "initializing"
                  ? "正在初始化 Windows 远程桌面控件…"
                  : status === "connecting"
                    ? "正在建立连接；如需凭据，Windows 会在此窗口内提示。"
                    : error || "无法创建应用内远程桌面"}
              </div>
              {status === "error" && (
                <button className="secondary-button rdp-retry-button" onClick={retry} type="button">
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

type ViewStatus = "initializing" | "connecting" | "ready" | "error";

function viewStatus(snapshot: RdpSessionRuntimeSnapshot | undefined): ViewStatus {
  if (!snapshot) return "initializing";
  if (snapshot.state === "connected") return "ready";
  if (snapshot.state === "disconnected") return "error";
  return snapshot.state;
}

function rdpStatusLabel(status: ViewStatus) {
  if (status === "initializing") return "正在初始化";
  if (status === "connecting") return "正在连接";
  if (status === "ready") return "已连接";
  return "连接失败";
}
