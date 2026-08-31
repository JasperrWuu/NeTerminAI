import { useEffect, useRef, useState } from "react";
import { localTerminalProfiles } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import { ChevronIcon, CloseIcon, EditIcon, FolderIcon, PlusIcon } from "../workbench/icons";
import type { ConnectionFolder, SavedConnectionSession } from "./types";

interface ConnectionsSidebarProps {
  folders: ConnectionFolder[];
  sessions: SavedConnectionSession[];
  onConnect: (session: SavedConnectionSession) => void;
  onCreateFolder: () => void;
  onCreateLocal: (profileId: LocalTerminalProfileId) => void;
  onCreateTelnet: () => void;
  onCreateSerial: () => void;
  onEdit: (session: SavedConnectionSession) => void;
  onRemoveFolder: (folderId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onRenameFolder: (folder: ConnectionFolder) => void;
}

export function ConnectionsSidebar({
  folders,
  sessions,
  onConnect,
  onCreateFolder,
  onCreateLocal,
  onCreateTelnet,
  onCreateSerial,
  onEdit,
  onRemoveFolder,
  onRemoveSession,
  onRenameFolder,
}: ConnectionsSidebarProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const ungrouped = sessions.filter((session) => session.folderId === null);
  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  return (
    <div className="connection-list">
      <div className="connection-group-label">本地终端</div>
      {localTerminalProfiles.map((profile) => (
        <button className="connection-item" key={profile.id} onClick={() => onCreateLocal(profile.id)} type="button">
          <span className="connection-profile-icon">{profile.shortName}</span>
          <span className="connection-name">{profile.name}</span>
          <span className="connection-kind">本地</span>
        </button>
      ))}

      <div className="connection-group-label remote-group-label">
        <span>远程与串口</span>
        <button aria-label="新建会话分区" className="group-add-button" onClick={onCreateFolder} title="新建分区" type="button"><FolderIcon /><PlusIcon /></button>
      </div>

      {folders.map((folder) => {
        const folderSessions = sessions.filter((session) => session.folderId === folder.id);
        const collapsed = collapsedFolders.has(folder.id);
        return (
          <section className="session-folder" key={folder.id}>
            <div className="session-folder-header">
              <button className="session-folder-toggle" onClick={() => toggleFolder(folder.id)} type="button">
                <ChevronIcon className="folder-chevron" data-collapsed={collapsed} />
                <FolderIcon className="folder-symbol" />
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">{folderSessions.length}</span>
              </button>
              <div className="folder-actions">
                <button aria-label={`重命名 ${folder.name}`} onClick={() => onRenameFolder(folder)} title="重命名" type="button"><EditIcon /></button>
                <button aria-label={`删除 ${folder.name}`} onClick={() => onRemoveFolder(folder.id)} title="删除分区，会话移至未分组" type="button"><CloseIcon /></button>
              </div>
            </div>
            {!collapsed && (
              <div className="session-folder-contents">
                {folderSessions.map((session) => <SavedSessionRow key={session.id} onConnect={onConnect} onEdit={onEdit} onRemove={onRemoveSession} session={session} />)}
                {folderSessions.length === 0 && <p className="empty-folder-hint">暂无会话</p>}
              </div>
            )}
          </section>
        );
      })}

      {(ungrouped.length > 0 || folders.length === 0) && (
        <section className="session-folder ungrouped-folder">
          {folders.length > 0 && <div className="ungrouped-label">未分组</div>}
          {ungrouped.map((session) => <SavedSessionRow key={session.id} onConnect={onConnect} onEdit={onEdit} onRemove={onRemoveSession} session={session} />)}
        </section>
      )}

      <button className="new-connection-button" onClick={onCreateTelnet} type="button">
        <span className="new-connection-icon"><PlusIcon /></span>
        <span className="new-connection-copy"><strong>新建 Telnet 连接</strong><small>设置地址、端口与认证</small></span>
      </button>
      <button className="new-connection-button" onClick={onCreateSerial} type="button">
        <span className="new-connection-icon serial-new-connection-icon"><PlusIcon /></span>
        <span className="new-connection-copy"><strong>新建串口连接</strong><small>设置 COM 口与串口参数</small></span>
      </button>
      {sessions.length > 0 && <p className="connection-gesture-hint">单击编辑 · 双击连接</p>}
    </div>
  );
}

function SavedSessionRow({ session, onConnect, onEdit, onRemove }: {
  session: SavedConnectionSession;
  onConnect: (session: SavedConnectionSession) => void;
  onEdit: (session: SavedConnectionSession) => void;
  onRemove: (sessionId: string) => void;
}) {
  const clickTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
  }, []);

  return (
    <div className="saved-connection-row">
      <button
        className="connection-item saved-connection-main"
        onClick={() => {
          if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            onEdit(session);
          }, 260);
        }}
        onDoubleClick={() => {
          if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
          clickTimer.current = null;
          onConnect(session);
        }}
        title="单击编辑，双击连接"
        type="button"
      >
        <span className={`connection-profile-icon ${session.kind}-profile-icon`}>{session.kind === "telnet" ? "TEL" : "COM"}</span>
        <span className="connection-name">{session.name}<small>{session.kind === "telnet" ? `${session.host}:${session.port}` : `${session.portName} · ${session.baudRate}`}</small></span>
        <span className="session-mode">{session.kind === "telnet" ? "Telnet" : "串口"}</span>
      </button>
      <button aria-label={`删除 ${session.name}`} className="saved-connection-remove" onClick={() => onRemove(session.id)} title="删除保存的会话" type="button"><CloseIcon /></button>
    </div>
  );
}
