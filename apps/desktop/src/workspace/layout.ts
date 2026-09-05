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

export function collectTabIds(node: WorkspaceLayoutNode): string[] {
  if (node.type === "pane") return [...node.tabIds];
  return [...collectTabIds(node.first), ...collectTabIds(node.second)];
}

export function countWorkspacePanes(node: WorkspaceLayoutNode): number {
  return node.type === "pane"
    ? 1
    : countWorkspacePanes(node.first) + countWorkspacePanes(node.second);
}

function createWorkspacePane(tabId: string | undefined): WorkspacePaneNode {
  return {
    type: "pane",
    id: crypto.randomUUID(),
    tabIds: tabId ? [tabId] : [],
    activeTabId: tabId ?? null,
  };
}

function buildBalancedSplit(
  nodes: readonly WorkspaceLayoutNode[],
  direction: WorkspaceSplitDirection,
): WorkspaceLayoutNode {
  if (nodes.length === 1) return nodes[0];

  const firstCount = Math.ceil(nodes.length / 2);
  return {
    type: "split",
    id: crypto.randomUUID(),
    direction,
    // The ratio is based on the number of leaves in each child. Using the
    // same ratio for the flex weights keeps every pane in this group equal.
    ratio: firstCount / nodes.length,
    first: buildBalancedSplit(nodes.slice(0, firstCount), direction),
    second: buildBalancedSplit(nodes.slice(firstCount), direction),
  };
}

/**
 * Creates a balanced grid for the supplied tabs. Rows are as close to square
 * as possible, and any remainder is assigned to the first rows. Each row and
 * the row stack are then represented by ordinary split nodes, so the existing
 * pane tree and runtime identities remain unchanged.
 */
export function buildBalancedWorkspaceLayout(tabIds: readonly string[]): WorkspaceLayoutNode {
  if (tabIds.length <= 1) {
    return createWorkspacePane(tabIds[0]);
  }

  const columns = Math.ceil(Math.sqrt(tabIds.length));
  const rows = Math.ceil(tabIds.length / columns);
  const baseRowSize = Math.floor(tabIds.length / rows);
  const extraRows = tabIds.length % rows;
  const rowNodes: WorkspaceLayoutNode[] = [];
  let offset = 0;

  for (let row = 0; row < rows; row += 1) {
    const rowSize = baseRowSize + (row < extraRows ? 1 : 0);
    const rowPanes = tabIds
      .slice(offset, offset + rowSize)
      .map((tabId) => createWorkspacePane(tabId));
    rowNodes.push(buildBalancedSplit(rowPanes, "row"));
    offset += rowSize;
  }

  return buildBalancedSplit(rowNodes, "column");
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

export function removePane(
  node: WorkspaceLayoutNode,
  paneId: string,
): WorkspaceLayoutNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function resizeWorkspaceSplit(
  node: WorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceLayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) {
    const nextRatio = Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, ratio))
      : node.ratio ?? 0.5;
    return { ...node, ratio: nextRatio };
  }
  return {
    ...node,
    first: resizeWorkspaceSplit(node.first, splitId, ratio),
    second: resizeWorkspaceSplit(node.second, splitId, ratio),
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
