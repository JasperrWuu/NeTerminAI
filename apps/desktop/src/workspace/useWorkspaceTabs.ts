import { useState } from "react";
import { getLocalTerminalProfile } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { LocalTerminalTab, WorkspaceTab } from "./types";
import type { SettingsSection } from "./types";
import type { RdpConnection, SerialConnection, SshConnection, TelnetConnection } from "../connections/types";

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
  const [workspace, setWorkspace] = useState<{
    tabs: WorkspaceTab[];
    activeTabId: string | null;
  }>(() => {
    const initialTab = createLocalTerminalTab(crypto.randomUUID(), "powershell", []);
    return { tabs: [initialTab], activeTabId: initialTab.id };
  });

  const createTerminal = (profileId: LocalTerminalProfileId) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => {
      const tab = createLocalTerminalTab(tabId, profileId, current.tabs);
      return { tabs: [...current.tabs, tab], activeTabId: tab.id };
    });
  };

  const openSettings = (section: SettingsSection) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => {
      const existing = current.tabs.find(
        (tab) => tab.kind === "settings" && tab.section === section,
      );
      if (existing) return { ...current, activeTabId: existing.id };

      const tab: WorkspaceTab = {
        id: tabId,
        kind: "settings",
        section,
        title: "终端设置",
      };
      return { tabs: [...current.tabs, tab], activeTabId: tab.id };
    });
  };

  const openTelnet = (connection: TelnetConnection) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => ({
      tabs: [
        ...current.tabs,
        {
          id: tabId,
          kind: "telnet",
          connection,
          title: connection.name.trim() || `${connection.host}:${connection.port}`,
        },
      ],
      activeTabId: tabId,
    }));
  };

  const openSerial = (connection: SerialConnection) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => ({
      tabs: [...current.tabs, {
        id: tabId,
        kind: "serial",
        connection,
        title: connection.name.trim() || connection.portName,
      }],
      activeTabId: tabId,
    }));
  };

  const openSsh = (connection: SshConnection) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => ({
      tabs: [...current.tabs, { id: tabId, kind: "ssh", connection, title: connection.name.trim() || `${connection.host}:${connection.port}` }],
      activeTabId: tabId,
    }));
  };

  const openRdp = (connection: RdpConnection) => {
    const tabId = crypto.randomUUID();
    setWorkspace((current) => ({
      tabs: [...current.tabs, { id: tabId, kind: "rdp", connection, title: connection.name.trim() || `${connection.host}:${connection.port}` }],
      activeTabId: tabId,
    }));
  };

  const closeTab = (tabId: string) => {
    setWorkspace((current) => {
      const closedIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const nextActiveIndex = Math.min(closedIndex, tabs.length - 1);
      const activeTabId =
        current.activeTabId === tabId
          ? (tabs[nextActiveIndex]?.id ?? null)
          : current.activeTabId;

      return { tabs, activeTabId };
    });
  };

  return {
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
    activateTab: (activeTabId: string) =>
      setWorkspace((current) => ({ ...current, activeTabId })),
    createTerminal,
    openTelnet,
    openSerial,
    openSsh,
    openRdp,
    openSettings,
    closeTab,
  };
}
