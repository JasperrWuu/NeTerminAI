import { useCallback, useMemo, useRef, useState } from "react";

export interface TerminalInputTarget {
  focus: () => void;
  write: (data: string) => void;
}

export function useSynchronizedInput(visibleTerminalIds: string[]) {
  const targetsRef = useRef(new Map<string, TerminalInputTarget>());
  const visibleIdsRef = useRef(new Set(visibleTerminalIds));
  const enabledRef = useRef(false);
  const [enabled, setEnabled] = useState(false);

  visibleIdsRef.current = new Set(visibleTerminalIds);

  const registerTarget = useCallback((tabId: string, target: TerminalInputTarget) => {
    targetsRef.current.set(tabId, target);
    return () => {
      if (targetsRef.current.get(tabId) === target) targetsRef.current.delete(tabId);
    };
  }, []);

  const routeInput = useCallback((sourceTabId: string, data: string) => {
    if (enabledRef.current && visibleIdsRef.current.has(sourceTabId)) {
      visibleIdsRef.current.forEach((tabId) => targetsRef.current.get(tabId)?.write(data));
      return;
    }
    targetsRef.current.get(sourceTabId)?.write(data);
  }, []);

  const enable = useCallback(() => {
    enabledRef.current = true;
    setEnabled(true);
  }, []);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
  }, []);

  const focus = useCallback((tabId: string | null) => {
    if (!tabId) return;
    requestAnimationFrame(() => targetsRef.current.get(tabId)?.focus());
  }, []);

  return useMemo(() => ({
    enabled,
    enable,
    disable,
    focus,
    registerTarget,
    routeInput,
  }), [disable, enable, enabled, focus, registerTarget, routeInput]);
}
