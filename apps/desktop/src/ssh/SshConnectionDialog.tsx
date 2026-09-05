import { useEffect, useRef, useState } from "react";
import { emptySshConnection } from "../connections/types";
import type {
  SavedSshSession,
  SshConnection,
} from "../connections/types";

interface SshConnectionDialogProps {
  initialSession?: SavedSshSession;
  onCancel: () => void;
  onSubmit: (
    connection: SshConnection,
    save: boolean,
  ) => void;
}

export function SshConnectionDialog({
  initialSession,
  onCancel,
  onSubmit,
}: SshConnectionDialogProps) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<SshConnection>(
    () => initialSession ? { ...initialSession } : { ...emptySshConnection },
  );
  const [save, setSave] = useState(editing);
  const hostInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hostInputRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  const setField = <K extends keyof SshConnection>(key: K, value: SshConnection[K]) => {
    setConnection((current) => ({ ...current, [key]: value }));
  };
  const valid = connection.name.trim().length > 0
    && connection.host.trim().length > 0
    && connection.port > 0
    && connection.port <= 65535
    && connection.username.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSubmit(
      {
        ...connection,
        name: connection.name.trim(),
        host: connection.host.trim(),
        username: connection.username.trim(),
      },
      editing || save,
    );
  };

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form
        aria-labelledby="ssh-dialog-title"
        className="connection-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon ssh-dialog-icon">SSH</div>
          <div>
            <h2 id="ssh-dialog-title">{editing ? "编辑 SSH 会话" : "新建 SSH 连接"}</h2>
            <p>使用系统 OpenSSH，在应用内打开安全终端。</p>
          </div>
        </header>

        <div className="connection-form-grid">
          <label className="form-field form-field-wide">
            <span>会话名称</span>
            <input onChange={(event) => setField("name", event.target.value)} placeholder="例如：生产环境 Linux" required value={connection.name} />
          </label>
          <label className="form-field form-field-host">
            <span>IP 地址或主机名</span>
            <input autoComplete="off" onChange={(event) => setField("host", event.target.value)} placeholder="10.0.0.20" ref={hostInputRef} required value={connection.host} />
          </label>
          <label className="form-field form-field-port">
            <span>端口</span>
            <input inputMode="numeric" max={65535} min={1} onChange={(event) => setField("port", Number(event.target.value))} required type="number" value={connection.port} />
          </label>
          <label className="form-field form-field-wide">
            <span>账号</span>
            <input autoComplete="username" onChange={(event) => setField("username", event.target.value)} placeholder="例如 root 或 administrator" required value={connection.username} />
          </label>
          <div className="dialog-note form-field-wide">
            <strong>主机密钥</strong>
            <span>每次连接前自动移除该地址的旧 known_hosts 记录，并接受和保存当前主机密钥，适用于虚拟机重装后的重新连接。</span>
          </div>
        </div>

        <div className="connection-save-options">
          {!editing && (
            <label className="check-row">
              <input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" />
              <span><strong>保存会话</strong><small>保存会话名称、地址和账号，不保存密码</small></span>
            </label>
          )}
        </div>

        <footer className="connection-dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!valid} type="submit">{editing ? "保存" : "连接"}</button>
        </footer>
      </form>
    </div>
  );
}
