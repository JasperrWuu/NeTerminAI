import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors.ts";
import type { TerminalConnectionType } from "./types.ts";

export type AutomationSessionRunStatus = "pending" | "running" | "success" | "error" | "cancelled";
export type AutomationOutputStream = "stdout" | "stderr";

export interface AutomationTargetRequest {
  tabId: string;
  sessionId: string | null;
  connectionType: TerminalConnectionType;
}

export interface AutomationRunRequest {
  runId: string;
  scriptId: string;
  code: string;
  targets: readonly AutomationTargetRequest[];
}

export interface AutomationStatusEvent {
  runId: string;
  scriptId: string;
  tabId: string;
  sessionId: string | null;
  status: AutomationSessionRunStatus;
  message?: string;
}

export interface AutomationOutputEvent {
  runId: string;
  scriptId: string;
  tabId: string;
  sessionId: string | null;
  stream: AutomationOutputStream;
  data: string;
}

type Unlisten = () => void;

export const automationApi = {
  start(request: AutomationRunRequest) {
    return invoke<void>("start_automation", { request: toBackendRequest(request) }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },

  stop(runId: string) {
    return invoke<void>("stop_automation", { runId }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },

  subscribeStatus(onEvent: (event: AutomationStatusEvent) => void): Promise<Unlisten> {
    return listen<unknown>("automation:status", ({ payload }) => {
      const event = decodeAutomationStatusEvent(payload);
      if (event) onEvent(event);
    }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },

  subscribeOutput(onEvent: (event: AutomationOutputEvent) => void): Promise<Unlisten> {
    return listen<unknown>("automation:output", ({ payload }) => {
      const event = decodeAutomationOutputEvent(payload);
      if (event) onEvent(event);
    }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },
};

export function decodeAutomationStatusEvent(value: unknown): AutomationStatusEvent | null {
  if (!isRecord(value)
    || typeof value.runId !== "string"
    || typeof value.scriptId !== "string"
    || typeof value.tabId !== "string"
    || !isAutomationStatus(value.status)) return null;
  return {
    runId: value.runId,
    scriptId: value.scriptId,
    tabId: value.tabId,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    status: value.status,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

export function decodeAutomationOutputEvent(value: unknown): AutomationOutputEvent | null {
  if (!isRecord(value)
    || typeof value.runId !== "string"
    || typeof value.scriptId !== "string"
    || typeof value.tabId !== "string"
    || typeof value.data !== "string"
    || !isAutomationOutputStream(value.stream)) return null;
  return {
    runId: value.runId,
    scriptId: value.scriptId,
    tabId: value.tabId,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    stream: value.stream,
    data: value.data,
  };
}

function toBackendRequest(request: AutomationRunRequest) {
  return {
    runId: request.runId,
    scriptId: request.scriptId,
    code: request.code,
    targets: request.targets.map((target) => ({
      tabId: target.tabId,
      sessionId: target.sessionId,
      connectionType: target.connectionType,
    })),
  };
}

function isAutomationStatus(value: unknown): value is AutomationSessionRunStatus {
  return value === "pending"
    || value === "running"
    || value === "success"
    || value === "error"
    || value === "cancelled";
}

function isAutomationOutputStream(value: unknown): value is AutomationOutputStream {
  return value === "stdout" || value === "stderr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
