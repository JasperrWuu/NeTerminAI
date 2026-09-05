import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CONTEXT_SELECTION,
  reconcileContextSelection,
  type ContextSelection,
  type TerminalContextScope,
} from "../../capabilities/terminal";

export function useAiContextSelection(
  openTabIds: readonly string[],
  activeTabId: string | null,
  visibleTabIds: readonly string[] = [],
  initialSelection: ContextSelection = DEFAULT_CONTEXT_SELECTION,
  selectionKey?: string,
) {
  const [selection, setSelection] = useState<ContextSelection>(() => ({
    scope: initialSelection.scope,
    selectedTabIds: [...initialSelection.selectedTabIds],
  }));
  const openTabKey = openTabIds.join("\u0000");

  useEffect(() => {
    setSelection((current) => reconcileContextSelection(current, openTabIds));
  }, [openTabKey, openTabIds]);

  useEffect(() => {
    if (selectionKey === undefined) return;
    setSelection(reconcileContextSelection({
      scope: initialSelection.scope,
      selectedTabIds: [...initialSelection.selectedTabIds],
    }, openTabIds));
    // A project key deliberately controls this reset; changing the object
    // reference for the same project must not erase an in-progress selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const setScope = useCallback((scope: TerminalContextScope) => {
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
