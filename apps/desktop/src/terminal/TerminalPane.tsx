import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AppearanceTheme, TerminalSettings } from "../settings/types";
import type { LocalTerminalProfileId } from "./profiles";
import { resolveTerminalClipboardAction } from "./clipboard";
import { applyTerminalHighlights, compileTerminalHighlightRules } from "./highlighting";
import { resolveTerminalTheme } from "./themes";
import type { SerialConnection, SshConnection, TelnetConnection } from "../connections/types";

interface TerminalPaneCommonProps {
  active: boolean;
  settings: TerminalSettings;
  theme: AppearanceTheme;
}

type TerminalSessionProps =
  | { sessionType: "local"; profileId: LocalTerminalProfileId }
  | { sessionType: "telnet"; connection: TelnetConnection }
  | { sessionType: "serial"; connection: SerialConnection }
  | { sessionType: "ssh"; connection: SshConnection };

type TerminalPaneProps = TerminalPaneCommonProps & TerminalSessionProps;

interface TerminalOutput { sessionId: string; data: string; }
interface TerminalExit { sessionId: string; }

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
  const sessionReadyRef = useRef(false);
  const ptySessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const highlightRulesRef = useRef(compileTerminalHighlightRules(settings.highlightRules));
  const [status, setStatus] = useState<"starting" | "ready" | "closed" | "error">("starting");
  const [errorMessage, setErrorMessage] = useState("");

  activeRef.current = active;

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(settings.colorScheme, theme);
    }
  }, [settings.colorScheme, theme]);

  useEffect(() => {
    highlightRulesRef.current = compileTerminalHighlightRules(settings.highlightRules);
  }, [settings.highlightRules]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.fontWeight = settings.fontWeight;
    terminal.options.lineHeight = settings.lineHeight;
    terminal.options.cursorStyle = settings.cursorStyle;
    terminal.options.cursorBlink = settings.cursorBlink;
    terminal.options.scrollback = settings.scrollback;

    if (active) {
      fitAddon.fit();
      const sessionId = ptySessionIdRef.current;
      if (supportsResize && sessionReadyRef.current && sessionId) {
        void invoke(`resize_${commandPrefix}`, { sessionId, columns: terminal.cols, rows: terminal.rows });
      }
    }
  }, [active, commandPrefix, settings, supportsResize]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) return;
      fitAddon.fit();
      terminal.focus();
      const sessionId = ptySessionIdRef.current;
      if (supportsResize && sessionReadyRef.current && sessionId) {
        void invoke(`resize_${commandPrefix}`, { sessionId, columns: terminal.cols, rows: terminal.rows });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, commandPrefix, supportsResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sessionId = crypto.randomUUID();
    ptySessionIdRef.current = sessionId;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      fontFamily: settings.fontFamily,
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
    let sessionEnded = false;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let outputFrame: number | undefined;
    let resizeFrame: number | undefined;
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
          terminal.write(applyTerminalHighlights(text, highlightRulesRef.current));
        }
      });
    };
    const resize = () => {
      resizeFrame = undefined;
      if (disposed || !activeRef.current) return;
      fitAddon.fit();
      if (supportsResize && sessionReadyRef.current) {
        void invoke(`resize_${commandPrefix}`, { sessionId, columns: terminal.cols, rows: terminal.rows });
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame === undefined) resizeFrame = requestAnimationFrame(resize);
    });
    resizeObserver.observe(container);
    const writeInput = (data: string) => {
      if (!sessionReadyRef.current) return;
      writeQueue = writeQueue
        .then(async () => {
          if (!disposed && sessionReadyRef.current) {
            await invoke(`write_${commandPrefix}`, { sessionId, data });
          }
        })
        .catch((error) => {
          if (!disposed) {
            setStatus("error");
            setErrorMessage(String(error));
          }
        });
    };
    const inputSubscription = terminal.onData(writeInput);
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

    const start = async () => {
      try {
        fitAddon.fit();
        unlistenOutput = await listen<TerminalOutput>(`${eventPrefix}:output`, ({ payload }) => {
          if (payload.sessionId === sessionId) enqueueOutput(decodeBase64(payload.data));
        });
        unlistenExit = await listen<TerminalExit>(`${eventPrefix}:exit`, ({ payload }) => {
          if (payload.sessionId === sessionId && !disposed) {
            sessionEnded = true;
            sessionReadyRef.current = false;
            setStatus("closed");
          }
        });
        const createArguments = terminalCreateArguments(props, sessionId, terminal.cols, terminal.rows);
        await invoke(`create_${commandPrefix}`, createArguments);
        if (disposed) {
          await invoke(`close_${commandPrefix}`, { sessionId });
          return;
        }
        if (sessionEnded) return;
        sessionReadyRef.current = true;
        setStatus("ready");
        terminal.focus();
      } catch (error) {
        if (!disposed) {
          setStatus("error");
          setErrorMessage(String(error));
        }
      }
    };
    void start();

    return () => {
      disposed = true;
      sessionReadyRef.current = false;
      resizeObserver.disconnect();
      if (outputFrame !== undefined) cancelAnimationFrame(outputFrame);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      pendingOutput = [];
      inputSubscription.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (ptySessionIdRef.current === sessionId) ptySessionIdRef.current = null;
      void invoke(`close_${commandPrefix}`, { sessionId });
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
    >
      <div className="terminal-container" onPointerDown={() => terminalRef.current?.focus()} ref={containerRef} />
      {status !== "ready" && (
        <div className="terminal-state" data-status={status}>
          {terminalStatusText(props, status, errorMessage)}
        </div>
      )}
    </section>
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
  if (props.sessionType === "ssh") {
    const { host, port, username, identityFile } = props.connection;
    return { sessionId, host, port, username, identityFile, columns, rows };
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
  status: "starting" | "ready" | "closed" | "error",
  errorMessage: string,
) {
  const protocol = props.sessionType === "local" ? "终端" : props.sessionType === "serial" ? "串口" : props.sessionType.toUpperCase();
  if (status === "error") return errorMessage || `${protocol}连接失败`;
  if (status === "closed") return props.sessionType === "local" ? "终端已关闭" : `${protocol}连接已关闭`;
  if (status === "ready") return "";
  if (props.sessionType === "local") return "正在启动终端…";
  if (props.sessionType === "serial") return `正在打开 ${props.connection.portName}…`;
  return `正在连接 ${props.connection.host}:${props.connection.port}…`;
}
