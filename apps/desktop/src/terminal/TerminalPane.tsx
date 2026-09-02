import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AppearanceTheme, TerminalSettings } from "../settings/types";
import type { LocalTerminalProfileId } from "./profiles";
import { resolveTerminalClipboardAction } from "./clipboard";
import { TerminalHighlightStream } from "./highlighting";
import { resolveTerminalTheme } from "./themes";
import type { SerialConnection, TelnetConnection } from "../connections/types";
import type { TerminalInputTarget } from "./useSynchronizedInput";
import { terminalFontStack } from "./fontStack";
import {
  TerminalRuntimeController,
  type TerminalConnectionStateEvent,
} from "./TerminalRuntimeController";

interface TerminalPaneCommonProps {
  active: boolean;
  connectionId?: string;
  paneId?: string;
  synchronizedInput: boolean;
  tabId: string;
  settings: TerminalSettings;
  theme: AppearanceTheme;
  onInput: (tabId: string, data: string) => void;
  onActivate: () => void;
  registerInputTarget: (tabId: string, target: TerminalInputTarget) => () => void;
}

type TerminalSessionProps =
  | { sessionType: "local"; profileId: LocalTerminalProfileId }
  | { sessionType: "telnet"; connection: TelnetConnection }
  | { sessionType: "serial"; connection: SerialConnection };

type TerminalPaneProps = TerminalPaneCommonProps & TerminalSessionProps;

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function TerminalPane(props: TerminalPaneProps) {
  const { active, settings, theme } = props;
  const profileId = props.sessionType === "local" ? props.profileId : null;
  const sessionConnection = props.sessionType === "local" ? null : props.connection;
  const commandPrefix = terminalCommandPrefix(props.sessionType);
  const eventPrefix = commandPrefix;
  const supportsResize = props.sessionType !== "serial";
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const runtimeControllerRef = useRef<TerminalRuntimeController | null>(null);
  const sessionReadyRef = useRef(false);
  const ptySessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const onInputRef = useRef(props.onInput);
  const registerInputTargetRef = useRef(props.registerInputTarget);
  const activeHighlightRules = settings.highlightSets.find(
    (set) => set.id === settings.activeHighlightSetId && set.enabled,
  )?.rules ?? [];
  const highlighterRef = useRef(new TerminalHighlightStream(activeHighlightRules));
  const [status, setStatus] = useState<"starting" | "ready" | "closing" | "closed" | "error">("starting");
  const [errorMessage, setErrorMessage] = useState("");

  activeRef.current = active;
  onInputRef.current = props.onInput;
  registerInputTargetRef.current = props.registerInputTarget;

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(settings.colorScheme, theme);
    }
  }, [settings.colorScheme, theme]);

  useEffect(() => {
    highlighterRef.current.setRules(activeHighlightRules);
  }, [activeHighlightRules]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    terminal.options.fontFamily = terminalFontStack(settings);
    terminal.options.fontSize = settings.fontSize;
    terminal.options.fontWeight = settings.fontWeight;
    terminal.options.lineHeight = settings.lineHeight;
    terminal.options.cursorStyle = settings.cursorStyle;
    terminal.options.cursorBlink = settings.cursorBlink;
    terminal.options.scrollback = settings.scrollback;

    if (active) {
      runtimeControllerRef.current?.resize();
    }
  }, [active, commandPrefix, settings, supportsResize]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      runtimeControllerRef.current?.resize();
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, commandPrefix, supportsResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      fontFamily: terminalFontStack(settings),
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      lineHeight: settings.lineHeight,
      scrollback: settings.scrollback,
      theme: resolveTerminalTheme(settings.colorScheme, theme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let outputFrame: number | undefined;
    let pendingOutput: Uint8Array[] = [];
    let pendingOutputLength = 0;
    const outputDecoder = new TextDecoder();
    let writeQueue = Promise.resolve();
    const enqueueOutput = (data: Uint8Array) => {
      pendingOutput.push(data);
      pendingOutputLength += data.length;
      if (outputFrame !== undefined) return;
      outputFrame = requestAnimationFrame(() => {
        outputFrame = undefined;
        const combined = new Uint8Array(pendingOutputLength);
        let offset = 0;
        for (const chunk of pendingOutput) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        pendingOutput = [];
        pendingOutputLength = 0;
        if (!disposed) {
          const text = outputDecoder.decode(combined, { stream: true });
          terminal.write(highlighterRef.current.write(text));
        }
      });
    };
    const writeInput = (data: string) => {
      if (!sessionReadyRef.current) return;
      writeQueue = writeQueue
        .then(async () => {
          if (!disposed && sessionReadyRef.current) {
            const sessionId = ptySessionIdRef.current;
            if (sessionId) await invoke(`write_${commandPrefix}`, { sessionId, data });
          }
        })
        .catch((error) => {
          if (!disposed) {
            setStatus("error");
            setErrorMessage(String(error));
          }
        });
    };
    const unregisterInputTarget = registerInputTargetRef.current(props.tabId, {
      focus: () => terminal.focus(),
      write: writeInput,
    });
    const inputSubscription = terminal.onData((data) => onInputRef.current(props.tabId, data));
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const action = resolveTerminalClipboardAction(event, terminal.hasSelection());
      if (!action) return true;

      if (action === "copy") {
        if (!navigator.clipboard?.writeText) return true;
        event.preventDefault();
        event.stopPropagation();
        const selection = terminal.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection).catch(() => undefined);
          terminal.clearSelection();
        }
      } else {
        if (!navigator.clipboard?.readText) return true;
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.readText().then((text) => {
          if (text) terminal.paste(text);
        }).catch(() => undefined);
      }
      return false;
    });

    const controller = new TerminalRuntimeController({
      commandPrefix,
      eventPrefix,
      container,
      supportsResize,
      isActive: () => activeRef.current,
      fit: () => fitAddon.fit(),
      getTerminalSize: () => ({ columns: terminal.cols, rows: terminal.rows }),
      createArguments: (sessionId, size) => terminalCreateArguments(props, sessionId, size.columns, size.rows),
      onOutput: (data) => enqueueOutput(decodeBase64(data)),
      onStateChange: (event) => {
        applyConnectionState(event, props, setStatus, setErrorMessage, sessionReadyRef);
      },
      onReady: (sessionId) => {
        ptySessionIdRef.current = sessionId;
        container.closest<HTMLElement>(".terminal-pane")?.setAttribute("data-session-id", sessionId);
        terminal.focus();
      },
      onError: (error) => {
        if (!disposed) {
          setStatus("error");
          setErrorMessage(String(error));
        }
      },
    });
    runtimeControllerRef.current = controller;
    ptySessionIdRef.current = controller.id;
    container.closest<HTMLElement>(".terminal-pane")?.setAttribute("data-session-id", controller.id);
    controller.start();

    return () => {
      disposed = true;
      sessionReadyRef.current = false;
      if (outputFrame !== undefined) cancelAnimationFrame(outputFrame);
      pendingOutput = [];
      controller.dispose();
      inputSubscription.dispose();
      unregisterInputTarget();
      terminal.dispose();
      if (runtimeControllerRef.current === controller) runtimeControllerRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      container.closest<HTMLElement>(".terminal-pane")?.removeAttribute("data-session-id");
      if (ptySessionIdRef.current === controller.id) ptySessionIdRef.current = null;
    };
    // Visual settings intentionally update without replacing the running PTY session.
  }, [
    commandPrefix,
    eventPrefix,
    profileId,
    sessionConnection,
    supportsResize,
  ]);

  return (
    <section
      className="terminal-pane workspace-view"
      aria-label={terminalAriaLabel(props)}
      aria-hidden={!active}
      data-active={active}
      data-connection-id={props.connectionId}
      data-pane-id={props.paneId}
      data-session-id={ptySessionIdRef.current ?? undefined}
      data-synchronized={props.synchronizedInput}
      data-tab-id={props.tabId}
    >
      <div
        className="terminal-container"
        onPointerDown={() => {
          props.onActivate();
          terminalRef.current?.focus();
        }}
        ref={containerRef}
      />
      {props.synchronizedInput && (
        <div className="terminal-sync-indicator" aria-label="此终端已加入同步输入">
          <SyncInputIcon />
          <span>同步输入</span>
        </div>
      )}
      {status !== "ready" && (
        <div className="terminal-state" data-status={status}>
          {terminalStatusText(props, status, errorMessage)}
        </div>
      )}
    </section>
  );
}

function SyncInputIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 5.25h6.5M7.5 3.25l2 2-2 2M13 10.75H6.5M8.5 8.75l-2 2 2 2" />
    </svg>
  );
}

function terminalCommandPrefix(sessionType: TerminalSessionProps["sessionType"]) {
  if (sessionType === "local") return "terminal";
  return sessionType;
}

function terminalCreateArguments(props: TerminalSessionProps, sessionId: string, columns: number, rows: number) {
  if (props.sessionType === "local") return { sessionId, profile: props.profileId, columns, rows };
  if (props.sessionType === "telnet") {
    const { host, port, username, password } = props.connection;
    return { sessionId, host, port, username, password, columns, rows };
  }
  const { portName, baudRate, dataBits, stopBits, parity, flowControl } = props.connection;
  return { sessionId, portName, baudRate, dataBits, stopBits, parity, flowControl };
}

function terminalAriaLabel(props: TerminalSessionProps) {
  if (props.sessionType === "local") return "本地终端";
  if (props.sessionType === "serial") return `串口 ${props.connection.portName}`;
  return `${props.sessionType.toUpperCase()} ${props.connection.host}`;
}

function terminalStatusText(
  props: TerminalSessionProps,
  status: "starting" | "ready" | "closing" | "closed" | "error",
  errorMessage: string,
) {
  const protocol = props.sessionType === "local" ? "终端" : props.sessionType === "serial" ? "串口" : props.sessionType.toUpperCase();
  if (status === "error") return errorMessage || `${protocol}连接失败`;
  if (status === "closed") return props.sessionType === "local" ? "终端已关闭" : `${protocol}连接已关闭`;
  if (status === "closing") return props.sessionType === "local" ? "正在关闭终端…" : `正在关闭${protocol}连接…`;
  if (status === "ready") return "";
  if (props.sessionType === "local") return "正在启动终端…";
  if (props.sessionType === "serial") return `正在打开 ${props.connection.portName}…`;
  return `正在连接 ${props.connection.host}:${props.connection.port}…`;
}

function applyConnectionState(
  event: TerminalConnectionStateEvent,
  props: TerminalSessionProps,
  setStatus: (status: "starting" | "ready" | "closing" | "closed" | "error") => void,
  setErrorMessage: (message: string) => void,
  sessionReadyRef: { current: boolean },
) {
  switch (event.state) {
    case "connecting":
      sessionReadyRef.current = false;
      setStatus("starting");
      return;
    case "connected":
      sessionReadyRef.current = true;
      setErrorMessage("");
      setStatus("ready");
      return;
    case "closing":
      sessionReadyRef.current = false;
      setStatus("closing");
      return;
    case "disconnected":
      sessionReadyRef.current = false;
      setStatus("closed");
      return;
    case "failed":
      sessionReadyRef.current = false;
      setErrorMessage(event.message || connectionFailureText(props, event.reason));
      setStatus("error");
      return;
  }
}

function connectionFailureText(
  props: TerminalSessionProps,
  reason: TerminalConnectionStateEvent["reason"],
) {
  const protocol = props.sessionType === "local" ? "终端" : props.sessionType === "serial" ? "串口" : "Telnet";
  switch (reason) {
    case "connectionFailed":
      return `${protocol}连接失败`;
    case "readFailed":
      return `${protocol}读取失败`;
    case "writeFailed":
      return `${protocol}写入失败`;
    case "deviceDisconnected":
      return `${protocol}设备已断开`;
    case "timeout":
      return `${protocol}连接超时`;
    case "protocolError":
      return `${protocol}协议错误`;
    default:
      return `${protocol}连接失败`;
  }
}
