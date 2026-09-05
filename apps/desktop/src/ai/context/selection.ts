import { collectVisibleTabIds, findPane } from "../../workspace/layout.ts";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../../workspace/types";

export type AiContextScope = "active" | "visible" | "selected";

export interface AiContextSelection {
  scope: AiContextScope;
  selectedTabIds: string[];
}

export const DEFAULT_AI_CONTEXT_SELECTION: Readonly<AiContextSelection> = {
  scope: "active",
  selectedTabIds: [],
};

export function resolveContextSelection(
  selection: AiContextSelection,
  tabs: readonly WorkspaceTab[],
  layout: WorkspaceLayoutNode,
  activePaneId: string,
): string[] {
  const openTabIds = new Set(tabs.map((tab) => tab.id));
  if (selection.scope === "selected") {
    return selection.selectedTabIds.filter((tabId) => openTabIds.has(tabId));
  }
  if (selection.scope === "visible") return unique(collectVisibleTabIds(layout));

  const activePane = findPane(layout, activePaneId);
  const activeTabId = activePane?.activeTabId ?? null;
  return activeTabId && openTabIds.has(activeTabId) ? [activeTabId] : [];
}

export function reconcileContextSelection(
  selection: AiContextSelection,
  openTabIds: readonly string[],
): AiContextSelection {
  const open = new Set(openTabIds);
  const selectedTabIds = selection.selectedTabIds.filter((tabId) => open.has(tabId));
  return selectedTabIds.length === selection.selectedTabIds.length
    ? selection
    : { ...selection, selectedTabIds };
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
