import { useState } from "react";
import type { RdpConnection, SerialConnection, SshConnection, TelnetConnection } from "../connections/types";
import { getLocalTerminalProfile } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import {
  findPane,
  findPaneContainingTab,
  firstPane,
  removeTabFromPane,
  replacePane,
  updatePane,
} from "./layout";
import type {
  LocalTerminalTab,
  SettingsSection,
  WorkspaceDropZone,
  WorkspaceLayoutNode,
  WorkspacePaneNode,
  WorkspaceTab,
} from "./types";

interface WorkspaceState {
  tabs: WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
}

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
): LocalTerminalTab {
  const profile = getLocalTerminalProfile(profileId);
  const profileCount = existingTabs.filter(
    (tab) => tab.kind === "localTerminal" && tab.profileId === profileId,
  ).length;

  return {
    id,
    kind: "localTerminal",
    profileId,
    title: profileCount === 0 ? profile.name : `${profile.name} ${profileCount + 1}`,
  };
}

export function useWorkspaceTabs() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => {
    const initialTab = createLocalTerminalTab(crypto.randomUUID(), "powershell", []);
    const initialPane = createPane(initialTab.id);
    return { tabs: [initialTab], layout: initialPane, activePaneId: initialPane.id };
  });

  const addTab = (create: (tabs: WorkspaceTab[]) => WorkspaceTab) => {
    setWorkspace((current) => {
      const tab = create(current.tabs);
      const paneId = findPane(current.layout, current.activePaneId)?.id ?? firstPane(current.layout).id;
      return {
        tabs: [...current.tabs, tab],
        layout: updatePane(current.layout, paneId, (pane) => ({
          ...pane,
          tabIds: [...pane.tabIds, tab.id],
          activeTabId: tab.id,
        })),
        activePaneId: paneId,
      };
    });
  };

  const createTerminal = (profileId: LocalTerminalProfileId) => {
    const tabId = crypto.randomUUID();
    addTab((tabs) => createLocalTerminalTab(tabId, profileId, tabs));
  };

  const openSettings = (section: SettingsSection) => {
    setWorkspace((current) => {
      const existing = current.tabs.find(
        (tab) => tab.kind === "settings" && tab.section === section,
      );
      if (existing) {
        const pane = findPaneContainingTab(current.layout, existing.id);
        if (!pane) return current;
        return {
          ...current,
          layout: updatePane(current.layout, pane.id, (item) => ({ ...item, activeTabId: existing.id })),
          activePaneId: pane.id,
        };
      }

      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        kind: "settings",
        section,
        title: "终端设置",
      };
      const paneId = findPane(current.layout, current.activePaneId)?.id ?? firstPane(current.layout).id;
      return {
        tabs: [...current.tabs, tab],
        layout: updatePane(current.layout, paneId, (pane) => ({
          ...pane,
          tabIds: [...pane.tabIds, tab.id],
          activeTabId: tab.id,
        })),
        activePaneId: paneId,
      };
    });
  };

  const openTelnet = (connection: TelnetConnection) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "telnet",
    connection,
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  }));

  const openSerial = (connection: SerialConnection) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "serial",
    connection,
    title: connection.name.trim() || connection.portName,
  }));

  const openSsh = (connection: SshConnection) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "ssh",
    connection,
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  }));

  const openRdp = (connection: RdpConnection) => addTab(() => ({
    id: crypto.randomUUID(),
    kind: "rdp",
    connection,
    title: connection.name.trim() || `${connection.host}:${connection.port}`,
  }));

  const activateTab = (paneId: string, tabId: string) => {
    setWorkspace((current) => ({
      ...current,
      layout: updatePane(current.layout, paneId, (pane) => (
        pane.tabIds.includes(tabId) ? { ...pane, activeTabId: tabId } : pane
      )),
      activePaneId: paneId,
    }));
  };

  const closeTab = (paneId: string, tabId: string) => {
    setWorkspace((current) => {
      const nextLayout = removeTabFromPane(current.layout, paneId, tabId);
      const layout = nextLayout ?? createPane();
      const activePaneId = findPane(layout, current.activePaneId)?.id ?? firstPane(layout).id;
      return {
        tabs: current.tabs.filter((tab) => tab.id !== tabId),
        layout,
        activePaneId,
      };
    });
  };

  const moveTab = (
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
        first: placeFirst ? newPane : pane,
        second: placeFirst ? pane : newPane,
      }));
      return { ...current, layout, activePaneId: newPane.id };
    });
  };

  const activePane = findPane(workspace.layout, workspace.activePaneId) ?? firstPane(workspace.layout);

  return {
    tabs: workspace.tabs,
    layout: workspace.layout,
    activePaneId: activePane.id,
    activeTabId: activePane.activeTabId,
    activatePane: (activePaneId: string) =>
      setWorkspace((current) => findPane(current.layout, activePaneId) ? { ...current, activePaneId } : current),
    activateTab,
    createTerminal,
    openTelnet,
    openSerial,
    openSsh,
    openRdp,
    openSettings,
    closeTab,
    moveTab,
  };
}
