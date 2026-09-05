import type { SavedConnectionSession } from "../connections/types";
import { getLocalTerminalProfile } from "../terminal/profiles";
import {
  collectTabIds,
  findPane,
  findPaneContainingTab,
  firstPane,
} from "../workspace/layout";
import type {
  LocalTerminalTab,
  RdpTab,
  SerialTab,
  SshTab,
  TelnetTab,
  WorkspaceLayoutNode,
  WorkspaceProjectSnapshot,
  WorkspaceTab,
} from "../workspace/types";
import type { Project, ProjectSessionRef } from "./types";

export function projectSessionsFromTabs(
  tabs: readonly WorkspaceTab[],
  projectId: string,
): ProjectSessionRef[] {
  return tabs
    .filter((tab) => tab.projectId === projectId)
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      source: tab.kind === "localTerminal"
        ? { kind: "local" as const, profileId: tab.profileId }
        : tab.connectionId
          ? { kind: "savedConnection" as const, connectionId: tab.connectionId }
          : { kind: "transient" as const, connectionKind: tab.kind },
    }));
}

export function resolveProjectTabs(
  project: Project,
  savedConnections: readonly SavedConnectionSession[],
  existingTabs: readonly WorkspaceTab[] = [],
): WorkspaceTab[] {
  const existingById = new Map(existingTabs.map((tab) => [tab.id, tab]));
  const savedById = new Map(savedConnections.map((session) => [session.id, session]));
  const tabs: WorkspaceTab[] = [];
  for (const reference of project.sessions) {
    const existing = existingById.get(reference.tabId);
    if (existing) {
      tabs.push({ ...existing, projectId: project.id });
      continue;
    }
    if (reference.source.kind === "local") {
      const profile = getLocalTerminalProfile(reference.source.profileId as LocalTerminalTab["profileId"]);
      tabs.push({
        id: reference.tabId,
        projectId: project.id,
        kind: "localTerminal",
        profileId: profile.id,
        title: reference.title || profile.name,
      });
      continue;
    }
    if (reference.source.kind !== "savedConnection") continue;
    const saved = savedById.get(reference.source.connectionId);
    if (!saved) continue;
    const tab = tabFromSavedConnection(reference.tabId, saved, project.id);
    if (tab) tabs.push(tab);
  }
  return tabs;
}

export function restoreProjectWorkspace(
  project: Project,
  tabs: readonly WorkspaceTab[],
): WorkspaceProjectSnapshot {
  const tabIds = tabs.map((tab) => tab.id);
  const available = new Set(tabIds);
  const layout = sanitizeLayout(project.layout.layout, available) ?? createPane(tabIds[0]);
  const requestedActiveTabId = project.runtime.activeTabId ?? project.layout.activeTabId;
  const activeTabId = requestedActiveTabId && available.has(requestedActiveTabId)
    ? requestedActiveTabId
    : collectTabIds(layout)[0] ?? null;
  const activePane = activeTabId
    ? findPaneContainingTab(layout, activeTabId)
    : null;
  const requestedPane = project.layout.activePaneId ? findPane(layout, project.layout.activePaneId) : null;
  return {
    projectId: project.id,
    tabs: [...tabs],
    layout,
    activePaneId: activePane?.id ?? requestedPane?.id ?? firstPane(layout).id,
  };
}

function tabFromSavedConnection(
  tabId: string,
  session: SavedConnectionSession,
  projectId: string,
): WorkspaceTab | null {
  const common = {
    id: tabId,
    projectId,
    connectionId: session.id,
    title: session.name,
  };
  if (session.kind === "telnet") return { ...common, kind: "telnet", connection: session } satisfies TelnetTab;
  if (session.kind === "serial") return { ...common, kind: "serial", connection: session } satisfies SerialTab;
  if (session.kind === "ssh") return { ...common, kind: "ssh", connection: session } satisfies SshTab;
  if (session.kind === "rdp") return { ...common, kind: "rdp", connection: session } satisfies RdpTab;
  return null;
}

function createPane(tabId: string | undefined) {
  return {
    type: "pane" as const,
    id: createId("pane"),
    tabIds: tabId ? [tabId] : [],
    activeTabId: tabId ?? null,
  };
}

function sanitizeLayout(
  node: WorkspaceLayoutNode | null,
  available: ReadonlySet<string>,
): WorkspaceLayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") {
    const tabIds = node.tabIds.filter((tabId) => available.has(tabId));
    if (tabIds.length === 0) return null;
    return {
      ...node,
      tabIds,
      activeTabId: node.activeTabId && tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0],
    };
  }
  const first = sanitizeLayout(node.first, available);
  const second = sanitizeLayout(node.second, available);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
