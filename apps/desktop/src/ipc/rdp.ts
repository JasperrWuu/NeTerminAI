import { invoke } from "@tauri-apps/api/core";
import { invalidResponse, normalizeIpcError } from "./errors";

export interface RdpBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RdpCreateRequest {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  adminSession: boolean;
  bounds: RdpBounds;
}

export type RdpRuntimeState = "initializing" | "connecting" | "connected" | "disconnected";

export interface RdpRuntimeStatus {
  state: RdpRuntimeState;
  disconnectReason: string | null;
  focused: boolean;
}

const COMMANDS = {
  create: "create_rdp",
  resize: "resize_rdp",
  status: "get_rdp_status",
  focus: "focus_rdp",
  close: "close_rdp",
} as const;

export const rdpApi = {
  create(request: RdpCreateRequest) {
    return invokeCommand<void>(COMMANDS.create, { ...request });
  },

  resize(sessionId: string, bounds: RdpBounds, visible: boolean) {
    return invokeCommand<void>(COMMANDS.resize, { sessionId, bounds, visible });
  },

  status(sessionId: string) {
    return invokeCommand<unknown>(COMMANDS.status, { sessionId }).then(decodeRuntimeStatus);
  },

  focus(sessionId: string) {
    return invokeCommand<void>(COMMANDS.focus, { sessionId });
  },

  close(sessionId: string) {
    return invokeCommand<void>(COMMANDS.close, { sessionId });
  },
};

async function invokeCommand<T>(command: string, args: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeIpcError(error);
  }
}

function decodeRuntimeStatus(value: unknown): RdpRuntimeStatus {
  if (!isRecord(value)
    || !isRuntimeState(value.state)
    || (value.disconnectReason !== null && typeof value.disconnectReason !== "string")
    || typeof value.focused !== "boolean") {
    throw invalidResponse("RDP 状态格式无效");
  }
  return {
    state: value.state,
    disconnectReason: value.disconnectReason,
    focused: value.focused,
  };
}

function isRuntimeState(value: unknown): value is RdpRuntimeState {
  return value === "initializing"
    || value === "connecting"
    || value === "connected"
    || value === "disconnected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
