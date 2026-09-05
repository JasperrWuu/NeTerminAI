import type { MultiSessionContextAssembly } from "../processing/types";
import type { TerminalTarget } from "../../capabilities/terminal";
import type { AiConversationMessage } from "../providers/types";
import type { ProjectContextPatch } from "../../capabilities/project";

export interface ContextAnalysisRequest {
  context: MultiSessionContextAssembly;
  question?: string;
  history?: readonly AiConversationMessage[];
}

export interface AnalysisEvidence {
  target: TerminalTarget;
  detail: string;
}

export interface TerminalCommandProposal {
  id: string;
  target: TerminalTarget;
  command: string;
  explanation: string;
}

export interface ContextAnalysisResult {
  diagnosis: string;
  evidence: AnalysisEvidence[];
  suggestedChecks: string[];
  proposals: TerminalCommandProposal[];
  /** Optional structured facts returned by a provider for the active Project. */
  projectContextUpdate?: ProjectContextPatch;
}

export interface ContextAnalyzer {
  analyze(request: ContextAnalysisRequest): Promise<ContextAnalysisResult>;
}
