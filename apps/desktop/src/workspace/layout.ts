import type { WorkspaceLayoutNode, WorkspacePaneNode } from "./types";

export function findPane(node: WorkspaceLayoutNode, paneId: string): WorkspacePaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

export function findPaneContainingTab(
  node: WorkspaceLayoutNode,
  tabId: string,
): WorkspacePaneNode | null {
  if (node.type === "pane") return node.tabIds.includes(tabId) ? node : null;
  return findPaneContainingTab(node.first, tabId) ?? findPaneContainingTab(node.second, tabId);
}

export function firstPane(node: WorkspaceLayoutNode): WorkspacePaneNode {
  return node.type === "pane" ? node : firstPane(node.first);
}

export function updatePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  update: (pane: WorkspacePaneNode) => WorkspacePaneNode,
): WorkspaceLayoutNode {
  if (node.type === "pane") return node.id === paneId ? update(node) : node;
  return {
    ...node,
    first: updatePane(node.first, paneId, update),
    second: updatePane(node.second, paneId, update),
  };
}

export function replacePane(
  node: WorkspaceLayoutNode,
  paneId: string,
  replace: (pane: WorkspacePaneNode) => WorkspaceLayoutNode,
): WorkspaceLayoutNode {
  if (node.type === "pane") return node.id === paneId ? replace(node) : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replace),
    second: replacePane(node.second, paneId, replace),
  };
}

export function removeTabFromPane(
  node: WorkspaceLayoutNode,
  paneId: string,
  tabId: string,
): WorkspaceLayoutNode | null {
  if (node.type === "pane") {
    if (node.id !== paneId || !node.tabIds.includes(tabId)) return node;
    const closedIndex = node.tabIds.indexOf(tabId);
    const tabIds = node.tabIds.filter((id) => id !== tabId);
    if (tabIds.length === 0) return null;
    const activeTabId = node.activeTabId === tabId
      ? tabIds[Math.min(closedIndex, tabIds.length - 1)]
      : node.activeTabId;
    return { ...node, tabIds, activeTabId };
  }

  const first = removeTabFromPane(node.first, paneId, tabId);
  const second = removeTabFromPane(node.second, paneId, tabId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
