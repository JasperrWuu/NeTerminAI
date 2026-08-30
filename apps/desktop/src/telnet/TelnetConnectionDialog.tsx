import { useEffect, useRef, useState } from "react";
import { emptyTelnetConnection } from "./types";
import type {
  SavedTelnetSession,
  TelnetConnection,
  TelnetLoginMode,
  TelnetSessionFolder,
} from "./types";
import { FolderIcon } from "../workbench/icons";

interface TelnetConnectionDialogProps {
  folders: TelnetSessionFolder[];
  initialSession?: SavedTelnetSession;
  onCancel: () => void;
  onSubmit: (
    connection: TelnetConnection,
    save: boolean,
    savesPassword: boolean,
    folderId: string | null,
  ) => void;
}

export function TelnetConnectionDialog({ folders, initialSession, onCancel, onSubmit }: TelnetConnectionDialogProps) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<TelnetConnection>(() =>
    initialSession ? { ...initialSession } : { ...emptyTelnetConnection },
  );
  const [save, setSave] = useState(editing);
  const [savesPassword, setSavesPassword] = useState(initialSession?.savesPassword ?? false);
  const [folderId, setFolderId] = useState(initialSession?.folderId ?? "");
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [loginModeTouched, setLoginModeTouched] = useState(editing);
  const hostInputRef = useRef<HTMLInputElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hostInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (folderMenuOpen) setFolderMenuOpen(false);
      else onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [folderMenuOpen, onCancel]);

  useEffect(() => {
    if (!folderMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!folderMenuRef.current?.contains(event.target as Node)) setFolderMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [folderMenuOpen]);

  const setField = <K extends keyof TelnetConnection>(key: K, value: TelnetConnection[K]) => {
    setConnection((current) => ({ ...current, [key]: value }));
  };
  const selectLoginMode = (loginMode: TelnetLoginMode) => {
    setLoginModeTouched(true);
    setConnection((current) => ({
      ...current,
      loginMode,
      username: loginMode === "passwordOnly" ? "" : current.username,
    }));
  };
  const valid = connection.host.trim().length > 0 && connection.port > 0 && connection.port <= 65535;
  const selectedFolderName = folders.find((folder) => folder.id === folderId)?.name ?? "未分组";

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form
        aria-labelledby="telnet-dialog-title"
        className="connection-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            onSubmit(
              { ...connection, host: connection.host.trim() },
              editing || save,
              savesPassword,
              folderId || null,
            );
          }
        }}
      >
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon">{connection.loginMode === "passwordOnly" ? "COM" : "TN"}</div>
          <div>
            <h2 id="telnet-dialog-title">{editing ? "编辑 Telnet 会话" : "新建 Telnet 连接"}</h2>
            <p>{editing ? "修改会话资料；双击侧栏中的会话可直接连接。" : "配置远程主机并打开终端。"}</p>
          </div>
        </header>

        <div className="connection-form-grid">
          <fieldset className="form-field form-field-wide connection-mode-field">
            <legend>连接方式</legend>
            <div className="connection-mode-selector">
              <button data-active={connection.loginMode === "usernamePassword"} onClick={() => selectLoginMode("usernamePassword")} type="button">
                <strong>标准 Telnet</strong><small>账号与密码</small>
              </button>
              <button data-active={connection.loginMode === "passwordOnly"} onClick={() => selectLoginMode("passwordOnly")} type="button">
                <strong>串口服务器</strong><small>仅输入设备密码</small>
              </button>
            </div>
          </fieldset>
          <label className="form-field form-field-wide">
            <span>会话名称</span>
            <input onChange={(event) => setField("name", event.target.value)} placeholder="例如：机房 A 防火墙" value={connection.name} />
          </label>
          <label className="form-field form-field-host">
            <span>IP 地址或主机名</span>
            <input autoComplete="off" onChange={(event) => setField("host", event.target.value)} placeholder="192.168.1.1" ref={hostInputRef} required value={connection.host} />
          </label>
          <label className="form-field form-field-port">
            <span>端口</span>
            <input
              inputMode="numeric" max={65535} min={1} required type="number" value={connection.port}
              onChange={(event) => {
                const port = Number(event.target.value);
                setConnection((current) => ({
                  ...current,
                  port,
                  loginMode: loginModeTouched ? current.loginMode : port === 23 ? "usernamePassword" : "passwordOnly",
                  username: !loginModeTouched && port !== 23 ? "" : current.username,
                }));
              }}
            />
          </label>
          {connection.loginMode === "usernamePassword" && (
            <label className="form-field">
              <span>账号</span>
              <input autoComplete="username" onChange={(event) => setField("username", event.target.value)} placeholder="可选" value={connection.username} />
            </label>
          )}
          <label className={`form-field ${connection.loginMode === "passwordOnly" ? "form-field-wide" : ""}`}>
            <span>{connection.loginMode === "passwordOnly" ? "设备密码" : "密码"}</span>
            <input autoComplete="current-password" onChange={(event) => setField("password", event.target.value)} placeholder="可选" type="password" value={connection.password} />
          </label>
        </div>

        <div className="connection-save-options">
          {!editing && (
            <label className="check-row">
              <input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" />
              <span><strong>保存会话</strong><small>下次可从连接侧栏快速打开</small></span>
            </label>
          )}
          {(editing || save) && (
            <>
              <div className="form-field session-folder-field" ref={folderMenuRef}>
                <span>保存到分区</span>
                <button
                  aria-expanded={folderMenuOpen}
                  aria-haspopup="listbox"
                  className="folder-picker-trigger"
                  onClick={() => setFolderMenuOpen((open) => !open)}
                  type="button"
                >
                  <span className="folder-picker-icon"><FolderIcon /></span>
                  <span>{selectedFolderName}</span>
                  <i aria-hidden="true" />
                </button>
                {folderMenuOpen && (
                  <div className="folder-picker-menu" role="listbox" aria-label="保存到分区">
                    <FolderOption label="未分组" selected={!folderId} onSelect={() => { setFolderId(""); setFolderMenuOpen(false); }} />
                    {folders.map((folder) => (
                      <FolderOption key={folder.id} label={folder.name} selected={folderId === folder.id} onSelect={() => { setFolderId(folder.id); setFolderMenuOpen(false); }} />
                    ))}
                  </div>
                )}
              </div>
              <label className="check-row password-save-option">
                <input checked={savesPassword} onChange={(event) => setSavesPassword(event.target.checked)} type="checkbox" />
                <span><strong>同时保存密码</strong><small>当前版本将密码保存在本机应用数据中</small></span>
              </label>
            </>
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

function FolderOption({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button aria-selected={selected} className="folder-picker-option" onClick={onSelect} role="option" type="button">
      <span className="folder-picker-option-check">{selected ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );
}
