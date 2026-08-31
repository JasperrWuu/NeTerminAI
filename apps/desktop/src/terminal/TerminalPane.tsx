import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AppearanceTheme, TerminalSettings } from "../settings/types";
import type { LocalTerminalProfileId } from "./profiles";
import { resolveTerminalTheme } from "./themes";
import type { SerialConnection, TelnetConnection } from "../connections/types";

interface TerminalPaneCommonProps {
  active: boolean;
  settings: TerminalSettings;
  theme: AppearanceTheme;
}

type TerminalPaneProps = TerminalPaneCommonProps & (
  | { sessionType: "local"; profileId: LocalTerminalProfileId }
  | { sessionType: "telnet"; connection: TelnetConnection }
  | { sessionType: "serial"; connection: SerialConnection }
);

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
  const isTelnet = props.sessionType === "telnet";
  const isSerial = props.sessionType === "serial";
  const telnetConnection = isTelnet ? props.connection : null;
  const serialConnection = isSerial ? props.connection : null;
  const remoteHost = telnetConnection?.host ?? "";
  const remotePort = telnetConnection?.port ?? 23;
  const remoteUsername = telnetConnection?.username ?? "";
  const remotePassword = telnetConnection?.password ?? "";
  const serialPortName = serialConnection?.portName ?? "";
  const profileId = props.sessionType === "local" ? props.profileId : null;
  const commandPrefix = isTelnet ? "telnet" : isSerial ? "serial" : "terminal";
  const eventPrefix = commandPrefix;
  const supportsResize = !isSerial;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionReadyRef = useRef(false);
  const ptySessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const [status, setStatus] = useState<"starting" | "ready" | "closed" | "error">("starting");
  const [errorMessage, setErrorMessage] = useState("");

  activeRef.current = active;

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(settings.colorScheme, theme);
    }
  }, [settings.colorScheme, theme]);

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
        if (!disposed) terminal.write(combined);
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
    const inputSubscription = terminal.onData((data) => {
      if (!sessionReadyRef.current) return;
      void invoke(`write_${commandPrefix}`, { sessionId, data }).catch((error) => {
        setStatus("error");
        setErrorMessage(String(error));
      });
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
        const createArguments = isTelnet ? {
              sessionId,
              host: remoteHost,
              port: remotePort,
              username: remoteUsername,
              password: remotePassword,
              columns: terminal.cols,
              rows: terminal.rows,
            }
          : isSerial ? {
              sessionId,
              portName: serialPortName,
              baudRate: serialConnection?.baudRate ?? 9600,
              dataBits: serialConnection?.dataBits ?? 8,
              stopBits: serialConnection?.stopBits ?? 1,
              parity: serialConnection?.parity ?? "none",
              flowControl: serialConnection?.flowControl ?? "none",
            }
          : { sessionId, profile: profileId, columns: terminal.cols, rows: terminal.rows };
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
    isTelnet,
    isSerial,
    profileId,
    remoteHost,
    remotePassword,
    remotePort,
    remoteUsername,
    serialConnection?.baudRate,
    serialConnection?.dataBits,
    serialConnection?.flowControl,
    serialConnection?.parity,
    serialConnection?.stopBits,
    serialPortName,
    supportsResize,
  ]);

  return (
    <section
      className="terminal-pane workspace-view"
      aria-label={isTelnet ? `Telnet ${remoteHost}` : isSerial ? `串口 ${serialPortName}` : "本地终端"}
      aria-hidden={!active}
      data-active={active}
    >
      <div className="terminal-container" onPointerDown={() => terminalRef.current?.focus()} ref={containerRef} />
      {status !== "ready" && (
        <div className="terminal-state" data-status={status}>
          {status === "starting" && (isTelnet ? `正在连接 ${remoteHost}:${remotePort}…` : isSerial ? `正在打开 ${serialPortName}…` : "正在启动终端…")}
          {status === "closed" && (isTelnet ? "Telnet 连接已关闭" : isSerial ? "串口连接已关闭" : "终端已关闭")}
          {status === "error" && (errorMessage || (isTelnet ? "Telnet 连接失败" : isSerial ? "串口连接失败" : "终端启动失败"))}
        </div>
      )}
    </section>
  );
}
