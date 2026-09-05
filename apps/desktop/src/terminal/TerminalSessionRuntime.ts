import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AppearanceTheme, TerminalSettings } from "../settings/types";
import type { SerialConnection, TelnetConnection } from "../connections/types";
import type { LocalTerminalProfileId } from "./profiles";
import { resolveTerminalClipboardAction } from "./clipboard";
import { TerminalHighlightStream } from "./highlighting";
import { resolveTerminalTheme } from "./themes";
import { terminalFontStack } from "./fontStack";
import { TerminalInputPump } from "./TerminalInputPump";
import {
  TerminalRuntimeController,
  type TerminalConnectionStateEvent,
} from "./TerminalRuntimeController";
import { terminalApi } from "../ipc/terminal";
import type {
  TerminalConnectionState,
  TerminalConnectionType,
  TerminalCreateRequest,
  TerminalDisconnectReason,
  TerminalSize,
} from "../ipc/types";
import type { TerminalInputTarget } from "./useSynchronizedInput";

export type TerminalSessionDefinition =
  | { sessionType: "local"; profileId: LocalTerminalProfileId }
  | { sessionType: "telnet"; connection: TelnetConnection }
  | { sessionType: "serial"; connection: SerialConnection };

export interface TerminalViewAttachment {
  container: HTMLElement;
  active: boolean;
  settings: TerminalSettings;
  theme: AppearanceTheme;
  onInput: (data: string) => void;
  registerInputTarget: (tabId: string, target: TerminalInputTarget) => () => void;
}

export interface TerminalSessionRuntimeSnapshot {
  sessionId: string;
  state: TerminalConnectionState;
  reason?: TerminalDisconnectReason;
  message?: string;
}

type SnapshotListener = () => void;

const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Owns one tab's terminal runtime independently from the React view that
 * happens to display it. The xterm instance stays alive in a detached host so
 * layout changes and view reattachment retain the native scrollback buffer.
 */
export class TerminalSessionRuntime {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly parkingHost: HTMLDivElement;
  private readonly highlighter: TerminalHighlightStream;
  private readonly inputPump: TerminalInputPump;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly tabId: string;
  private readonly definition: TerminalSessionDefinition;
  private controller: TerminalRuntimeController;
  private view: TerminalViewAttachment | undefined;
  private unregisterInputTarget: (() => void) | undefined;
  private inputSubscription: { dispose: () => void } | undefined;
  private pendingOutput: Uint8Array[] = [];
  private pendingOutputBytes = 0;
  private outputFrame: number | undefined;
  private outputDecoder = new TextDecoder();
  private snapshot: TerminalSessionRuntimeSnapshot;
  private disposed = false;

  constructor(tabId: string, definition: TerminalSessionDefinition, view: TerminalViewAttachment) {
    this.tabId = tabId;
    this.definition = definition;
    this.view = view;
    this.parkingHost = document.createElement("div");
    this.parkingHost.className = "terminal-runtime-parking";
    this.terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: view.settings.cursorBlink,
      cursorStyle: view.settings.cursorStyle,
      fontFamily: terminalFontStack(view.settings),
      fontSize: view.settings.fontSize,
      fontWeight: view.settings.fontWeight,
      lineHeight: view.settings.lineHeight,
      scrollback: view.settings.scrollback,
      theme: resolveTerminalTheme(view.settings.colorScheme, view.theme),
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(view.container);
    this.highlighter = new TerminalHighlightStream(activeHighlightRules(view.settings));
    this.inputPump = new TerminalInputPump({
      write: async (data) => {
        const controller = this.controller;
        if (this.disposed || !controller.isReady) return;
        await terminalApi.write({ kind: controller.connectionType, sessionId: controller.id, data });
      },
      onError: (error) => this.setViewMessage(String(error)),
    });
    this.inputSubscription = this.terminal.onData((data) => {
      if (!this.disposed && this.view?.active) this.view.onInput(data);
    });
    this.terminal.attachCustomKeyEventHandler((event) => this.handleClipboardKey(event));
    this.controller = this.createController(view.container, true);
    this.snapshot = { sessionId: this.controller.id, state: "connecting" };
    this.registerInputTarget(view);
    this.applySettings(view.settings, view.theme);
    this.controller.start();
  }

  get sessionId() {
    return this.controller.id;
  }

  get connectionType(): TerminalConnectionType {
    return this.controller.connectionType;
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

  attachView(view: TerminalViewAttachment) {
    if (this.disposed) return;
    if (this.view?.container !== view.container) {
      this.moveTerminalTo(view.container);
    }
    this.view = view;
    this.registerInputTarget(view);
    this.applySettings(view.settings, view.theme);
    this.controller.attachView(view.container);
    if (view.active) {
      this.controller.resize();
      this.focus();
    }
    this.notify();
  }

  updateView(view: Omit<TerminalViewAttachment, "container" | "settings" | "theme"> & {
    container?: HTMLElement;
    settings: TerminalSettings;
    theme: AppearanceTheme;
    active: boolean;
  }) {
    if (this.disposed || !this.view) return;
    this.view = { ...this.view, ...view, container: view.container ?? this.view.container };
    this.applySettings(view.settings, view.theme);
    if (view.active) this.controller.resize();
  }

  detachView(container: HTMLElement) {
    if (this.disposed || this.view?.container !== container) return;
    this.unregisterInputTarget?.();
    this.unregisterInputTarget = undefined;
    this.controller.detachView();
    this.moveTerminalTo(this.parkingHost);
    this.view = undefined;
  }

  reconnect() {
    if (this.disposed) return;
    this.inputPump.reset();
    this.outputDecoder = new TextDecoder();
    this.controller.dispose();
    const container = this.view?.container ?? this.parkingHost;
    this.controller = this.createController(container, Boolean(this.view));
    this.snapshot = { sessionId: this.controller.id, state: "connecting" };
    this.controller.start();
    this.notify();
  }

  focus() {
    if (!this.disposed) this.terminal.focus();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterInputTarget?.();
    this.unregisterInputTarget = undefined;
    this.inputPump.dispose();
    this.inputSubscription?.dispose();
    this.inputSubscription = undefined;
    if (this.outputFrame !== undefined) cancelAnimationFrame(this.outputFrame);
    this.outputFrame = undefined;
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    this.controller.dispose();
    this.terminal.dispose();
    this.listeners.clear();
    this.view = undefined;
  }

  private createController(container: HTMLElement, initiallyAttached: boolean) {
    return new TerminalRuntimeController({
      connectionType: connectionTypeFor(this.definition),
      container,
      initiallyAttached,
      supportsResize: this.definition.sessionType !== "serial",
      isActive: () => Boolean(this.view?.active),
      fit: () => this.fitAddon.fit(),
      getTerminalSize: () => ({ columns: this.terminal.cols, rows: this.terminal.rows }),
      createRequest: (sessionId, size) => createRequestFor(this.definition, sessionId, size),
      onOutput: (data) => this.enqueueOutput(data),
      onReady: () => this.notify(),
      onStateChange: (event) => this.handleState(event),
      onError: (error) => this.updateError(error.message),
    });
  }

  private handleState(event: TerminalConnectionStateEvent) {
    if (this.disposed || event.sessionId !== this.controller.id) return;
    if ((this.snapshot.state === "disconnected" || this.snapshot.state === "failed")
      && (event.state === "disconnected" || event.state === "failed")) return;
    this.snapshot = {
      sessionId: event.sessionId,
      state: event.state,
      reason: event.reason,
      message: event.message,
    };
    this.notify();
  }

  private updateError(message: string) {
    if (this.disposed) return;
    this.snapshot = {
      sessionId: this.controller.id,
      state: "failed",
      reason: "connectionFailed",
      message,
    };
    this.notify();
  }

  private setViewMessage(message: string) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, message };
    this.notify();
  }

  private registerInputTarget(view: TerminalViewAttachment) {
    this.unregisterInputTarget?.();
    this.unregisterInputTarget = view.registerInputTarget(this.tabId, {
      focus: () => this.focus(),
      write: (data) => this.inputPump.enqueue(data),
    });
  }

  private applySettings(settings: TerminalSettings, theme: AppearanceTheme) {
    this.terminal.options.theme = resolveTerminalTheme(settings.colorScheme, theme);
    this.terminal.options.fontFamily = terminalFontStack(settings);
    this.terminal.options.fontSize = settings.fontSize;
    this.terminal.options.fontWeight = settings.fontWeight;
    this.terminal.options.lineHeight = settings.lineHeight;
    this.terminal.options.cursorStyle = settings.cursorStyle;
    this.terminal.options.cursorBlink = settings.cursorBlink;
    this.terminal.options.scrollback = settings.scrollback;
    this.highlighter.setRules(activeHighlightRules(settings));
  }

  private enqueueOutput(encodedData: string) {
    if (this.disposed) return;
    try {
      const data = decodeBase64(encodedData);
      this.pendingOutput.push(data);
      this.pendingOutputBytes += data.byteLength;
      if (this.pendingOutputBytes >= MAX_PENDING_OUTPUT_BYTES) {
        this.flushOutput();
        return;
      }
      if (this.outputFrame !== undefined) return;
      this.outputFrame = requestAnimationFrame(() => {
        this.outputFrame = undefined;
        this.flushOutput();
      });
    } catch (error) {
      this.setViewMessage(`终端输出解析失败：${String(error)}`);
    }
  }

  private flushOutput() {
    if (this.disposed || this.pendingOutputBytes === 0) return;
    const combined = new Uint8Array(this.pendingOutputBytes);
    let offset = 0;
    for (const chunk of this.pendingOutput) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    const text = this.outputDecoder.decode(combined, { stream: true });
    this.terminal.write(this.highlighter.write(text));
  }

  private handleClipboardKey(event: KeyboardEvent) {
    const action = resolveTerminalClipboardAction(event, this.terminal.hasSelection());
    if (!action) return true;
    if (action === "copy") {
      if (!navigator.clipboard?.writeText) return true;
      event.preventDefault();
      event.stopPropagation();
      const selection = this.terminal.getSelection();
      if (selection) {
        void navigator.clipboard.writeText(selection).catch(() => undefined);
        this.terminal.clearSelection();
      }
    } else {
      if (!navigator.clipboard?.readText) return true;
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.readText().then((text) => {
        if (text) this.terminal.paste(text);
      }).catch(() => undefined);
    }
    return false;
  }

  private moveTerminalTo(container: HTMLElement) {
    const element = this.terminal.element;
    if (element && element.parentElement !== container) container.appendChild(element);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

function connectionTypeFor(definition: TerminalSessionDefinition): TerminalConnectionType {
  return definition.sessionType === "local" ? "local" : definition.sessionType;
}

function createRequestFor(
  definition: TerminalSessionDefinition,
  sessionId: string,
  size: TerminalSize,
): TerminalCreateRequest {
  if (definition.sessionType === "local") {
    return { kind: "local", sessionId, profile: definition.profileId, ...size };
  }
  if (definition.sessionType === "telnet") {
    const { host, port, username, password } = definition.connection;
    return { kind: "telnet", sessionId, host, port, username, password, ...size };
  }
  const { portName, baudRate, dataBits, stopBits, parity, flowControl } = definition.connection;
  return { kind: "serial", sessionId, portName, baudRate, dataBits, stopBits, parity, flowControl };
}

function activeHighlightRules(settings: TerminalSettings) {
  return settings.highlightSets.find(
    (set) => set.id === settings.activeHighlightSetId && set.enabled,
  )?.rules ?? [];
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
