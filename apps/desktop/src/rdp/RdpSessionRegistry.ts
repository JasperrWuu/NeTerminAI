import { useEffect, useRef } from "react";
import type { RdpConnection } from "../connections/types";
import {
  RdpSessionRuntime,
  type RdpSessionRuntimeSnapshot,
  type RdpViewAttachment,
} from "./RdpSessionRuntime";

export type { RdpSessionRuntimeSnapshot } from "./RdpSessionRuntime";

export class RdpSessionRegistry {
  private readonly runtimes = new Map<string, RdpSessionRuntime>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private accepting = true;

  acquire(tabId: string, connection: RdpConnection, view: RdpViewAttachment) {
    if (!this.accepting) throw new Error("RDP 工作区正在关闭");
    let runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.isDisposed) {
      this.runtimeUnsubscribers.get(tabId)?.();
      this.runtimeUnsubscribers.delete(tabId);
      runtime?.dispose();
      runtime = new RdpSessionRuntime(tabId, connection);
      this.runtimes.set(tabId, runtime);
      this.runtimeUnsubscribers.set(tabId, runtime.subscribe(() => this.notify(tabId)));
    }
    runtime.attachView(view);
    return runtime;
  }

  get(tabId: string) {
    return this.runtimes.get(tabId);
  }

  subscribe(tabId: string, listener: () => void) {
    let listeners = this.listeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(tabId);
    };
  }

  getSnapshot(tabId: string): RdpSessionRuntimeSnapshot | undefined {
    return this.runtimes.get(tabId)?.getSnapshot();
  }

  releaseView(tabId: string, container: HTMLElement) {
    this.runtimes.get(tabId)?.detachView(container);
  }

  focus(tabId: string) {
    this.runtimes.get(tabId)?.focus();
  }

  restart(tabId: string) {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return;
    runtime.dispose();
    this.runtimes.delete(tabId);
    this.runtimeUnsubscribers.get(tabId)?.();
    this.runtimeUnsubscribers.delete(tabId);
    this.listeners.delete(tabId);
  }

  reconcile(openTabIds: readonly string[]) {
    const open = new Set(openTabIds);
    for (const [tabId, runtime] of this.runtimes) {
      if (open.has(tabId)) continue;
      runtime.dispose();
      this.runtimes.delete(tabId);
      this.runtimeUnsubscribers.get(tabId)?.();
      this.runtimeUnsubscribers.delete(tabId);
      this.listeners.delete(tabId);
    }
  }

  disposeAll() {
    if (!this.accepting) return;
    this.accepting = false;
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    for (const unsubscribe of this.runtimeUnsubscribers.values()) unsubscribe();
    this.runtimeUnsubscribers.clear();
    this.listeners.clear();
  }

  private notify(tabId: string) {
    for (const listener of this.listeners.get(tabId) ?? []) listener();
  }
}

export function useRdpSessionRegistry(openTabIds: readonly string[]) {
  const registryRef = useRef<RdpSessionRegistry | null>(null);
  if (!registryRef.current) registryRef.current = new RdpSessionRegistry();
  const registry = registryRef.current;
  const openTabKey = openTabIds.join("\u0000");

  useEffect(() => {
    registry.reconcile(openTabIds);
  }, [openTabKey, registry]);

  useEffect(() => {
    const handleBeforeUnload = () => registry.disposeAll();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [registry]);

  return registry;
}
