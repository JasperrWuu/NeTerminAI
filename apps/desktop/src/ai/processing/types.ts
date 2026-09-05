import type {
  TerminalConnectionMetadata,
  TerminalConnectionState,
  TerminalContextSnapshot,
  TerminalTarget,
} from "../../capabilities/terminal";
import type { ProjectContext } from "../../capabilities/project";

export interface NormalizedSessionContext {
  target: TerminalTarget;
  title: string;
  connectionKind: TerminalContextSnapshot["connectionKind"];
  connectionState: TerminalConnectionState;
  connection: TerminalConnectionMetadata;
  recentOutput: string;
  selection?: string;
  disconnectReason?: TerminalContextSnapshot["disconnectReason"];
  error?: TerminalContextSnapshot["error"];
}

export interface SessionContextMemory {
  tabId: string;
  sessionId: string;
  summary: string;
  importantFacts: string[];
  recentEvents: string[];
  lastUpdatedAt: number;
  stale: boolean;
}

export interface StructuredSessionContext {
  target: TerminalTarget;
  title: string;
  connectionKind: NormalizedSessionContext["connectionKind"];
  connectionState: TerminalConnectionState;
  connection: TerminalConnectionMetadata;
  memory: SessionContextMemory;
  recentOutput: string;
  selection?: string;
  disconnectReason?: NormalizedSessionContext["disconnectReason"];
  error?: NormalizedSessionContext["error"];
}

export interface MultiSessionContextAssembly {
  version: 1;
  capturedAt: number;
  activeTabId?: string;
  projectContext?: ProjectContext;
  sessions: StructuredSessionContext[];
}

export interface ContextCompressionInput {
  normalized: NormalizedSessionContext;
  previous: SessionContextMemory;
}

export interface ContextCompressionUpdate {
  summary: string;
  importantFacts: string[];
  recentEvents: string[];
}

export interface ContextCompressor {
  compress(input: ContextCompressionInput): ContextCompressionUpdate;
}
