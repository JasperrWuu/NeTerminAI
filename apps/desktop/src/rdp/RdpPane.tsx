import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RdpConnection } from "../connections/types";

export function RdpPane({ active, connection }: { active: boolean; connection: RdpConnection }) {
  const launchedRef = useRef(false);
  const [status, setStatus] = useState<"launching" | "launched" | "error">("launching");
  const [error, setError] = useState("");

  const launch = useCallback(async () => {
    setStatus("launching");
    setError("");
    try {
      await invoke("open_rdp", {
        sessionId: crypto.randomUUID(),
        host: connection.host,
        port: connection.port,
        username: connection.username,
        displayMode: connection.displayMode,
        adminSession: connection.adminSession,
      });
      setStatus("launched");
    } catch (reason) {
      setStatus("error");
      setError(String(reason));
    }
  }, [connection]);

  useEffect(() => {
    if (launchedRef.current) return;
    launchedRef.current = true;
    void launch();
  }, [launch]);

  return (
    <section aria-hidden={!active} className="rdp-pane workspace-view" data-active={active}>
      <div className="rdp-status-card" data-status={status}>
        <div className="rdp-status-icon">RDP</div>
        <div className="rdp-status-copy">
          <span className="eyebrow">Windows 远程桌面</span>
          <h1>{connection.name.trim() || connection.host}</h1>
          <p>{connection.host}:{connection.port}{connection.username ? ` · ${connection.username}` : ""}</p>
          <div className="rdp-launch-state" aria-live="polite">
            {status === "launching" && "正在交给 Windows 打开…"}
            {status === "launched" && "远程桌面已在独立系统窗口中打开。凭据和证书确认由 Windows 处理。"}
            {status === "error" && (error || "无法打开 Windows 远程桌面")}
          </div>
          <button className="primary-button" disabled={status === "launching"} onClick={() => void launch()} type="button">
            {status === "launching" ? "正在打开" : "再次打开"}
          </button>
        </div>
      </div>
    </section>
  );
}
