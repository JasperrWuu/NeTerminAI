import type { RdpConnection } from "../connections/types";
import { rdpApi, type RdpBounds, type RdpRuntimeState, type RdpRuntimeStatus } from "../ipc/rdp";

export interface RdpViewAttachment {
  container: HTMLElement;
  active: boolean;
  paneActive: boolean;
  onActivate: () => void;
}

export interface RdpSessionRuntimeSnapshot {
  sessionId: string;
  state: RdpRuntimeState;
  error?: string;
}

type SnapshotListener = () => void;

const EMPTY_BOUNDS: RdpBounds = { x: 0, y: 0, width: 1, height: 1 };
const DISCONNECT_GRACE_MS = 15_000;

/**
 * Owns one native RDP runtime independently from whichever pane view is
 * currently mounted. Switching tabs only detaches/hides the view; it never
 * recreates the ActiveX control or reconnects the session.
 */
export class RdpSessionRuntime {
  readonly tabId: string;
  readonly sessionId: string;
  readonly connection: RdpConnection;

  private readonly listeners = new Set<SnapshotListener>();
  private view: RdpViewAttachment | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;
  private statusTimer: number | undefined;
  private disconnectedSince: number | undefined;
  private created = false;
  private started = false;
  private closeRequested = false;
  private disposed = false;
  private snapshot: RdpSessionRuntimeSnapshot;

  constructor(tabId: string, connection: RdpConnection) {
    this.tabId = tabId;
    this.sessionId = crypto.randomUUID();
    this.connection = connection;
    this.snapshot = { sessionId: this.sessionId, state: "initializing" };
  }

  get isDisposed() {
    return this.disposed;
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attachView(view: RdpViewAttachment) {
    if (this.disposed) return;
    if (this.view?.container !== view.container) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
    }
    this.view = view;
    this.resizeObserver ??= new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(view.container);
    this.scheduleResize();
    this.start();
    this.notify();
  }

  updateView(view: RdpViewAttachment) {
    if (this.disposed) return;
    if (this.view?.container !== view.container) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
      this.attachView(view);
      return;
    }
    this.view = view;
    this.scheduleResize();
  }

  detachView(container: HTMLElement) {
    if (this.disposed || this.view?.container !== container) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.view = undefined;
    this.sendResize(false);
  }

  focus() {
    if (this.disposed || !this.created || this.snapshot.state !== "connected") return;
    void rdpApi.focus(this.sessionId).catch((error: unknown) => {
      if (!this.disposed) this.setError(String(error));
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    if (this.statusTimer !== undefined) window.clearTimeout(this.statusTimer);
    this.resizeFrame = undefined;
    this.statusTimer = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.view = undefined;
    this.requestClose();
    this.listeners.clear();
  }

  private start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const bounds = this.view ? readBounds(this.view.container) : EMPTY_BOUNDS;
    void rdpApi.create({
      sessionId: this.sessionId,
      host: this.connection.host,
      port: this.connection.port,
      username: this.connection.username,
      adminSession: this.connection.adminSession,
      bounds,
    }).then(() => {
      this.created = true;
      if (this.disposed || this.closeRequested) {
        this.requestClose();
        return;
      }
      this.setState("connecting");
      this.sendResize(false);
      this.pollStatus();
    }).catch((error: unknown) => {
      if (this.disposed) {
        this.requestClose();
        return;
      }
      this.fail(String(error));
      this.requestClose();
    });
  }

  private pollStatus() {
    if (this.disposed || !this.created) return;
    void rdpApi.status(this.sessionId).then((runtime) => {
      if (this.disposed) return;
      this.applyRuntimeStatus(runtime);
      if (!this.disposed && this.snapshot.state !== "disconnected") {
        this.statusTimer = window.setTimeout(() => this.pollStatus(), 650);
      }
    }).catch((error: unknown) => {
      if (this.disposed) return;
      this.fail(String(error));
      this.requestClose();
    });
  }

  private applyRuntimeStatus(runtime: RdpRuntimeStatus) {
    if (runtime.state === "connected") {
      this.disconnectedSince = undefined;
      this.setState("connected");
      this.sendResize(Boolean(this.view?.active));
      if (runtime.focused && this.view && !this.view.paneActive) {
        this.view.onActivate();
      }
      if (this.view?.active) this.focus();
      return;
    }
    if (runtime.state === "connecting" || runtime.state === "initializing") {
      this.disconnectedSince = undefined;
      this.setState(runtime.state);
      this.sendResize(false);
      return;
    }

    this.disconnectedSince ??= performance.now();
    const expired = performance.now() - this.disconnectedSince >= DISCONNECT_GRACE_MS;
    if (runtime.disconnectReason || expired) {
      this.setState("disconnected");
      this.setError(runtime.disconnectReason || "RDP 连接未建立。请确认远程桌面已启用，并检查地址、端口和网络策略。");
      this.sendResize(false);
      // A terminal RDP disconnect no longer has a usable native surface.
      // Release the ActiveX/ATL host now; the retry action creates a fresh
      // runtime with a new session id.
      this.requestClose();
    } else {
      this.setState("connecting");
    }
  }

  private scheduleResize() {
    if (this.disposed || this.resizeFrame !== undefined) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      this.sendResize(Boolean(this.view?.active && this.snapshot.state === "connected"));
    });
  }

  private sendResize(visible: boolean) {
    if (this.disposed || !this.created) return;
    const bounds = this.view ? readBounds(this.view.container) : EMPTY_BOUNDS;
    void rdpApi.resize(this.sessionId, bounds, visible).catch((error: unknown) => {
      if (!this.disposed) this.setError(String(error));
    });
  }

  private requestClose() {
    if (this.closeRequested) return;
    this.closeRequested = true;
    void rdpApi.close(this.sessionId).catch(() => undefined);
  }

  private setState(state: RdpRuntimeState) {
    if (this.disposed || this.snapshot.state === state) return;
    this.snapshot = { sessionId: this.sessionId, state, error: this.snapshot.error };
    this.notify();
  }

  private setError(error: string) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, error };
    this.notify();
  }

  private fail(error: string) {
    if (this.disposed) return;
    this.disconnectedSince = undefined;
    this.snapshot = {
      sessionId: this.sessionId,
      state: "disconnected",
      error,
    };
    this.sendResize(false);
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

function readBounds(element: HTMLElement): RdpBounds {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
}
