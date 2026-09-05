import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors.ts";
import type { AiProcessResult } from "../ai/providers/types";

export interface AiProcessRequest {
  requestId: string;
  executable: string;
  args: string[];
  cwd?: string;
  stdin: string;
  timeoutMs: number;
}

export interface AiProcessOutputEvent {
  requestId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export const aiProcessApi = {
  async run(request: AiProcessRequest): Promise<AiProcessResult> {
    try {
      const result = await invoke<unknown>("run_ai_process", {
        request: {
          requestId: request.requestId,
          executable: request.executable,
          args: request.args,
          cwd: request.cwd || null,
          stdin: request.stdin,
          timeoutMs: request.timeoutMs,
        },
      });
      return decodeResult(result);
    } catch (error) {
      throw normalizeIpcError(error);
    }
  },

  async cancel(requestId: string): Promise<void> {
    try {
      await invoke("cancel_ai_process", { requestId });
    } catch (error) {
      throw normalizeIpcError(error);
    }
  },

  subscribeOutput(requestId: string, onEvent: (event: AiProcessOutputEvent) => void): Promise<() => void> {
    return listen<unknown>("ai:output", ({ payload }) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as Record<string, unknown>;
      if (value.requestId !== requestId || (value.stream !== "stdout" && value.stream !== "stderr") || typeof value.data !== "string") return;
      onEvent({ requestId, stream: value.stream, data: value.data });
    }).catch((error: unknown) => { throw normalizeIpcError(error); });
  },
};

function decodeResult(value: unknown): AiProcessResult {
  if (!value || typeof value !== "object") throw normalizeIpcError("AI 进程返回格式无效");
  const result = value as Record<string, unknown>;
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw normalizeIpcError("AI 进程返回格式无效");
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    cancelled: result.cancelled === true,
    timedOut: result.timedOut === true,
  };
}
