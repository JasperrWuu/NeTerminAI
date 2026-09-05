import type { MultiSessionContextAssembly } from "../processing/types";
import type { TerminalContextTarget } from "../context/types";
import type { AiConversationMessage } from "../providers/types";

export interface ContextAnalysisRequest {
  context: MultiSessionContextAssembly;
  question?: string;
  history?: readonly AiConversationMessage[];
}

export interface AnalysisEvidence {
  target: TerminalContextTarget;
  detail: string;
}

export interface TerminalCommandProposal {
  id: string;
  target: TerminalContextTarget;
  command: string;
  explanation: string;
}

export interface ContextAnalysisResult {
  diagnosis: string;
  evidence: AnalysisEvidence[];
  suggestedChecks: string[];
  proposals: TerminalCommandProposal[];
}

export interface ContextAnalyzer {
  analyze(request: ContextAnalysisRequest): Promise<ContextAnalysisResult>;
}
