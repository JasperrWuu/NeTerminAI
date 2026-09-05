import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_AI_CONTEXT_SELECTION,
  reconcileContextSelection,
  type AiContextScope,
  type AiContextSelection,
} from "./selection";

export function useAiContextSelection(
  openTabIds: readonly string[],
  activeTabId: string | null,
  visibleTabIds: readonly string[] = [],
) {
  const [selection, setSelection] = useState<AiContextSelection>(() => ({
    ...DEFAULT_AI_CONTEXT_SELECTION,
  }));
  const openTabKey = openTabIds.join("\u0000");

  useEffect(() => {
    setSelection((current) => reconcileContextSelection(current, openTabIds));
  }, [openTabKey, openTabIds]);

  const setScope = useCallback((scope: AiContextScope) => {
    setSelection((current) => ({ ...current, scope }));
  }, []);

  const selectAll = useCallback(() => {
    setSelection({ scope: "selected", selectedTabIds: [...openTabIds] });
  }, [openTabKey, openTabIds]);

  const clear = useCallback(() => {
    setSelection({ scope: "selected", selectedTabIds: [] });
  }, []);

  const toggle = useCallback((tabId: string, checked: boolean) => {
    setSelection((current) => {
      const selected = current.scope === "selected"
        ? new Set(current.selectedTabIds)
        : current.scope === "visible"
          ? new Set(visibleTabIds)
          : new Set(activeTabId ? [activeTabId] : []);
      if (checked) selected.add(tabId);
      else selected.delete(tabId);
      return { scope: "selected", selectedTabIds: [...selected] };
    });
  }, [activeTabId, visibleTabIds]);

  return useMemo(() => ({
    selection,
    setScope,
    selectActive: () => setScope("active"),
    selectVisible: () => setScope("visible"),
    selectAll,
    clear,
    toggle,
  }), [clear, selectAll, selection, setScope, toggle]);
}
