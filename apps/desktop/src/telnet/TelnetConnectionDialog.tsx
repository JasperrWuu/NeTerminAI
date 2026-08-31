import { useEffect, useRef, useState } from "react";
import { FolderPicker } from "../connections/FolderPicker";
import { emptyTelnetConnection } from "../connections/types";
import type { ConnectionFolder, SavedTelnetSession, TelnetConnection } from "../connections/types";

interface TelnetConnectionDialogProps {
  folders: ConnectionFolder[];
  initialSession?: SavedTelnetSession;
  onCancel: () => void;
  onSubmit: (connection: TelnetConnection, save: boolean, savesPassword: boolean, folderId: string | null) => void;
}

export function TelnetConnectionDialog({ folders, initialSession, onCancel, onSubmit }: TelnetConnectionDialogProps) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<TelnetConnection>(() => initialSession ? { ...initialSession } : { ...emptyTelnetConnection });
  const [save, setSave] = useState(editing);
  const [savesPassword, setSavesPassword] = useState(initialSession?.savesPassword ?? false);
  const [folderId, setFolderId] = useState(initialSession?.folderId ?? "");
  const hostInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hostInputRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  const setField = <K extends keyof TelnetConnection>(key: K, value: TelnetConnection[K]) => {
    setConnection((current) => ({ ...current, [key]: value }));
  };
  const valid = connection.host.trim().length > 0 && connection.port > 0 && connection.port <= 65535;

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form aria-labelledby="telnet-dialog-title" className="connection-dialog" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit({ ...connection, host: connection.host.trim() }, editing || save, savesPassword, folderId || null);
      }}>
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon">TN</div>
          <div>
            <h2 id="telnet-dialog-title">{editing ? "编辑 Telnet 会话" : "新建 Telnet 连接"}</h2>
            <p>账号与密码均可选，也支持仅输入设备密码的网络串口服务器。</p>
          </div>
        </header>

        <div className="connection-form-grid">
          <label className="form-field form-field-wide"><span>会话名称</span><input onChange={(event) => setField("name", event.target.value)} placeholder="例如：机房 A 防火墙" value={connection.name} /></label>
          <label className="form-field form-field-host"><span>IP 地址或主机名</span><input autoComplete="off" onChange={(event) => setField("host", event.target.value)} placeholder="192.168.1.1" ref={hostInputRef} required value={connection.host} /></label>
          <label className="form-field form-field-port"><span>端口</span><input inputMode="numeric" max={65535} min={1} onChange={(event) => setField("port", Number(event.target.value))} required type="number" value={connection.port} /></label>
          <label className="form-field"><span>账号</span><input autoComplete="username" onChange={(event) => setField("username", event.target.value)} placeholder="可选" value={connection.username} /></label>
          <label className="form-field"><span>密码</span><input autoComplete="current-password" onChange={(event) => setField("password", event.target.value)} placeholder="可选" type="password" value={connection.password} /></label>
        </div>

        <div className="connection-save-options">
          {!editing && <label className="check-row"><input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" /><span><strong>保存会话</strong><small>下次可从连接侧栏快速打开</small></span></label>}
          {(editing || save) && <><FolderPicker folders={folders} folderId={folderId} onChange={setFolderId} /><label className="check-row password-save-option"><input checked={savesPassword} onChange={(event) => setSavesPassword(event.target.checked)} type="checkbox" /><span><strong>同时保存密码</strong><small>当前版本将密码保存在本机应用数据中</small></span></label></>}
        </div>

        <footer className="connection-dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!valid} type="submit">{editing ? "保存" : "连接"}</button>
        </footer>
      </form>
    </div>
  );
}
