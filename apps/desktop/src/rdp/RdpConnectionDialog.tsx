import { useEffect, useRef, useState } from "react";
import { FolderPicker } from "../connections/FolderPicker";
import { emptyRdpConnection } from "../connections/types";
import type { ConnectionFolder, RdpConnection, SavedRdpSession } from "../connections/types";

export function RdpConnectionDialog({ folders, initialSession, onCancel, onCreateFolder, onSubmit }: {
  folders: ConnectionFolder[];
  initialSession?: SavedRdpSession;
  onCancel: () => void;
  onCreateFolder: (name: string) => string;
  onSubmit: (connection: RdpConnection, save: boolean, folderId: string | null) => void;
}) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<RdpConnection>(() => initialSession ? { ...initialSession } : { ...emptyRdpConnection });
  const [save, setSave] = useState(editing);
  const [folderId, setFolderId] = useState(initialSession?.folderId ?? "");
  const hostInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hostInputRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  const setField = <K extends keyof RdpConnection>(key: K, value: RdpConnection[K]) => setConnection((current) => ({ ...current, [key]: value }));
  const valid = connection.host.trim().length > 0 && connection.port > 0 && connection.port <= 65535;

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form aria-labelledby="rdp-dialog-title" className="connection-dialog" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit({ ...connection, host: connection.host.trim(), username: connection.username.trim() }, editing || save, folderId || null);
      }}>
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon rdp-dialog-icon">RDP</div>
          <div><h2 id="rdp-dialog-title">{editing ? "编辑 RDP 会话" : "新建 RDP 连接"}</h2><p>在当前工作区内打开 Windows 远程桌面。</p></div>
        </header>
        <div className="connection-form-grid">
          <label className="form-field form-field-wide"><span>会话名称</span><input onChange={(event) => setField("name", event.target.value)} placeholder="例如：运维跳板机" value={connection.name} /></label>
          <label className="form-field form-field-host"><span>IP 地址或主机名</span><input autoComplete="off" onChange={(event) => setField("host", event.target.value)} placeholder="10.0.0.30" ref={hostInputRef} required value={connection.host} /></label>
          <label className="form-field form-field-port"><span>端口</span><input inputMode="numeric" max={65535} min={1} onChange={(event) => setField("port", Number(event.target.value))} required type="number" value={connection.port} /></label>
          <label className="form-field form-field-wide"><span>账号</span><input autoComplete="username" onChange={(event) => setField("username", event.target.value)} placeholder="可选；例如 DOMAIN\\administrator" value={connection.username} /></label>
          <label className="check-row form-field-wide"><input checked={connection.adminSession} onChange={(event) => setField("adminSession", event.target.checked)} type="checkbox" /><span><strong>管理会话</strong><small>连接到服务器的管理会话，仅在确有需要时启用</small></span></label>
          <div className="dialog-note form-field-wide"><strong>Windows 安全组件</strong><span>远程画面嵌入当前工作区；密码和证书确认仍由 Windows 官方 RDP 控件处理，NeTerminAI 不读取或保存密码。</span></div>
        </div>
        <div className="connection-save-options">
          {!editing && <label className="check-row"><input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" /><span><strong>保存会话</strong><small>保存连接参数，下次双击即可启动</small></span></label>}
          {(editing || save) && <FolderPicker folders={folders} folderId={folderId} onChange={setFolderId} onCreateFolder={onCreateFolder} />}
        </div>
        <footer className="connection-dialog-actions"><button className="secondary-button" onClick={onCancel} type="button">取消</button><button className="primary-button" disabled={!valid} type="submit">{editing ? "保存" : "打开远程桌面"}</button></footer>
      </form>
    </div>
  );
}
