import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { AppearanceTheme, TerminalSettings } from "../settings/types";
import type { LocalTerminalProfileId } from "./profiles";
import type { SerialConnection, TelnetConnection } from "../connections/types";
import {
  TerminalSessionRuntime,
  type TerminalSessionDefinition,
  type TerminalSessionRuntimeSnapshot,
} from "./TerminalSessionRuntime";
import type { TerminalSessionRegistry } from "./TerminalSessionRegistry";

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
  registerInputTarget: (tabId: string, target: import("./useSynchronizedInput").TerminalInputTarget) => () => void;
  runtimeRegistry: TerminalSessionRegistry;
}

type TerminalSessionProps =
  | { sessionType: "local"; profileId: LocalTerminalProfileId }
  | { sessionType: "telnet"; connection: TelnetConnection }
  | { sessionType: "serial"; connection: SerialConnection };

type TerminalPaneProps = TerminalPaneCommonProps & TerminalSessionProps;

type TerminalPaneStatus = "starting" | "ready" | "closing" | "closed" | "error";

export function TerminalPane(props: TerminalPaneProps) {
  const { active, settings, theme } = props;
  const profileId = props.sessionType === "local" ? props.profileId : null;
  const sessionConnection = props.sessionType === "local" ? null : props.connection;
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<TerminalSessionRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<TerminalSessionRuntimeSnapshot | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const runtime = props.runtimeRegistry.acquire(
      props.tabId,
      terminalSessionDefinition(props),
      {
        container,
        active,
        settings,
        theme,
        onInput: (data) => props.onInput(props.tabId, data),
        registerInputTarget: props.registerInputTarget,
      },
    );
    runtimeRef.current = runtime;
    setSnapshot(runtime.getSnapshot());
    const unsubscribe = runtime.subscribe(() => setSnapshot(runtime.getSnapshot()));
    return () => {
      unsubscribe();
      props.runtimeRegistry.releaseView(props.tabId, container);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [
    profileId,
    props.onInput,
    props.registerInputTarget,
    props.runtimeRegistry,
    props.sessionType,
    props.tabId,
    sessionConnection,
  ]);

  useEffect(() => {
    runtimeRef.current?.updateView({
      active,
      settings,
      theme,
      onInput: (data) => props.onInput(props.tabId, data),
      registerInputTarget: props.registerInputTarget,
    });
  }, [active, props.onInput, props.registerInputTarget, props.tabId, settings, theme]);

  const status = toPaneStatus(snapshot?.state ?? "connecting");
  const errorMessage = snapshot?.message ?? "";

  return (
    <section
      className="terminal-pane workspace-view"
      aria-label={terminalAriaLabel(props)}
      aria-hidden={!active}
      data-active={active}
      data-connection-id={props.connectionId}
      data-pane-id={props.paneId}
      data-session-id={snapshot?.sessionId}
      data-synchronized={props.synchronizedInput}
      data-tab-id={props.tabId}
    >
      <div
        className="terminal-container"
        onPointerDown={() => {
          props.onActivate();
          runtimeRef.current?.focus();
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

function terminalSessionDefinition(props: TerminalSessionProps): TerminalSessionDefinition {
  if (props.sessionType === "local") return { sessionType: "local", profileId: props.profileId };
  if (props.sessionType === "telnet") return { sessionType: "telnet", connection: props.connection };
  return { sessionType: "serial", connection: props.connection };
}

function toPaneStatus(state: TerminalSessionRuntimeSnapshot["state"]): TerminalPaneStatus {
  switch (state) {
    case "connected": return "ready";
    case "closing": return "closing";
    case "disconnected": return "closed";
    case "failed": return "error";
    default: return "starting";
  }
}

function SyncInputIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 5.25h6.5M7.5 3.25l2 2-2 2M13 10.75H6.5M8.5 8.75l-2 2 2 2" />
    </svg>
  );
}

function terminalAriaLabel(props: TerminalSessionProps) {
  if (props.sessionType === "local") return "本地终端";
  if (props.sessionType === "serial") return `串口 ${props.connection.portName}`;
  return `TELNET ${props.connection.host}`;
}

function terminalStatusText(
  props: TerminalSessionProps,
  status: TerminalPaneStatus,
  errorMessage: string,
) {
  const protocol = props.sessionType === "local" ? "终端" : props.sessionType === "serial" ? "串口" : "Telnet";
  if (status === "error") return errorMessage || `${protocol}连接失败`;
  if (status === "closed") return props.sessionType === "local" ? "终端已关闭" : `${protocol}连接已关闭`;
  if (status === "closing") return props.sessionType === "local" ? "正在关闭终端…" : `正在关闭${protocol}连接…`;
  if (status === "ready") return "";
  if (props.sessionType === "local") return "正在启动终端…";
  if (props.sessionType === "serial") return `正在打开 ${props.connection.portName}…`;
  return `正在连接 ${props.connection.host}:${props.connection.port}…`;
}
