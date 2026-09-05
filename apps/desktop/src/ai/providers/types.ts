import type { ContextAnalysisRequest, ContextAnalysisResult } from "../analysis/types";
import type { ContextCompressionInput, ContextCompressionUpdate } from "../processing/types";

/** Execution backend only; it never chooses sessions or dispatches commands. */
export interface AiProvider {
  readonly id: string;
  analyze(request: ContextAnalysisRequest): Promise<ContextAnalysisResult>;
  compress?(input: ContextCompressionInput): Promise<ContextCompressionUpdate>;
}
