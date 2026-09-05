import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { useTerminalSessionRegistry } from "../terminal/TerminalSessionRegistry";
import { RdpPane } from "../rdp/RdpPane";
import { useRdpSessionRegistry } from "../rdp/RdpSessionRegistry";
import { WorkspaceArea } from "../workspace/WorkspaceArea";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";
import type { WorkspaceTab } from "../workspace/types";
import { SettingsPage } from "../settings/SettingsPage";
import { SettingsSidebar } from "../settings/SettingsSidebar";
import type { SettingsSection } from "../settings/types";
import { resolveKeyboardShortcut } from "../settings/keybindings";
import { TelnetConnectionDialog } from "../telnet/TelnetConnectionDialog";
import { SessionFolderDialog } from "../connections/SessionFolderDialog";
import { ConnectionsSidebar } from "../connections/ConnectionsSidebar";
import { SerialConnectionDialog } from "../serial/SerialConnectionDialog";
import { SshConnectionDialog } from "../ssh/SshConnectionDialog";
import { RdpConnectionDialog } from "../rdp/RdpConnectionDialog";
import type { ConnectionFolder, SavedConnectionSession, SavedRdpSession, SavedSerialSession, SavedSshSession, SavedTelnetSession } from "../connections/types";
import { useConnectionLibrary } from "../connections/useConnectionLibrary";
import { collectVisibleTabIds } from "../workspace/layout";
import { useSynchronizedInput } from "../terminal/useSynchronizedInput";
import { systemApi } from "../ipc/system";
import {
  TerminalContextScope,
  AiContextSelector,
  useAiContextSelection,
} from "../ai/context";
import { TerminalCapabilityAdapter, type TerminalCapabilityWorkspace } from "../capabilities/terminalAdapter";
import type { ProjectContextCapability } from "../capabilities/project";
import { AiAssistant, createAiProvider } from "../ai/runtime";
import { AiAssistantPanel } from "../ai/runtime/AiAssistantPanel";
import {
  ProjectSidebar,
  projectSessionsFromTabs,
  resolveProjectTabs,
  restoreProjectWorkspace,
  useProjects,
  type Project,
} from "../projects";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("terminal");
  const [tabDragging, setTabDragging] = useState(false);
  const [runtimeApiKey, setRuntimeApiKey] = useState("");
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const statusNoticeTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const connectionLibrary = useConnectionLibrary();
  const projectManager = useProjects();
  const initialProjectState = useMemo(() => {
    const tabs = resolveProjectTabs(projectManager.activeProject, connectionLibrary.sessions);
    return restoreProjectWorkspace(projectManager.activeProject, tabs);
  }, [connectionLibrary.sessions, projectManager.activeProject]);
  const workspaceTabs = useWorkspaceTabs(projectManager.activeProjectId, initialProjectState);
  const openTabIds = useMemo(() => workspaceTabs.tabs.map((tab) => tab.id), [workspaceTabs.tabs]);
  const runtimeRegistry = useTerminalSessionRegistry(openTabIds);
  const rdpRegistry = useRdpSessionRegistry(openTabIds);
  const activeProjectIdRef = useRef(projectManager.activeProjectId);
  activeProjectIdRef.current = projectManager.activeProjectId;
  const projectContextRef = useRef(projectManager.activeProject.context);
  projectContextRef.current = projectManager.activeProject.context;
  const workspaceContextRef = useRef<TerminalCapabilityWorkspace>({
    tabs: workspaceTabs.tabs,
    layout: workspaceTabs.layout,
    activePaneId: workspaceTabs.activePaneId,
    activeTabId: workspaceTabs.activeTabId,
    projectId: projectManager.activeProjectId,
  });
  workspaceContextRef.current = {
    tabs: workspaceTabs.tabs,
    layout: workspaceTabs.layout,
    activePaneId: workspaceTabs.activePaneId,
    activeTabId: workspaceTabs.activeTabId,
    projectId: projectManager.activeProjectId,
  };
  const terminalCapability = useMemo(
    () => new TerminalCapabilityAdapter(runtimeRegistry, () => workspaceContextRef.current),
    [runtimeRegistry],
  );
  const projectContextCapability = useMemo<ProjectContextCapability>(() => ({
    get: () => projectContextRef.current,
    update: (patch) => projectManager.updateContext(activeProjectIdRef.current, patch),
  }), [projectManager.updateContext]);
  const aiAssistant = useMemo(
    () => new AiAssistant(createAiProvider(settings.ai, runtimeApiKey), terminalCapability, terminalCapability, {
      projectContext: projectContextCapability,
      enabled: settings.ai.enabled,
    }),
    [projectContextCapability, terminalCapability],
  );
  useEffect(() => {
    aiAssistant.setProvider(createAiProvider(settings.ai, runtimeApiKey));
    aiAssistant.setEnabled(settings.ai.enabled);
  }, [aiAssistant, runtimeApiKey, settings.ai]);
  const [telnetDialog, setTelnetDialog] = useState<{
    open: boolean;
    session?: SavedTelnetSession;
  }>({ open: false });
  const [serialDialog, setSerialDialog] = useState<{
    open: boolean;
    session?: SavedSerialSession;
  }>({ open: false });
  const [sshDialog, setSshDialog] = useState<{
    open: boolean;
    session?: SavedSshSession;
  }>({ open: false });
  const [rdpDialog, setRdpDialog] = useState<{
    open: boolean;
    session?: SavedRdpSession;
  }>({ open: false });
  const [folderDialog, setFolderDialog] = useState<{
    open: boolean;
    folder?: ConnectionFolder;
  }>({ open: false });
  const dialogOpen = telnetDialog.open || serialDialog.open || sshDialog.open || rdpDialog.open || folderDialog.open;
  const visibleTabIds = useMemo(
    () => collectVisibleTabIds(workspaceTabs.layout),
    [workspaceTabs.layout],
  );
  const projectTabIds = useMemo(
    () => workspaceTabs.tabs
      .filter((tab) => tab.projectId === projectManager.activeProjectId && isCharacterTerminal(tab))
      .map((tab) => tab.id),
    [projectManager.activeProjectId, workspaceTabs.tabs],
  );
  const aiVisibleTabIds = useMemo(
    () => visibleTabIds.filter((tabId) => projectTabIds.includes(tabId)),
    [projectTabIds, visibleTabIds],
  );
  const aiContextSelection = useAiContextSelection(
    projectTabIds,
    workspaceTabs.activeTabId,
    aiVisibleTabIds,
    projectManager.activeProject.runtime.aiContextSelection,
    projectManager.activeProjectId,
  );
  const currentProjectWorkspace = useMemo(() => ({
    sessions: projectSessionsFromTabs(workspaceTabs.tabs, projectManager.activeProjectId),
    layout: workspaceTabs.layout,
    activePaneId: workspaceTabs.activePaneId,
    activeTabId: workspaceTabs.activeTabId,
  }), [projectManager.activeProjectId, workspaceTabs.activePaneId, workspaceTabs.activeTabId, workspaceTabs.layout, workspaceTabs.tabs]);
  useEffect(() => {
    if (workspaceTabs.projectId !== projectManager.activeProjectId) return;
    projectManager.updateWorkspace(projectManager.activeProjectId, currentProjectWorkspace);
  }, [currentProjectWorkspace, projectManager.activeProjectId, projectManager.updateWorkspace, workspaceTabs.projectId]);
  useEffect(() => {
    if (workspaceTabs.projectId !== projectManager.activeProjectId) return;
    projectManager.updateRuntime(projectManager.activeProjectId, {
      activeTabId: workspaceTabs.activeTabId,
      aiContextSelection: aiContextSelection.selection,
    });
  }, [aiContextSelection.selection, projectManager.activeProjectId, projectManager.updateRuntime, workspaceTabs.activeTabId, workspaceTabs.projectId]);
  const visibleTerminalIds = useMemo(() => {
    const terminalIds = new Set(
      workspaceTabs.tabs.filter(isCharacterTerminal).map((tab) => tab.id),
    );
    return visibleTabIds.filter((tabId) => terminalIds.has(tabId));
  }, [visibleTabIds, workspaceTabs.tabs]);
  const synchronizedInput = useSynchronizedInput(visibleTerminalIds);
  const synchronizedTabIds = useMemo(
    () => new Set(synchronizedInput.enabled ? visibleTerminalIds : []),
    [synchronizedInput.enabled, visibleTerminalIds],
  );
  const activeTerminalId = workspaceTabs.activeTabId
    && workspaceTabs.tabs.some((tab) => tab.id === workspaceTabs.activeTabId && isCharacterTerminal(tab))
    ? workspaceTabs.activeTabId
    : null;
  const activeTerminalIdRef = useRef<string | null>(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;

  // All activation paths (mouse, Ctrl+Tab, pane selection and programmatic
  // changes) converge here after React has committed the new active tab. The
  // runtime registry then focuses the actual terminal view, including native
  // RDP, instead of relying on the WebView's stale focus target.
  useEffect(() => {
    if (settingsOpen || !workspaceTabs.activeTabId) return;
    const tabId = workspaceTabs.activeTabId;
    const frame = requestAnimationFrame(() => {
      const tab = workspaceTabs.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (tab.kind === "rdp") rdpRegistry.focus(tabId);
      else if (isCharacterTerminal(tab)) runtimeRegistry.focus(tabId);
    });
    return () => cancelAnimationFrame(frame);
  }, [rdpRegistry, runtimeRegistry, settingsOpen, workspaceTabs.activeTabId, workspaceTabs.tabs]);

  useEffect(() => {
    aiAssistant.resetConversation();
  }, [aiAssistant, projectManager.activeProjectId]);

  const activePanel = panelCopy[activity];
  const closeTelnetDialog = useCallback(() => setTelnetDialog({ open: false }), []);
  const closeSerialDialog = useCallback(() => setSerialDialog({ open: false }), []);
  const closeSshDialog = useCallback(() => setSshDialog({ open: false }), []);
  const closeRdpDialog = useCallback(() => setRdpDialog({ open: false }), []);
  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
    if (!preferences.leftSidebarOpen) preferences.toggleLeftSidebar();
  }, [preferences.leftSidebarOpen, preferences.toggleLeftSidebar]);

  const showStatusNotice = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setStatusNotice(message);
    if (statusNoticeTimerRef.current !== undefined) {
      window.clearTimeout(statusNoticeTimerRef.current);
    }
    statusNoticeTimerRef.current = window.setTimeout(() => {
      statusNoticeTimerRef.current = undefined;
      setStatusNotice(null);
    }, 3_000);
  }, []);

  const insertLocalIpv4 = useCallback((targetTabId: string | null) => {
    if (!targetTabId) return;
    void systemApi.getLocalIpv4()
      .then((address) => {
        if (activeTerminalIdRef.current !== targetTabId) return;
        if (!address) {
          showStatusNotice("未找到可用的本机 IPv4 地址");
          return;
        }
        synchronizedInput.routeInput(targetTabId, address);
      })
      .catch(() => {
        if (activeTerminalIdRef.current === targetTabId) {
          showStatusNotice("无法读取本机 IPv4 地址");
        }
      });
  }, [showStatusNotice, synchronizedInput.routeInput]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (statusNoticeTimerRef.current !== undefined) {
        window.clearTimeout(statusNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (dialogOpen || target?.closest("[data-keybinding-recorder]")) return;
      const editable = target?.closest("input, textarea, select, [contenteditable='true']");
      if (editable && !target?.closest(".xterm")) return;

      // Settings owns its own page and keyboard navigation. Workspace commands
      // must not mutate the hidden session layout while the user is editing it.
      if (settingsOpen) return;

      const command = resolveKeyboardShortcut(event, settings.keybindings);
      if (!command) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (command.id === "synchronizeVisibleTerminals") {
        synchronizedInput.enable();
      } else if (command.id === "stopSynchronizedInput") {
        synchronizedInput.disable();
        synchronizedInput.focus(activeTerminalId);
      } else if (command.id === "insertLocalIpv4") {
        insertLocalIpv4(activeTerminalId);
      } else if (command.id === "balanceWorkspace") {
        workspaceTabs.balanceWorkspace();
      } else if (command.id === "collapseWorkspace") {
        workspaceTabs.collapseWorkspace();
      } else {
        workspaceTabs.activateNextSession();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    activeTerminalId,
    dialogOpen,
    settingsOpen,
    settings.keybindings,
    synchronizedInput.disable,
    synchronizedInput.enable,
    synchronizedInput.focus,
    insertLocalIpv4,
    workspaceTabs.activateNextSession,
    workspaceTabs.balanceWorkspace,
    workspaceTabs.collapseWorkspace,
  ]);
  const openSavedConnection = (session: SavedConnectionSession) => {
    if (session.kind === "telnet") workspaceTabs.openTelnet(session, session.id);
    else if (session.kind === "serial") workspaceTabs.openSerial(session, session.id);
    else if (session.kind === "ssh") workspaceTabs.openSsh(session, session.id);
    else workspaceTabs.openRdp(session, session.id);
  };
  const editSavedConnection = (session: SavedConnectionSession) => {
    if (session.kind === "telnet") setTelnetDialog({ open: true, session });
    else if (session.kind === "serial") setSerialDialog({ open: true, session });
    else if (session.kind === "ssh") setSshDialog({ open: true, session });
    else setRdpDialog({ open: true, session });
  };

  const switchProject = useCallback((project: Project) => {
    if (project.id === projectManager.activeProjectId) return;
    // Invalidate any in-flight analysis before changing the context source so
    // a late provider response cannot update the project being left.
    aiAssistant.resetConversation();
    const currentSnapshot = workspaceTabs.captureProjectState();
    projectManager.updateWorkspace(projectManager.activeProjectId, {
      sessions: projectSessionsFromTabs(currentSnapshot.tabs, projectManager.activeProjectId),
      layout: currentSnapshot.layout,
      activePaneId: currentSnapshot.activePaneId,
      activeTabId: workspaceTabs.activeTabId,
    });
    projectManager.updateRuntime(projectManager.activeProjectId, {
      activeTabId: workspaceTabs.activeTabId,
      aiContextSelection: aiContextSelection.selection,
    });
    const targetTabs = resolveProjectTabs(project, connectionLibrary.sessions, workspaceTabs.tabs);
    workspaceTabs.switchProject(project.id, restoreProjectWorkspace(project, targetTabs));
    projectManager.activateProject(project.id);
  }, [aiAssistant, aiContextSelection.selection, connectionLibrary.sessions, projectManager, workspaceTabs]);

  const createProject = useCallback((name: string) => {
    const project = projectManager.createProject(name);
    switchProject(project);
  }, [projectManager, switchProject]);

  const getLeftSidebarMaximum = () =>
    Math.max(
      180,
      window.innerWidth -
        48 -
        (preferences.rightSidebarOpen ? preferences.rightSidebarWidth + 1 : 0) -
        360 -
        1,
    );
  const getRightSidebarMaximum = () =>
    Math.max(
      240,
      window.innerWidth -
        48 -
        (preferences.leftSidebarOpen ? preferences.leftSidebarWidth + 1 : 0) -
        360 -
        1,
    );

  const leftResize = usePanelResize({
    currentWidth: preferences.leftSidebarWidth,
    cssVariable: "--left-sidebar-width",
    direction: "left",
    minimum: 180,
    maximum: getLeftSidebarMaximum,
    onResize: preferences.setLeftSidebarWidth,
  });

  const rightResize = usePanelResize({
    currentWidth: preferences.rightSidebarWidth,
    cssVariable: "--right-sidebar-width",
    direction: "right",
    minimum: 240,
    maximum: getRightSidebarMaximum,
    onResize: preferences.setRightSidebarWidth,
  });

  const layoutStyle = {
    "--left-sidebar-width": `${preferences.leftSidebarWidth}px`,
    "--right-sidebar-width": `${preferences.rightSidebarWidth}px`,
  } as CSSProperties;

  const renderWorkspaceTab = (tab: WorkspaceTab, active: boolean, paneId: string) => {
    if (tab.kind === "localTerminal") {
      return (
        <TerminalPane
          active={active && !settingsOpen}
          connectionId={tab.id}
          paneId={paneId}
          key={tab.id}
          onActivate={() => workspaceTabs.activatePane(paneId)}
          onInput={synchronizedInput.routeInput}
          profileId={tab.profileId}
          registerInputTarget={synchronizedInput.registerTarget}
          sessionType="local"
          settings={settings.terminal}
          synchronizedInput={synchronizedTabIds.has(tab.id)}
          tabId={tab.id}
          theme={settings.appearance.theme}
          runtimeRegistry={runtimeRegistry}
        />
      );
    }
    if (tab.kind === "telnet") {
      return (
        <TerminalPane
          active={active && !settingsOpen}
          connectionId={tab.id}
          paneId={paneId}
          connection={tab.connection}
          key={tab.id}
          onActivate={() => workspaceTabs.activatePane(paneId)}
          onInput={synchronizedInput.routeInput}
          registerInputTarget={synchronizedInput.registerTarget}
          sessionType="telnet"
          settings={settings.terminal}
          synchronizedInput={synchronizedTabIds.has(tab.id)}
          tabId={tab.id}
          theme={settings.appearance.theme}
          runtimeRegistry={runtimeRegistry}
        />
      );
    }
    if (tab.kind === "serial") {
      return (
        <TerminalPane
          active={active && !settingsOpen}
          connectionId={tab.id}
          paneId={paneId}
          connection={tab.connection}
          key={tab.id}
          onActivate={() => workspaceTabs.activatePane(paneId)}
          onInput={synchronizedInput.routeInput}
          registerInputTarget={synchronizedInput.registerTarget}
          sessionType="serial"
          settings={settings.terminal}
          synchronizedInput={synchronizedTabIds.has(tab.id)}
          tabId={tab.id}
          theme={settings.appearance.theme}
          runtimeRegistry={runtimeRegistry}
        />
      );
    }
    if (tab.kind === "ssh") {
      return (
        <TerminalPane
          active={active && !settingsOpen}
          connectionId={tab.id}
          paneId={paneId}
          connection={tab.connection}
          key={tab.id}
          onActivate={() => workspaceTabs.activatePane(paneId)}
          onInput={synchronizedInput.routeInput}
          registerInputTarget={synchronizedInput.registerTarget}
          sessionType="ssh"
          settings={settings.terminal}
          synchronizedInput={synchronizedTabIds.has(tab.id)}
          tabId={tab.id}
          theme={settings.appearance.theme}
          runtimeRegistry={runtimeRegistry}
        />
      );
    }
    if (tab.kind === "rdp") {
      return (
        <RdpPane
          active={active && !settingsOpen && !tabDragging}
          connection={tab.connection}
          key={tab.id}
          onActivate={() => workspaceTabs.activatePane(paneId)}
          paneActive={workspaceTabs.activePaneId === paneId}
          paneId={paneId}
          registry={rdpRegistry}
          tabId={tab.id}
        />
      );
    }
    return null;
  };

  return (
    <TerminalContextScope provider={terminalCapability}>
      <div className="workbench" style={layoutStyle}>
      <header className="titlebar" data-tauri-drag-region="deep">
        <div className="brand" aria-label="NeTerminAI">
          <img className="brand-mark" src="/brand/neterminai-logo.png" alt="" />
          <span className="brand-name">NeTerminAI</span>
        </div>

        <div className="titlebar-center">终端工作台</div>

        <div className="titlebar-actions" data-tauri-drag-region="false">
          <IconButton
            dataTitlebarControl
            label={preferences.leftSidebarOpen ? "收起左侧栏" : "展开左侧栏"}
            onClick={preferences.toggleLeftSidebar}
          >
            <SidebarIcon />
          </IconButton>
          <IconButton
            dataTitlebarControl
            label={settings.appearance.theme === "dark" ? "切换到明亮主题" : "切换到暗色主题"}
            onClick={() => settings.updateAppearance({ theme: settings.appearance.theme === "dark" ? "light" : "dark" })}
          >
            {settings.appearance.theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton
            dataTitlebarControl
            label={preferences.rightSidebarOpen ? "收起 AI 侧栏" : "展开 AI 侧栏"}
            onClick={preferences.toggleRightSidebar}
          >
            <AssistantIcon />
          </IconButton>
        </div>
        <WindowControls />
      </header>

      <div className="workbench-body">
        <nav className="activity-bar" aria-label="主要功能">
          <div className="activity-list">
            {activities.map((item) => (
              <button
                className="activity-button"
                data-active={!settingsOpen && activity === item.id}
                key={item.id}
                onClick={() => {
                  if (!settingsOpen && activity === item.id) {
                    preferences.toggleLeftSidebar();
                    return;
                  }
                  setSettingsOpen(false);
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
              data-active={settingsOpen}
              onClick={() => {
                if (settingsOpen) {
                  preferences.toggleLeftSidebar();
                  return;
                }
                openSettings(settingsSection);
              }}
              title="设置"
              type="button"
            >
              <SettingsIcon />
              <span className="sr-only">设置</span>
            </button>
          </div>
        </nav>

        <>
          <aside
            aria-hidden={!preferences.leftSidebarOpen}
            className="sidebar sidebar-left"
            data-collapsed={!preferences.leftSidebarOpen}
          >
            <PanelHeader title={settingsOpen ? "设置" : activePanel.title} />
            <div className="activity-panel-content" key={settingsOpen ? "settings" : activity}>
              {settingsOpen ? (
                <SettingsSidebar section={settingsSection} onSelect={setSettingsSection} />
              ) : activity === "connections" ? (
                <ConnectionsSidebar
                  folders={connectionLibrary.folders}
                  sessions={connectionLibrary.sessions}
                  onConnect={openSavedConnection}
                  onCreateFolder={() => setFolderDialog({ open: true })}
                  onCreateLocal={workspaceTabs.createTerminal}
                  onCreateTelnet={() => setTelnetDialog({ open: true })}
                  onCreateSerial={() => setSerialDialog({ open: true })}
                  onCreateSsh={() => setSshDialog({ open: true })}
                  onCreateRdp={() => setRdpDialog({ open: true })}
                  onEdit={editSavedConnection}
                  onRemoveFolder={connectionLibrary.removeFolder}
                  onRemoveSession={connectionLibrary.removeSession}
                  onRenameFolder={(folder) => setFolderDialog({ open: true, folder })}
                />
              ) : activity === "workspace" ? (
                <ProjectSidebar
                  activeProjectId={projectManager.activeProjectId}
                  connections={connectionLibrary.sessions}
                  onActivateProject={(projectId) => {
                    const target = projectManager.projects.find((project) => project.id === projectId);
                    if (target) switchProject(target);
                  }}
                  onAddDevice={projectManager.addDevice}
                  onCreateProject={createProject}
                  onRemoveDevice={projectManager.removeDevice}
                  onUpdateContext={projectManager.updateContext}
                  projects={projectManager.projects}
                />
              ) : (
                <EmptyPanel description={activePanel.description} />
              )}
            </div>
          </aside>
          <div
            aria-hidden={!preferences.leftSidebarOpen}
            aria-label="调整左侧栏宽度"
            aria-orientation="vertical"
            aria-valuemax={getLeftSidebarMaximum()}
            aria-valuemin={180}
            aria-valuenow={Math.round(preferences.leftSidebarWidth)}
            className="resize-handle resize-handle-left"
            data-collapsed={!preferences.leftSidebarOpen}
            onDoubleClick={() => preferences.setLeftSidebarWidth(260)}
            role="separator"
            tabIndex={preferences.leftSidebarOpen ? 0 : -1}
            {...leftResize}
          />
        </>

        <main className="main-area" data-settings-open={settingsOpen}>
          <div className="workspace-session-layer" data-visible={!settingsOpen}>
            <WorkspaceArea
              activePaneId={workspaceTabs.activePaneId}
              layout={workspaceTabs.layout}
              onActivatePane={workspaceTabs.activatePane}
              onActivateTab={workspaceTabs.activateTab}
              onCloseTab={workspaceTabs.closeTab}
              onClosePane={workspaceTabs.closePane}
              onMoveTab={workspaceTabs.moveTab}
              onResizeSplit={workspaceTabs.resizeSplit}
              onDraggingChange={setTabDragging}
              renderTab={renderWorkspaceTab}
              synchronizedTabIds={synchronizedTabIds}
              tabs={workspaceTabs.tabs}
            />
          </div>
          {settingsOpen && (
            <SettingsPage
              appearanceTheme={settings.appearance.theme}
              keybindings={settings.keybindings}
              onChangeKeybindings={settings.updateKeybindings}
              onChangeTerminal={settings.updateTerminal}
              onResetKeybindings={settings.resetKeybindings}
              onResetTerminal={settings.resetTerminal}
              ai={settings.ai}
              onChangeAi={settings.updateAi}
              onResetAi={settings.resetAi}
              section={settingsSection}
              terminal={settings.terminal}
            />
          )}
        </main>

        {preferences.rightSidebarOpen && (
          <>
            <div
              aria-label="调整 AI 侧栏宽度"
              aria-orientation="vertical"
              aria-valuemax={getRightSidebarMaximum()}
              aria-valuemin={240}
              aria-valuenow={Math.round(preferences.rightSidebarWidth)}
              className="resize-handle resize-handle-right"
              onDoubleClick={() => preferences.setRightSidebarWidth(320)}
              role="separator"
              tabIndex={0}
              {...rightResize}
            />
            <aside className="sidebar sidebar-right">
              <PanelHeader title="AI 助手" icon={<AssistantIcon />} />
              <AiContextSelector
                activeTabId={workspaceTabs.activeTabId}
                onClear={aiContextSelection.clear}
                onSelectActive={aiContextSelection.selectActive}
                onSelectAll={aiContextSelection.selectAll}
                onSelectVisible={aiContextSelection.selectVisible}
                onToggle={aiContextSelection.toggle}
                provider={terminalCapability}
                selection={aiContextSelection.selection}
                visibleTabIds={aiVisibleTabIds}
              />
              <AiAssistantPanel
                apiKey={runtimeApiKey}
                assistant={aiAssistant}
                contextCount={terminalCapability.getContexts(aiContextSelection.selection).length}
                onApiKeyChange={setRuntimeApiKey}
                providerMode={settings.ai.providerMode}
                providerPreset={settings.ai.providerPreset}
                enabled={settings.ai.enabled}
                selection={aiContextSelection.selection}
              />
            </aside>
          </>
        )}
      </div>

      <footer className="statusbar">
        <span className="status-ready"><i /> 就绪</span>
        {synchronizedInput.enabled && (
          <button
            className="status-sync-input"
            onClick={() => {
              synchronizedInput.disable();
              synchronizedInput.focus(activeTerminalId);
            }}
            title="点击关闭同步输入"
            type="button"
          >
            <i /> 同步输入 · {visibleTerminalIds.length} 个终端
          </button>
        )}
        {statusNotice && <span aria-live="polite" className="status-notice" role="status">{statusNotice}</span>}
        <span className="status-spacer" />
        <span>本地工作区</span>
        <span>UTF-8</span>
      </footer>

      {telnetDialog.open && (
        <TelnetConnectionDialog
          folders={connectionLibrary.folders}
          initialSession={telnetDialog.session}
          onCancel={closeTelnetDialog}
          onCreateFolder={connectionLibrary.createFolder}
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
          onCreateFolder={connectionLibrary.createFolder}
          onSubmit={(connection, save, folderId) => {
            if (save) connectionLibrary.saveSerial(connection, folderId, serialDialog.session?.id);
            if (!serialDialog.session) workspaceTabs.openSerial(connection);
            closeSerialDialog();
          }}
        />
      )}
      {sshDialog.open && (
        <SshConnectionDialog
          initialSession={sshDialog.session}
          onCancel={closeSshDialog}
          onSubmit={(connection, save) => {
            if (save) connectionLibrary.saveSsh(connection, sshDialog.session?.folderId ?? null, sshDialog.session?.id);
            if (!sshDialog.session) workspaceTabs.openSsh(connection);
            closeSshDialog();
          }}
        />
      )}
      {rdpDialog.open && (
        <RdpConnectionDialog
          folders={connectionLibrary.folders}
          initialSession={rdpDialog.session}
          onCancel={closeRdpDialog}
          onCreateFolder={connectionLibrary.createFolder}
          onSubmit={(connection, save, folderId) => {
            if (save) connectionLibrary.saveRdp(connection, folderId, rdpDialog.session?.id);
            if (!rdpDialog.session) workspaceTabs.openRdp(connection);
            closeRdpDialog();
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
    </TerminalContextScope>
  );
}

function IconButton({
  children,
  dataTitlebarControl = false,
  label,
  onClick,
}: {
  children: ReactNode;
  dataTitlebarControl?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="icon-button" data-titlebar-control={dataTitlebarControl || undefined} onClick={onClick} title={label} type="button">
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const appWindow = useMemo(() => "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null, []);

  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    const sync = async () => {
      try {
        const value = await appWindow.isMaximized();
        if (!disposed) setMaximized(value);
      } catch {
        // The browser preview does not expose a native window; desktop builds do.
      }
    };
    void sync();
    let unlisten: (() => void) | undefined;
    void appWindow.onResized(() => { void sync(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  const toggleMaximize = async () => {
    if (!appWindow) return;
    try {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch (error) {
      reportWindowActionError("toggle maximize", error);
    }
  };

  const runWindowAction = (action: () => Promise<void>, name: string) => {
    void action().catch((error: unknown) => reportWindowActionError(name, error));
  };

  return (
    <div
      className="window-controls"
      data-tauri-drag-region="false"
    >
      <button aria-label="最小化" className="window-control" data-titlebar-control onClick={() => appWindow && runWindowAction(() => appWindow.minimize(), "minimize window")} type="button">
        <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9" /></svg>
      </button>
      <button aria-label={maximized ? "还原" : "最大化"} className="window-control" data-titlebar-control onClick={toggleMaximize} type="button">
        <svg aria-hidden="true" viewBox="0 0 16 16">{maximized ? <path d="M5.5 5.5h6v6h-6zM4.5 10.5h-1v-6h6v1" /> : <rect x="3.5" y="3.5" width="9" height="9" rx="1" />}</svg>
      </button>
      <button aria-label="关闭" className="window-control window-control-close" data-titlebar-control onClick={() => appWindow && runWindowAction(() => appWindow.close(), "close window")} type="button">
        <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
      </button>
    </div>
  );
}

function reportWindowActionError(action: string, error: unknown) {
  if ("__TAURI_INTERNALS__" in window) {
    console.error(`Unable to ${action}`, error);
  }
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

function isCharacterTerminal(tab: WorkspaceTab) {
  return tab.kind === "localTerminal"
    || tab.kind === "telnet"
    || tab.kind === "serial"
    || tab.kind === "ssh";
}
