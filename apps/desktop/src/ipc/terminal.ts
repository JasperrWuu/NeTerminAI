import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invalidResponse, normalizeIpcError } from "./errors";
import { createCommandArguments, decodeOutputEvent } from "./validation";
import type {
  TerminalCloseRequest,
  TerminalConnectionType,
  TerminalCreateRequest,
  TerminalOutputEvent,
  TerminalResizeRequest,
  TerminalWriteRequest,
} from "./types";

const COMMANDS = {
  create: { local: "create_terminal", telnet: "create_telnet", serial: "create_serial" },
  write: { local: "write_terminal", telnet: "write_telnet", serial: "write_serial" },
  resize: { local: "resize_terminal", telnet: "resize_telnet" },
  close: { local: "close_terminal", telnet: "close_telnet", serial: "close_serial" },
} as const;

const OUTPUT_EVENTS = {
  local: "terminal:output",
  telnet: "telnet:output",
  serial: "serial:output",
} as const;

type Unlisten = () => void;

export const terminalApi = {
  create(request: TerminalCreateRequest) {
    return invokeCommand<void>(COMMANDS.create[request.kind], createCommandArguments(request));
  },

  write(request: TerminalWriteRequest) {
    return invokeCommand<void>(COMMANDS.write[request.kind], {
      sessionId: request.sessionId,
      data: request.data,
    });
  },

  resize(request: TerminalResizeRequest) {
    if (request.kind === "serial") {
      return Promise.reject(invalidResponse("串口终端不支持尺寸调整"));
    }
    return invokeCommand<void>(COMMANDS.resize[request.kind], {
      sessionId: request.sessionId,
      columns: request.size.columns,
      rows: request.size.rows,
    });
  },

  close(request: TerminalCloseRequest) {
    return invokeCommand<void>(COMMANDS.close[request.kind], { sessionId: request.sessionId });
  },

  subscribeOutput(
    kind: TerminalConnectionType,
    onEvent: (event: TerminalOutputEvent) => void,
  ): Promise<Unlisten> {
    return listen<unknown>(OUTPUT_EVENTS[kind], ({ payload }) => {
      const event = decodeOutputEvent(payload);
      if (event) onEvent(event);
    }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },
};

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeIpcError(error);
  }
}
