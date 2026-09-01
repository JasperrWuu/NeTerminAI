import type { WorkspaceDropZone, WorkspaceLayoutNode, WorkspacePaneNode, WorkspaceSplitDirection } from "./types";

interface DropBounds {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

export function resolveWorkspaceDropZone(
  bounds: DropBounds,
  clientX: number,
  clientY: number,
  overTabBar = false,
): WorkspaceDropZone {
  const x = Math.min(1, Math.max(0, (clientX - bounds.left) / Math.max(bounds.width, 1)));
  const y = Math.min(1, Math.max(0, (clientY - bounds.top) / Math.max(bounds.height, 1)));

  // The tab strip is for selecting or moving tabs between existing groups.
  // Split intent begins only after the pointer enters the terminal surface,
  // which avoids accidental splits while the user is still grabbing a tab.
  if (overTabBar) return "center";

  const horizontalThreshold = 0.3;
  const verticalThreshold = 0.25;
  const horizontal = x <= horizontalThreshold
    ? { score: x / horizontalThreshold, zone: "left" as const }
    : x >= 1 - horizontalThreshold
      ? { score: (1 - x) / horizontalThreshold, zone: "right" as const }
      : null;
  const vertical = y <= verticalThreshold
    ? { score: y / verticalThreshold, zone: "top" as const }
    : y >= 1 - verticalThreshold
      ? { score: (1 - y) / verticalThreshold, zone: "bottom" as const }
      : null;

  if (horizontal && vertical) {
    const paneFavorsHorizontal = bounds.width >= bounds.height;
    const horizontalScore = horizontal.score * (paneFavorsHorizontal ? 0.86 : 1);
    const verticalScore = vertical.score * (paneFavorsHorizontal ? 1 : 0.86);
    return horizontalScore <= verticalScore ? horizontal.zone : vertical.zone;
  }
  return horizontal?.zone ?? vertical?.zone ?? "center";
}

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

export function collectVisibleTabIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === "pane") return node.activeTabId ? [node.activeTabId] : [];
  return [...collectVisibleTabIds(node.first), ...collectVisibleTabIds(node.second)];
}

/**
 * Creates a near-complete binary layout for the supplied tabs. Alternating the
 * split direction at each level keeps the common 4-tab case as a 2×2 grid,
 * while odd counts remain balanced without introducing empty panes.
 */
export function buildBalancedWorkspaceLayout(tabIds: readonly string[], depth = 0): WorkspaceLayoutNode {
  if (tabIds.length <= 1) {
    return {
      type: "pane",
      id: crypto.randomUUID(),
      tabIds: [...tabIds],
      activeTabId: tabIds[0] ?? null,
    };
  }

  const splitIndex = Math.ceil(tabIds.length / 2);
  const direction: WorkspaceSplitDirection = depth % 2 === 0 ? "row" : "column";
  return {
    type: "split",
    id: crypto.randomUUID(),
    direction,
    first: buildBalancedWorkspaceLayout(tabIds.slice(0, splitIndex), depth + 1),
    second: buildBalancedWorkspaceLayout(tabIds.slice(splitIndex), depth + 1),
  };
}

export function collapseWorkspaceLayout(
  tabIds: readonly string[],
  activeTabId: string | null,
): WorkspacePaneNode {
  const nextActiveTabId = activeTabId && tabIds.includes(activeTabId)
    ? activeTabId
    : tabIds[0] ?? null;
  return {
    type: "pane",
    id: crypto.randomUUID(),
    tabIds: [...tabIds],
    activeTabId: nextActiveTabId,
  };
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
