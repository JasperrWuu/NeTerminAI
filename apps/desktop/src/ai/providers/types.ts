import type { ContextAnalysisRequest, ContextAnalysisResult } from "../analysis/types";
import type { ContextCompressionInput, ContextCompressionUpdate } from "../processing/types";

export interface AiProviderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (token: string) => void;
}

/** Execution backend only; it never chooses sessions or dispatches commands. */
export interface AiProvider {
  readonly id: string;
  analyze(request: ContextAnalysisRequest, options?: AiProviderRequestOptions): Promise<ContextAnalysisResult>;
  compress?(input: ContextCompressionInput): Promise<ContextCompressionUpdate>;
}

export type AiProviderMode = "api" | "process";
export type AiProviderPreset = "openaiCompatible" | "claude" | "opencode" | "powershell" | "custom";

export interface AiProviderConfig {
  mode: AiProviderMode;
  preset: AiProviderPreset;
  baseUrl: string;
  model: string;
  temperature: number;
  executable: string;
  scriptPath: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
}

export interface AiConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
}
