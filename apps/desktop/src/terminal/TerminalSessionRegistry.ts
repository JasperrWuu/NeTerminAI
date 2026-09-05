import { useEffect, useRef } from "react";
import {
  TerminalSessionRuntime,
  type TerminalSessionDefinition,
  type TerminalViewAttachment,
} from "./TerminalSessionRuntime";

/**
 * Owns the runtimes for currently open workspace tabs. Layout operations only
 * change which view is attached; a runtime is removed when its tab disappears.
 */
export class TerminalSessionRegistry {
  private readonly runtimes = new Map<string, TerminalSessionRuntime>();
  private accepting = true;

  acquire(tabId: string, definition: TerminalSessionDefinition, view: TerminalViewAttachment) {
    if (!this.accepting) throw new Error("终端工作区正在关闭");
    let runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.isDisposed) {
      runtime = new TerminalSessionRuntime(tabId, definition, view);
      this.runtimes.set(tabId, runtime);
    } else {
      runtime.attachView(view);
    }
    return runtime;
  }

  releaseView(tabId: string, container: HTMLElement) {
    this.runtimes.get(tabId)?.detachView(container);
  }

  get(tabId: string) {
    return this.runtimes.get(tabId);
  }

  reconnect(tabId: string) {
    this.runtimes.get(tabId)?.reconnect();
  }

  reconcile(openTabIds: readonly string[]) {
    const open = new Set(openTabIds);
    for (const [tabId, runtime] of this.runtimes) {
      if (open.has(tabId)) continue;
      runtime.dispose();
      this.runtimes.delete(tabId);
    }
  }

  disposeTab(tabId: string) {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return;
    runtime.dispose();
    this.runtimes.delete(tabId);
  }

  disposeAll() {
    if (!this.accepting) return;
    this.accepting = false;
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }
}

export function useTerminalSessionRegistry(openTabIds: readonly string[]) {
  const registryRef = useRef<TerminalSessionRegistry | null>(null);
  if (!registryRef.current) registryRef.current = new TerminalSessionRegistry();
  const registry = registryRef.current;
  const openTabKey = openTabIds.join("\u0000");

  useEffect(() => {
    registry.reconcile(openTabIds);
  }, [openTabKey, registry]);

  useEffect(() => {
    const handleBeforeUnload = () => registry.disposeAll();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      registry.disposeAll();
    };
  }, [registry]);

  return registry;
}
