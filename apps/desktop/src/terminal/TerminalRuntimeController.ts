import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invokeInBackground } from "../platform/tauri";

interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

interface TerminalExitEvent {
  sessionId: string;
}

interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalRuntimeControllerOptions {
  commandPrefix: string;
  eventPrefix: string;
  container: HTMLElement;
  supportsResize: boolean;
  isActive: () => boolean;
  fit: () => void;
  getTerminalSize: () => TerminalSize;
  createArguments: (sessionId: string, size: TerminalSize) => Record<string, unknown>;
  onOutput: (data: string) => void;
  onExit: () => void;
  onReady: (sessionId: string) => void;
  onError: (error: unknown) => void;
}

type Unlisten = () => void;

/**
 * Owns one backend terminal runtime without owning the terminal renderer.
 * The controller is intentionally small: it coordinates listener/session
 * lifecycle and leaves rendering, input, buffering and visual settings to
 * TerminalPane.
 */
export class TerminalRuntimeController {
  private readonly sessionId = crypto.randomUUID();
  private readonly listeners = new Set<Unlisten>();
  private readonly pendingRegistrations = new Set<Promise<void>>();
  private disposed = false;
  private started = false;
  private sessionEnded = false;
  private createSucceeded = false;
  private createPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;

  constructor(private readonly options: TerminalRuntimeControllerOptions) {}

  get id() {
    return this.sessionId;
  }

  get isReady() {
    return this.createSucceeded && !this.disposed && !this.sessionEnded;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.installResizeObserver();
    void this.startRuntime();
  }

  resize() {
    this.performResize();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.resizeFrame !== undefined) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = undefined;
    }
    this.removeListeners();
    // Cleanup is intentionally non-blocking; all pending registrations still
    // settle without creating an unhandled rejection.
    void Promise.allSettled(this.pendingRegistrations);
    this.requestClose();
  }

  private installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        this.performResize();
      });
    });
    this.resizeObserver.observe(this.options.container);
  }

  private performResize() {
    if (this.disposed || !this.options.isActive()) return;
    this.options.fit();
    if (!this.options.supportsResize || !this.isReady) return;
    const size = this.options.getTerminalSize();
    invokeInBackground(`resize_${this.options.commandPrefix}`, {
      sessionId: this.sessionId,
      columns: size.columns,
      rows: size.rows,
    });
  }

  private async startRuntime() {
    try {
      this.options.fit();
      await this.registerOutputListener();
      if (this.disposed) return;
      await this.registerExitListener();
      if (this.disposed) return;

      const createPromise = invoke<void>(
        `create_${this.options.commandPrefix}`,
        this.options.createArguments(this.sessionId, this.options.getTerminalSize()),
      );
      this.createPromise = createPromise;
      await createPromise;
      this.createSucceeded = true;

      if (this.disposed || this.sessionEnded) {
        this.requestClose();
        return;
      }
      this.options.onReady(this.sessionId);
    } catch (error) {
      if (!this.disposed) this.options.onError(error);
      this.removeListeners();
    }
  }

  private registerOutputListener() {
    return this.trackRegistration(
      listen<TerminalOutputEvent>(`${this.options.eventPrefix}:output`, ({ payload }) => {
        if (!this.disposed && payload.sessionId === this.sessionId) {
          this.options.onOutput(payload.data);
        }
      }).then((unlisten) => {
        if (this.disposed) {
          unlisten();
          return;
        }
        this.listeners.add(unlisten);
      }),
    );
  }

  private registerExitListener() {
    return this.trackRegistration(
      listen<TerminalExitEvent>(`${this.options.eventPrefix}:exit`, ({ payload }) => {
        if (this.disposed || payload.sessionId !== this.sessionId) return;
        this.sessionEnded = true;
        this.options.onExit();
      }).then((unlisten) => {
        if (this.disposed) {
          unlisten();
          return;
        }
        this.listeners.add(unlisten);
      }),
    );
  }

  private trackRegistration(registration: Promise<void>) {
    this.pendingRegistrations.add(registration);
    // Both handlers are deliberately non-throwing so this bookkeeping cannot
    // create an unhandled rejection of its own.
    void registration.then(
      () => this.pendingRegistrations.delete(registration),
      () => this.pendingRegistrations.delete(registration),
    );
    return registration;
  }

  private removeListeners() {
    for (const unlisten of this.listeners) {
      try {
        unlisten();
      } catch {
        // Listener cleanup is best effort; a late registration still performs
        // its own unlisten when it resolves.
      }
    }
    this.listeners.clear();
  }

  private requestClose() {
    if (this.closePromise) return;
    this.closePromise = this.closeAfterCreate();
  }

  private async closeAfterCreate() {
    if (this.createPromise) {
      try {
        await this.createPromise;
      } catch {
        return;
      }
    }
    if (!this.createSucceeded) return;
    await invoke<void>(`close_${this.options.commandPrefix}`, {
      sessionId: this.sessionId,
    }).catch(() => undefined);
  }
}
