import { useEffect, useRef, useState } from "react";
import { localTerminalProfiles } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { SavedTelnetSession, TelnetSessionFolder } from "./types";

interface ConnectionsSidebarProps {
  folders: TelnetSessionFolder[];
  sessions: SavedTelnetSession[];
  onConnect: (session: SavedTelnetSession) => void;
  onCreateFolder: () => void;
  onCreateLocal: (profileId: LocalTerminalProfileId) => void;
  onCreateTelnet: () => void;
  onEdit: (session: SavedTelnetSession) => void;
  onRemoveFolder: (folderId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onRenameFolder: (folder: TelnetSessionFolder) => void;
}

export function ConnectionsSidebar({
  folders,
  sessions,
  onConnect,
  onCreateFolder,
  onCreateLocal,
  onCreateTelnet,
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
        <span>Telnet 会话</span>
        <button aria-label="新建会话分区" className="group-add-button" onClick={onCreateFolder} title="新建分区" type="button">＋</button>
      </div>

      {folders.map((folder) => {
        const folderSessions = sessions.filter((session) => session.folderId === folder.id);
        const collapsed = collapsedFolders.has(folder.id);
        return (
          <section className="session-folder" key={folder.id}>
            <div className="session-folder-header">
              <button className="session-folder-toggle" onClick={() => toggleFolder(folder.id)} type="button">
                <span className="folder-chevron" data-collapsed={collapsed}>⌄</span>
                <span className="folder-symbol">▱</span>
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">{folderSessions.length}</span>
              </button>
              <div className="folder-actions">
                <button aria-label={`重命名 ${folder.name}`} onClick={() => onRenameFolder(folder)} title="重命名" type="button">✎</button>
                <button aria-label={`删除 ${folder.name}`} onClick={() => onRemoveFolder(folder.id)} title="删除分区，会话移至未分组" type="button">×</button>
              </div>
            </div>
            {!collapsed && folderSessions.map((session) => (
              <SavedSessionRow key={session.id} onConnect={onConnect} onEdit={onEdit} onRemove={onRemoveSession} session={session} />
            ))}
          </section>
        );
      })}

      {(ungrouped.length > 0 || folders.length === 0) && (
        <section className="session-folder ungrouped-folder">
          {folders.length > 0 && <div className="ungrouped-label">未分组</div>}
          {ungrouped.map((session) => (
            <SavedSessionRow key={session.id} onConnect={onConnect} onEdit={onEdit} onRemove={onRemoveSession} session={session} />
          ))}
        </section>
      )}

      <button className="new-connection-button" onClick={onCreateTelnet} type="button"><span>＋</span> 新建 Telnet 连接</button>
      {sessions.length > 0 && <p className="connection-gesture-hint">单击编辑 · 双击连接</p>}
    </div>
  );
}

function SavedSessionRow({ session, onConnect, onEdit, onRemove }: {
  session: SavedTelnetSession;
  onConnect: (session: SavedTelnetSession) => void;
  onEdit: (session: SavedTelnetSession) => void;
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
        <span className="connection-profile-icon telnet-profile-icon">{session.loginMode === "passwordOnly" ? "COM" : "TN"}</span>
        <span className="connection-name">{session.name}<small>{session.host}:{session.port}</small></span>
      </button>
      <button aria-label={`删除 ${session.name}`} className="saved-connection-remove" onClick={() => onRemove(session.id)} title="删除保存的会话" type="button">×</button>
    </div>
  );
}
