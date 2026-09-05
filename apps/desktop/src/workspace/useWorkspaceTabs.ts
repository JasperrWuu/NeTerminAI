import { useCallback, useMemo, useState } from "react";
import type { RdpConnection, SerialConnection, SshConnection, TelnetConnection } from "../connections/types";
import { getLocalTerminalProfile } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import {
  findPane,
  findPaneContainingTab,
  firstPane,
  buildBalancedWorkspaceLayout,
  collectTabIds,
  countWorkspacePanes,
  collapseWorkspaceLayout,
  removePane,
  removeTabFromPane,
  replacePane,
  resizeWorkspaceSplit,
  updatePane,
} from "./layout";
import type {
  LocalTerminalTab,
  WorkspaceDropZone,
  WorkspaceLayoutNode,
  WorkspacePaneNode,
  WorkspaceProjectSnapshot,
  WorkspaceTab,
} from "./types";

interface WorkspaceState {
  projectId: string;
  tabs: WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
}

export type InitialWorkspaceState = WorkspaceProjectSnapshot;

function createPane(tabId?: string): WorkspacePaneNode {
  return {
    type: "pane",
    id: crypto.randomUUID(),
    tabIds: tabId ? [tabId] : [],
    activeTabId: tabId ?? null,
  };
}

function createLocalTerminalTab(
  id: string,
  profileId: LocalTerminalProfileId,
  existingTabs: WorkspaceTab[],
  projectId?: string,
): LocalTerminalTab {
  const profile = getLocalTerminalProfile(profileId);
  const profileCount = existingTabs.filter(
    (tab) => tab.kind === "localTerminal" && tab.profileId === profileId,
  ).length;

  return {
    id,
    kind: "localTerminal",
    ...(projectId ? { projectId } : {}),
    profileId,
    title: profileCount === 0 ? profile.name : `${profile.name} ${profileCount + 1}`,
  };
}

export function useWorkspaceTabs(
  initialProjectId = "default",
  initialState?: InitialWorkspaceState,
) {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => {
    if (initialState && initialState.tabs.length > 0) {
      const tabs = initialState.tabs.map((tab) => ({ ...tab, projectId: tab.projectId ?? initialProjectId }));
      const layout = tabs.length > 0 ? initialState.layout : createPane();
      const activePaneId = findPane(layout, initialState.activePaneId)?.id ?? firstPane(layout).id;
      return { projectId: initialProjectId, tabs, layout, activePaneId };
    }
    const initialTab = createLocalTerminalTab(crypto.randomUUID(), "powershell", [], initialProjectId);
    const initialPane = createPane(initialTab.id);
    return { projectId: initialProjectId, tabs: [initialTab], layout: initialPane, activePaneId: initialPane.id };
  });

  const addTab = useCallback((create: (tabs: WorkspaceTab[]) => WorkspaceTab) => {
    setWorkspace((current) => {
      const tab = { ...create(current.tabs), projectId: current.projectId };
      const paneId = findPane(current.layout, current.activePaneId)?.id ?? firstPane(current.layout).id;
      return {
        projectId: current.projectId,
        tabs: [...current.tabs, tab],
        layout: updatePane(current.layout, paneId, (pane) => ({
          ...pane,
          tabIds: [...pane.tabIds, tab.id],
          activeTabId: tab.id,
        })),
        activePaneId: paneId,
      };
    });
  }, []);

  const createTerminal = useCallback((profileId: LocalTerminalProfileId) => {
    const tabId = crypto.randomUUID();
    addTab((tabs) => createLocalTerminalTab(tabId, profileId, tabs));
  }, [addTab]);

  const balanceWorkspace = useCallback(() => {
    setWorkspace((current) => {
      const tabIds = current.tabs.filter((tab) => tab.projectId === current.projectId).map((tab) => tab.id);
      if (tabIds.length <= 1) return current;
      const currentActiveTabId = findPane(current.layout, current.activePaneId)?.activeTabId;
      const activeTabId = currentActiveTabId && tabIds.includes(currentActiveTabId)
        ? currentActiveTabId
        : tabIds[0] ?? null;
      const layout = buildBalancedWorkspaceLayout(tabIds);
      const activePane = activeTabId ? findPaneContainingTab(layout, activeTabId) : firstPane(layout);
      return {
        ...current,
        layout,
        activePaneId: activePane?.id ?? firstPane(layout).id,
      };
    });
  }, []);

  const mergeAllTabGroups = useCallback(() => {
    setWorkspace((current) => {
      const tabIds = current.tabs.filter((tab) => tab.projectId === current.projectId).map((tab) => tab.id);
      const currentActiveTabId = findPane(current.layout, current.activePaneId)?.activeTabId;
      const activeTabId = currentActiveTabId && tabIds.includes(currentActiveTabId)
        ? currentActiveTabId
        : tabIds[0] ?? null;
      const layout = collapseWorkspaceLayout(tabIds, activeTabId);
      return { ...current, layout, activePaneId: layout.id };
    });
  }, []);

  // Keep the existing command-facing name while exposing the clearer layout
  // operation for future Tab Group actions.
  const collapseWorkspace = mergeAllTabGroups;

  const resizeSplit = useCallback((splitId: string, ratio: number) => {
    setWorkspace((current) => ({
      ...current,
      layout: resizeWorkspaceSplit(current.layout, splitId, ratio),
    }));
  }, []);

  const closePane = useCallback((paneId: string) => {
    setWorkspace((current) => {
      if (countWorkspacePanes(current.layout) <= 1 || !findPane(current.layout, paneId)) return current;
      const layout = removePane(current.layout, paneId);
      if (!layout) return current;
      const usedTabIds = new Set(collectTabIds(layout));
      const tabs = current.tabs.filter((tab) => tab.projectId !== current.projectId || usedTabIds.has(tab.id));
      const activePane = findPane(layout, current.activePaneId) ?? firstPane(layout);
      return { ...current, tabs, layout, activePaneId: activePane.id };
    });
  }, []);

  const openTelnet = useCallback((connection: TelnetConnection, connectionId?: string) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "telnet",
    connection,
    ...(connectionId ? { connectionId } : {}),
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  })), [addTab]);

  const openSerial = useCallback((connection: SerialConnection, connectionId?: string) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "serial",
    connection,
    ...(connectionId ? { connectionId } : {}),
    title: connection.name.trim() || connection.portName,
  })), [addTab]);

  const openSsh = useCallback((connection: SshConnection, connectionId?: string) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "ssh",
    connection,
    ...(connectionId ? { connectionId } : {}),
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  })), [addTab]);

  const openRdp = useCallback((connection: RdpConnection, connectionId?: string) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "rdp",
    connection,
    ...(connectionId ? { connectionId } : {}),
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  })), [addTab]);

  const activateTab = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => ({
      ...current,
      layout: updatePane(current.layout, paneId, (pane) => (
        pane.tabIds.includes(tabId) ? { ...pane, activeTabId: tabId } : pane
      )),
      activePaneId: paneId,
    }));
  }, []);

  const activateNextSession = useCallback(() => {
    setWorkspace((current) => {
      const sessions = current.tabs.filter((tab) => tab.projectId === current.projectId);
      if (sessions.length === 0) return current;
      const activePane = findPane(current.layout, current.activePaneId) ?? firstPane(current.layout);
      const activeIndex = sessions.findIndex((tab) => tab.id === activePane.activeTabId);
      const next = sessions[(activeIndex >= 0 ? activeIndex + 1 : 0) % sessions.length];
      const nextPane = findPaneContainingTab(current.layout, next.id);
      if (!nextPane) return current;
      return {
        ...current,
        layout: updatePane(current.layout, nextPane.id, (pane) => ({
          ...pane,
          activeTabId: next.id,
        })),
        activePaneId: nextPane.id,
      };
    });
  }, []);

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => {
      const nextLayout = removeTabFromPane(current.layout, paneId, tabId);
      const layout = nextLayout ?? createPane();
      const activePaneId = findPane(layout, current.activePaneId)?.id ?? firstPane(layout).id;
      return {
        projectId: current.projectId,
        tabs: current.tabs.filter((tab) => tab.id !== tabId),
        layout,
        activePaneId,
      };
    });
  }, []);

  const moveTab = useCallback((
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    zone: WorkspaceDropZone,
  ) => {
    setWorkspace((current) => {
      const sourcePane = findPane(current.layout, sourcePaneId);
      const targetPane = findPane(current.layout, targetPaneId);
      if (!sourcePane?.tabIds.includes(tabId) || !targetPane) return current;
      if (sourcePaneId === targetPaneId && zone === "center") return current;

      const direction = zone === "left" || zone === "right" ? "row" : "column";
      const placeFirst = zone === "left" || zone === "top";

      if (sourcePaneId === targetPaneId && sourcePane.tabIds.length === 1) {
        const emptyPane = createPane();
        const layout = replacePane(current.layout, targetPaneId, (pane) => ({
          type: "split",
          id: crypto.randomUUID(),
          direction,
          ratio: 0.5,
          first: placeFirst ? pane : emptyPane,
          second: placeFirst ? emptyPane : pane,
        }));
        return { ...current, layout, activePaneId: sourcePane.id };
      }

      const detached = removeTabFromPane(current.layout, sourcePaneId, tabId);
      if (!detached) return current;
      const remainingTarget = findPane(detached, targetPaneId);
      if (!remainingTarget) return current;

      if (zone === "center") {
        return {
          ...current,
          layout: updatePane(detached, targetPaneId, (pane) => ({
            ...pane,
            tabIds: [...pane.tabIds, tabId],
            activeTabId: tabId,
          })),
          activePaneId: targetPaneId,
        };
      }

      const newPane = createPane(tabId);
      const layout = replacePane(detached, targetPaneId, (pane) => ({
        type: "split",
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        first: placeFirst ? newPane : pane,
        second: placeFirst ? pane : newPane,
      }));
      return { ...current, layout, activePaneId: newPane.id };
    });
  }, []);

  const activatePane = useCallback((activePaneId: string) => {
    setWorkspace((current) => findPane(current.layout, activePaneId)
      ? { ...current, activePaneId }
      : current);
  }, []);

  const captureProjectState = useCallback((): WorkspaceProjectSnapshot => ({
    projectId: workspace.projectId,
    tabs: workspace.tabs.filter((tab) => tab.projectId === workspace.projectId),
    layout: workspace.layout,
    activePaneId: workspace.activePaneId,
  }), [workspace.activePaneId, workspace.layout, workspace.projectId, workspace.tabs]);

  const switchProject = useCallback((projectId: string, next: WorkspaceProjectSnapshot) => {
    setWorkspace((current) => {
      const nextTabIds = new Set(next.tabs.map((tab) => tab.id));
      const existingById = new Map(
        current.tabs
          .filter((tab) => tab.projectId === projectId)
          .map((tab) => [tab.id, tab]),
      );
      const targetTabs = next.tabs.map((tab) => existingById.get(tab.id) ?? { ...tab, projectId });
      // Keep the previous project's tabs in the runtime registry while its
      // project is hidden.  Removing them here would make the registry
      // dispose their sessions as soon as the project is switched away from.
      // Only the active project's layout determines what is rendered.
      const preserved = current.tabs.filter((tab) => !nextTabIds.has(tab.id));
      const layout = targetTabs.length > 0 ? next.layout : createPane();
      const activePaneId = findPane(layout, next.activePaneId)?.id ?? firstPane(layout).id;
      return {
        projectId,
        tabs: [...preserved, ...targetTabs],
        layout,
        activePaneId,
      };
    });
  }, []);

  const activePane = findPane(workspace.layout, workspace.activePaneId) ?? firstPane(workspace.layout);

  return useMemo(() => ({
    projectId: workspace.projectId,
    tabs: workspace.tabs,
    layout: workspace.layout,
    activePaneId: activePane.id,
    activeTabId: activePane.activeTabId,
    activateNextSession,
    activatePane,
    activateTab,
    balanceWorkspace,
    closePane,
    collapseWorkspace,
    createTerminal,
    openTelnet,
    openSerial,
    openSsh,
    openRdp,
    closeTab,
    moveTab,
    mergeAllTabGroups,
    resizeSplit,
    captureProjectState,
    switchProject,
  }), [
    activateNextSession,
    activatePane,
    activateTab,
    balanceWorkspace,
    closePane,
    collapseWorkspace,
    activePane.activeTabId,
    activePane.id,
    closeTab,
    createTerminal,
    moveTab,
    mergeAllTabGroups,
    openSerial,
    openSsh,
    openRdp,
    openTelnet,
    workspace.layout,
    workspace.tabs,
    resizeSplit,
    captureProjectState,
    switchProject,
    workspace.projectId,
  ]);
}
