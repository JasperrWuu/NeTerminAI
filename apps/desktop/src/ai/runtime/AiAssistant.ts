import { TerminalActionExecutor } from "../actions/TerminalActionExecutor.ts";
import type { ContextAnalysisResult } from "../analysis/types.ts";
import type { AiConversationMessage, AiProvider } from "../providers/types.ts";
import type { MultiSessionContextAssembly } from "../processing/types.ts";
import { ContextProcessingPipeline } from "../processing/contextPipeline.ts";
import type {
  ContextSelection,
  TerminalContextCapability,
  TerminalInputCapability,
} from "../../capabilities/terminal";
import type {
  ProjectContext,
  ProjectContextCapability,
  ProjectContextPatch,
} from "../../capabilities/project";

export type AssistantStatus = "idle" | "running" | "completed" | "error" | "cancelled";

export interface AssistantSnapshot {
  status: AssistantStatus;
  requestId: string | null;
  question: string;
  streamedText: string;
  response: ContextAnalysisResult | null;
  context: MultiSessionContextAssembly | null;
  error: string | null;
}

export interface AssistantResponse {
  requestId: string;
  context: MultiSessionContextAssembly;
  result: ContextAnalysisResult;
}

const MAX_MESSAGES = 24;
const MAX_HISTORY_CHARS = 48 * 1024;

export class AiAssistant {
  private provider: AiProvider;
  private readonly pipeline: ContextProcessingPipeline;
  private readonly actionExecutor: TerminalActionExecutor;
  private readonly projectContext?: ProjectContextCapability;
  private readonly listeners = new Set<() => void>();
  private readonly history: AiConversationMessage[] = [];
  private active: { requestId: string; controller: AbortController } | null = null;
  private lastRequest: { selection: ContextSelection; question: string } | null = null;
  private enabled: boolean;
  private snapshot: AssistantSnapshot = {
    status: "idle",
    requestId: null,
    question: "",
    streamedText: "",
    response: null,
    context: null,
    error: null,
  };

  constructor(
    provider: AiProvider,
    contextCapability: TerminalContextCapability,
    inputCapability: TerminalInputCapability,
    options: {
      projectContext?: ProjectContextCapability;
      enabled?: boolean;
    } = {},
  ) {
    this.provider = provider;
    this.projectContext = options.projectContext;
    this.enabled = options.enabled ?? true;
    this.pipeline = new ContextProcessingPipeline(contextCapability, undefined, undefined, this.projectContext);
    this.actionExecutor = new TerminalActionExecutor(inputCapability);
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setProvider(provider: AiProvider) {
    this.provider = provider;
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  isEnabled() {
    return this.enabled;
  }

  getActionExecutor() {
    return this.actionExecutor;
  }

  async send(selection: ContextSelection, question: string): Promise<AssistantResponse | null> {
    const normalizedQuestion = question.trim();
    if (!this.enabled || !normalizedQuestion || this.active) return null;
    const requestId = createRequestId();
    const controller = new AbortController();
    this.active = { requestId, controller };
    this.lastRequest = { selection, question: normalizedQuestion };
    const context = this.pipeline.capture(selection);
    this.update({ status: "running", requestId, question: normalizedQuestion, streamedText: "", response: null, context, error: null });
    try {
      const result = await this.provider.analyze(
        { context, question: normalizedQuestion, history: this.history },
        {
          signal: controller.signal,
          onToken: (token) => {
            if (this.active?.requestId !== requestId || !this.enabled) return;
            this.update({ streamedText: `${this.snapshot.streamedText}${token}` });
          },
        },
      );
      if (this.active?.requestId !== requestId) return null;
      if (!this.enabled) {
        this.active = null;
        this.update({ status: "cancelled", error: "已停止本次生成" });
        return null;
      }
      this.pushHistory({ role: "user", content: normalizedQuestion });
      this.pushHistory({ role: "assistant", content: result.diagnosis });
      const projectUpdate = mergeProjectContextUpdate(
        this.projectContext?.get(),
        result.projectContextUpdate ?? deriveProjectContextUpdate(result),
      );
      if (Object.keys(projectUpdate).length > 0) this.projectContext?.update(projectUpdate);
      this.active = null;
      this.update({ status: "completed", response: result });
      return { requestId, context, result };
    } catch (error) {
      if (this.active?.requestId !== requestId) return null;
      this.active = null;
      const cancelled = controller.signal.aborted || isCancelled(error);
      this.update({ status: cancelled ? "cancelled" : "error", error: cancelled ? "已停止本次生成" : errorMessage(error) });
      return null;
    }
  }

  stop() {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
  }

  retry() {
    return this.lastRequest ? this.send(this.lastRequest.selection, this.lastRequest.question) : Promise.resolve(null);
  }

  resetConversation() {
    this.active?.controller.abort();
    this.active = null;
    this.history.length = 0;
    this.lastRequest = null;
    this.update({ status: "idle", requestId: null, question: "", streamedText: "", response: null, context: null, error: null });
  }

  private pushHistory(message: AiConversationMessage) {
    this.history.push(message);
    while (this.history.length > MAX_MESSAGES) this.history.shift();
    let total = this.history.reduce((sum, item) => sum + item.content.length, 0);
    while (total > MAX_HISTORY_CHARS && this.history.length > 1) {
      const removed = this.history.shift();
      total -= removed?.content.length ?? 0;
    }
  }

  private update(patch: Partial<AssistantSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function deriveProjectContextUpdate(result: ContextAnalysisResult): ProjectContextPatch {
  const confirmedFacts = result.evidence
    .map((item) => item.detail.trim())
    .filter(Boolean)
    .slice(-8);
  const nextSteps = result.suggestedChecks.map((item) => item.trim()).filter(Boolean).slice(-8);
  const conclusions = (confirmedFacts.length > 0 || nextSteps.length > 0) && result.diagnosis.trim()
    ? [result.diagnosis.trim()]
    : [];
  return {
    ...(confirmedFacts.length > 0 ? { confirmedFacts } : {}),
    ...(conclusions.length > 0 ? { conclusions } : {}),
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
  };
}

function mergeProjectContextUpdate(
  current: ProjectContext | undefined,
  patch: ProjectContextPatch,
): ProjectContextPatch {
  const listFields = [
    "keyConfigurations",
    "confirmedFacts",
    "issues",
    "conclusions",
    "nextSteps",
  ] as const;
  const merged: ProjectContextPatch = { ...patch };
  for (const field of listFields) {
    if (!patch[field]) continue;
    const existing = current?.[field] ?? [];
    merged[field] = [...new Set([...existing, ...patch[field]])].slice(-64);
  }
  return merged;
}

function createRequestId() {
  return `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCancelled(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "AI 请求失败";
}
