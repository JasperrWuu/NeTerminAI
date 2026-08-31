import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { WorkbenchPreferencesController } from "./useWorkbenchPreferences";
import type { ApplicationSettingsController } from "../settings/useApplicationSettings";
import type { ActivityId } from "./types";
import {
  AssistantIcon,
  ConnectionIcon,
  MoonIcon,
  SettingsIcon,
  SidebarIcon,
  SunIcon,
  ToolsIcon,
  WorkspaceIcon,
} from "./icons";
import { usePanelResize } from "./usePanelResize";
import { TerminalPane } from "../terminal/TerminalPane";
import { WorkspaceTabs } from "../workspace/WorkspaceTabs";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";
import { TerminalSettingsView } from "../settings/TerminalSettingsView";
import { TelnetConnectionDialog } from "../telnet/TelnetConnectionDialog";
import { SessionFolderDialog } from "../telnet/SessionFolderDialog";
import { ConnectionsSidebar } from "../telnet/ConnectionsSidebar";
import { SerialConnectionDialog } from "../serial/SerialConnectionDialog";
import type { ConnectionFolder, SavedConnectionSession, SavedSerialSession, SavedTelnetSession } from "../connections/types";
import { useConnectionLibrary } from "../connections/useConnectionLibrary";

interface WorkbenchProps {
  preferences: WorkbenchPreferencesController;
  settings: ApplicationSettingsController;
}

interface Activity {
  id: ActivityId;
  label: string;
  icon: ReactNode;
}

const activities: Activity[] = [
  { id: "connections", label: "连接", icon: <ConnectionIcon /> },
  { id: "workspace", label: "工作区", icon: <WorkspaceIcon /> },
  { id: "tools", label: "工具", icon: <ToolsIcon /> },
];

const panelCopy: Record<ActivityId, { title: string; description: string }> = {
  connections: {
    title: "连接",
    description: "本地终端与远程连接将在这里集中管理。",
  },
  workspace: {
    title: "工作区",
    description: "保存当前会话、布局和项目上下文。",
  },
  tools: {
    title: "工具",
    description: "网络服务与文本工具将在后续增量加入。",
  },
};

export function Workbench({ preferences, settings }: WorkbenchProps) {
  const [activity, setActivity] = useState<ActivityId>("connections");
  const workspaceTabs = useWorkspaceTabs();
  const connectionLibrary = useConnectionLibrary();
  const [telnetDialog, setTelnetDialog] = useState<{
    open: boolean;
    session?: SavedTelnetSession;
  }>({ open: false });
  const [serialDialog, setSerialDialog] = useState<{
    open: boolean;
    session?: SavedSerialSession;
  }>({ open: false });
  const [folderDialog, setFolderDialog] = useState<{
    open: boolean;
    folder?: ConnectionFolder;
  }>({ open: false });
  const activePanel = panelCopy[activity];
  const closeTelnetDialog = useCallback(() => setTelnetDialog({ open: false }), []);
  const closeSerialDialog = useCallback(() => setSerialDialog({ open: false }), []);
  const openSavedConnection = (session: SavedConnectionSession) => {
    if (session.kind === "telnet") workspaceTabs.openTelnet(session);
    else workspaceTabs.openSerial(session);
  };
  const editSavedConnection = (session: SavedConnectionSession) => {
    if (session.kind === "telnet") setTelnetDialog({ open: true, session });
    else setSerialDialog({ open: true, session });
  };

  const leftResize = usePanelResize({
    currentWidth: preferences.leftSidebarWidth,
    direction: "left",
    minimum: 220,
    maximum: 420,
    onResize: preferences.setLeftSidebarWidth,
  });

  const rightResize = usePanelResize({
    currentWidth: preferences.rightSidebarWidth,
    direction: "right",
    minimum: 280,
    maximum: 520,
    onResize: preferences.setRightSidebarWidth,
  });

  const layoutStyle = {
    "--left-sidebar-width": `${preferences.leftSidebarWidth}px`,
    "--right-sidebar-width": `${preferences.rightSidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className="workbench" style={layoutStyle}>
      <header className="titlebar">
        <div className="brand" aria-label="NeTerminAI">
          <img className="brand-mark" src="/brand/neterminai-logo.png" alt="" />
          <span className="brand-name">NeTerminAI</span>
        </div>

        <div className="titlebar-center">终端工作台</div>

        <div className="titlebar-actions">
          <IconButton
            label={preferences.leftSidebarOpen ? "收起左侧栏" : "展开左侧栏"}
            onClick={preferences.toggleLeftSidebar}
          >
            <SidebarIcon />
          </IconButton>
          <IconButton
            label={settings.appearance.theme === "dark" ? "切换到明亮主题" : "切换到暗色主题"}
            onClick={() => settings.updateAppearance({ theme: settings.appearance.theme === "dark" ? "light" : "dark" })}
          >
            {settings.appearance.theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton
            label={preferences.rightSidebarOpen ? "收起 AI 侧栏" : "展开 AI 侧栏"}
            onClick={preferences.toggleRightSidebar}
          >
            <AssistantIcon />
          </IconButton>
        </div>
      </header>

      <div className="workbench-body">
        <nav className="activity-bar" aria-label="主要功能">
          <div className="activity-list">
            {activities.map((item) => (
              <button
                className="activity-button"
                data-active={activity === item.id}
                key={item.id}
                onClick={() => {
                  setActivity(item.id);
                  if (!preferences.leftSidebarOpen) preferences.toggleLeftSidebar();
                }}
                title={item.label}
                type="button"
              >
                {item.icon}
                <span className="sr-only">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="activity-footer">
            <button
              className="activity-button"
              data-active={workspaceTabs.tabs.some(
                (tab) => tab.id === workspaceTabs.activeTabId && tab.kind === "settings",
              )}
              onClick={() => workspaceTabs.openSettings("terminal")}
              title="设置"
              type="button"
            >
              <SettingsIcon />
              <span className="sr-only">设置</span>
            </button>
          </div>
        </nav>

        {preferences.leftSidebarOpen && (
          <>
            <aside className="sidebar sidebar-left">
              <PanelHeader title={activePanel.title} />
              <div className="activity-panel-content" key={activity}>
                {activity === "connections" ? (
                  <ConnectionsSidebar
                    folders={connectionLibrary.folders}
                    sessions={connectionLibrary.sessions}
                    onConnect={openSavedConnection}
                    onCreateFolder={() => setFolderDialog({ open: true })}
                    onCreateLocal={workspaceTabs.createTerminal}
                    onCreateTelnet={() => setTelnetDialog({ open: true })}
                    onCreateSerial={() => setSerialDialog({ open: true })}
                    onEdit={editSavedConnection}
                    onRemoveFolder={connectionLibrary.removeFolder}
                    onRemoveSession={connectionLibrary.removeSession}
                    onRenameFolder={(folder) => setFolderDialog({ open: true, folder })}
                  />
                ) : (
                  <EmptyPanel description={activePanel.description} />
                )}
              </div>
            </aside>
            <div
              aria-label="调整左侧栏宽度"
              aria-orientation="vertical"
              aria-valuemax={420}
              aria-valuemin={220}
              aria-valuenow={Math.round(preferences.leftSidebarWidth)}
              className="resize-handle resize-handle-left"
              onDoubleClick={() => preferences.setLeftSidebarWidth(260)}
              role="separator"
              tabIndex={0}
              {...leftResize}
            />
          </>
        )}

        <main className="main-area">
          <WorkspaceTabs
            activeTabId={workspaceTabs.activeTabId}
            onActivate={workspaceTabs.activateTab}
            onClose={workspaceTabs.closeTab}
            onCreateTerminal={workspaceTabs.createTerminal}
            onCreateTelnet={() => setTelnetDialog({ open: true })}
            onCreateSerial={() => setSerialDialog({ open: true })}
            tabs={workspaceTabs.tabs}
          />

          <div className="workspace-content">
            {workspaceTabs.tabs.map((tab) =>
              tab.kind === "localTerminal" ? (
                <TerminalPane
                  active={tab.id === workspaceTabs.activeTabId}
                  key={tab.id}
                  profileId={tab.profileId}
                  sessionType="local"
                  settings={settings.terminal}
                  theme={settings.appearance.theme}
                />
              ) : tab.kind === "telnet" ? (
                <TerminalPane
                  active={tab.id === workspaceTabs.activeTabId}
                  connection={tab.connection}
                  key={tab.id}
                  sessionType="telnet"
                  settings={settings.terminal}
                  theme={settings.appearance.theme}
                />
              ) : tab.kind === "serial" ? (
                <TerminalPane
                  active={tab.id === workspaceTabs.activeTabId}
                  connection={tab.connection}
                  key={tab.id}
                  sessionType="serial"
                  settings={settings.terminal}
                  theme={settings.appearance.theme}
                />
              ) : (
                <TerminalSettingsView
                  active={tab.id === workspaceTabs.activeTabId}
                  appearanceTheme={settings.appearance.theme}
                  key={tab.id}
                  onChange={settings.updateTerminal}
                  onReset={settings.resetTerminal}
                  settings={settings.terminal}
                />
              ),
            )}

            {workspaceTabs.tabs.length === 0 && (
              <section className="empty-workspace">
                <img className="welcome-mark" src="/brand/neterminai-logo.png" alt="" />
                <h1>打开一个新标签</h1>
                <p>创建本地终端，之后也可以在这里打开远程连接与工具。</p>
                <button
                  className="primary-button"
                  onClick={() => workspaceTabs.createTerminal("powershell")}
                  type="button"
                >
                  新建 PowerShell
                </button>
              </section>
            )}
          </div>
        </main>

        {preferences.rightSidebarOpen && (
          <>
            <div
              aria-label="调整 AI 侧栏宽度"
              aria-orientation="vertical"
              aria-valuemax={520}
              aria-valuemin={280}
              aria-valuenow={Math.round(preferences.rightSidebarWidth)}
              className="resize-handle resize-handle-right"
              onDoubleClick={() => preferences.setRightSidebarWidth(320)}
              role="separator"
              tabIndex={0}
              {...rightResize}
            />
            <aside className="sidebar sidebar-right">
              <PanelHeader title="AI 助手" icon={<AssistantIcon />} />
              <div className="assistant-empty">
                <div className="assistant-orb" aria-hidden="true">
                  <AssistantIcon />
                </div>
                <h2>专注于当前工作</h2>
                <p>终端能力稳定后，AI 将在这里理解上下文并协助执行任务。</p>
              </div>
            </aside>
          </>
        )}
      </div>

      <footer className="statusbar">
        <span className="status-ready"><i /> 就绪</span>
        <span className="status-spacer" />
        <span>本地工作区</span>
        <span>UTF-8</span>
      </footer>

      {telnetDialog.open && (
        <TelnetConnectionDialog
          folders={connectionLibrary.folders}
          initialSession={telnetDialog.session}
          onCancel={closeTelnetDialog}
          onSubmit={(connection, save, savesPassword, folderId) => {
            if (save) {
              connectionLibrary.saveTelnet(connection, savesPassword, folderId, telnetDialog.session?.id);
            }
            if (!telnetDialog.session) workspaceTabs.openTelnet(connection);
            closeTelnetDialog();
          }}
        />
      )}
      {serialDialog.open && (
        <SerialConnectionDialog
          folders={connectionLibrary.folders}
          initialSession={serialDialog.session}
          onCancel={closeSerialDialog}
          onSubmit={(connection, save, folderId) => {
            if (save) connectionLibrary.saveSerial(connection, folderId, serialDialog.session?.id);
            if (!serialDialog.session) workspaceTabs.openSerial(connection);
            closeSerialDialog();
          }}
        />
      )}
      {folderDialog.open && (
        <SessionFolderDialog
          folder={folderDialog.folder}
          onCancel={() => setFolderDialog({ open: false })}
          onSave={(name) => {
            if (folderDialog.folder) connectionLibrary.renameFolder(folderDialog.folder.id, name);
            else connectionLibrary.createFolder(name);
            setFolderDialog({ open: false });
          }}
        />
      )}
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="icon-button" onClick={onClick} title={label} type="button">
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function PanelHeader({ title, icon }: { title: string; icon?: ReactNode }) {
  return (
    <header className="panel-header">
      <div className="panel-title">
        {icon}
        <span>{title}</span>
      </div>
      <button className="more-button" aria-label={`${title}更多操作`} type="button">
        <span />
        <span />
        <span />
      </button>
    </header>
  );
}

function EmptyPanel({ description }: { description: string }) {
  return (
    <div className="empty-panel">
      <div className="empty-line short" />
      <div className="empty-line" />
      <p>{description}</p>
    </div>
  );
}
