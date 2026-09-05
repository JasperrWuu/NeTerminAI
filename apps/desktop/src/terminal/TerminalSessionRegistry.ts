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
  private readonly listeners = new Set<() => void>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private accepting = true;
  private revision = 0;

  acquire(tabId: string, definition: TerminalSessionDefinition, view: TerminalViewAttachment) {
    if (!this.accepting) throw new Error("终端工作区正在关闭");
    let runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.isDisposed) {
      runtime = new TerminalSessionRuntime(tabId, definition, view);
      this.runtimes.set(tabId, runtime);
      this.runtimeUnsubscribers.set(tabId, runtime.subscribe(() => this.notify()));
      this.notify();
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

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision() {
    return this.revision;
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
      this.runtimeUnsubscribers.get(tabId)?.();
      this.runtimeUnsubscribers.delete(tabId);
      this.notify();
    }
  }

  disposeTab(tabId: string) {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return;
    runtime.dispose();
    this.runtimes.delete(tabId);
    this.runtimeUnsubscribers.get(tabId)?.();
    this.runtimeUnsubscribers.delete(tabId);
    this.notify();
  }

  disposeAll() {
    if (!this.accepting) return;
    this.accepting = false;
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    for (const unsubscribe of this.runtimeUnsubscribers.values()) unsubscribe();
    this.runtimeUnsubscribers.clear();
    this.notify();
  }

  private notify() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
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
