import { useEffect, useRef, useState } from "react";
import { FolderPicker } from "../connections/FolderPicker";
import { emptySshConnection } from "../connections/types";
import type {
  ConnectionFolder,
  SavedSshSession,
  SshAuthentication,
  SshConnection,
  SshHostKeyAction,
} from "../connections/types";
import { SegmentedControl } from "../ui/SegmentedControl";

const authenticationOptions = [
  { value: "password", label: "密码" },
  { value: "key", label: "私钥" },
  { value: "config", label: "SSH 配置" },
] as const;

interface SshConnectionDialogProps {
  folders: ConnectionFolder[];
  initialSession?: SavedSshSession;
  onCancel: () => void;
  onCreateFolder: (name: string) => string;
  onSubmit: (
    connection: SshConnection,
    save: boolean,
    folderId: string | null,
    hostKeyAction: SshHostKeyAction,
    connect: boolean,
  ) => void;
}

export function SshConnectionDialog({
  folders,
  initialSession,
  onCancel,
  onCreateFolder,
  onSubmit,
}: SshConnectionDialogProps) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<SshConnection>(
    () => initialSession ? { ...initialSession } : { ...emptySshConnection },
  );
  const [save, setSave] = useState(editing);
  const [folderId, setFolderId] = useState(initialSession?.folderId ?? "");
  const [hostKeyAction, setHostKeyAction] = useState<SshHostKeyAction>("strict");
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
  const valid = connection.host.trim().length > 0
    && connection.port > 0
    && connection.port <= 65535
    && (connection.authentication !== "password" || connection.username.trim().length > 0)
    && (connection.authentication !== "key" || connection.identityFile.trim().length > 0);

  const submit = (connect: boolean) => {
    if (!valid) return;
    onSubmit(
      {
        ...connection,
        host: connection.host.trim(),
        username: connection.username.trim(),
        identityFile: connection.identityFile.trim(),
      },
      editing || save,
      folderId || null,
      hostKeyAction,
      connect,
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
          submit(false);
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
            <input onChange={(event) => setField("name", event.target.value)} placeholder="例如：生产环境 Linux" value={connection.name} />
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
            <input autoComplete="username" onChange={(event) => setField("username", event.target.value)} placeholder={connection.authentication === "config" ? "可选；留空时使用 SSH 配置" : "例如 root 或 administrator"} required={connection.authentication === "password"} value={connection.username} />
          </label>
          <div className="form-field form-field-wide option-field">
            <span>认证方式</span>
            <SegmentedControl ariaLabel="SSH 认证方式" items={authenticationOptions} onChange={(value) => setField("authentication", value)} value={connection.authentication} />
          </div>
          {connection.authentication === "key" && (
            <label className="form-field form-field-wide">
              <span>私钥文件</span>
              <input onChange={(event) => setField("identityFile", event.target.value)} placeholder="例如 C:\\Users\\you\\.ssh\\id_ed25519" required value={connection.identityFile} />
            </label>
          )}
          <div className="dialog-note form-field-wide">
            <strong>安全认证</strong>
            <span>{authenticationNote(connection.authentication)}</span>
          </div>
        </div>

        <div className="connection-save-options">
          {!editing && (
            <label className="check-row">
              <input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" />
              <span><strong>保存会话</strong><small>保存地址和认证方式，不保存密码</small></span>
            </label>
          )}
          {(editing || save) && <FolderPicker folders={folders} folderId={folderId} onChange={setFolderId} onCreateFolder={onCreateFolder} />}
          <label className="check-row ssh-host-key-option" data-warning={hostKeyAction === "replace"}>
            <input
              checked={hostKeyAction === "replace"}
              onChange={(event) => setHostKeyAction(event.target.checked ? "replace" : "strict")}
              type="checkbox"
            />
            <span>
              <strong>虚拟机重装后更新主机密钥</strong>
              <small>仅本次连接移除该主机的旧 known_hosts 记录，再由 OpenSSH 校验并记录新密钥。</small>
            </span>
          </label>
        </div>

        <footer className="connection-dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">取消</button>
          {editing && hostKeyAction === "replace" && (
            <button className="secondary-button" onClick={() => submit(true)} type="button">保存并连接</button>
          )}
          <button className="primary-button" disabled={!valid} type="submit">{editing ? "保存" : "连接"}</button>
        </footer>
      </form>
    </div>
  );
}

function authenticationNote(authentication: SshAuthentication) {
  if (authentication === "password") return "连接后请在终端输入密码；密码输入时不会显示字符。应用不会读取或保存密码。";
  if (authentication === "key") return "仅使用所选私钥认证；如果私钥有口令，OpenSSH 会在终端内询问。";
  return "遵循系统 SSH 配置与 ssh-agent 的认证顺序，适合已经维护 ~/.ssh/config 的连接。";
}
