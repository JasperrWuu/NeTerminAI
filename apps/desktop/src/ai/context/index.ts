export { TerminalContextProvider } from "./TerminalContextProvider";
export { TerminalContextScope, useTerminalContextProvider } from "./TerminalContextScope";
export { AiContextSelector } from "./AiContextSelector";
export { useAiContextSelection } from "./useAiContextSelection";
export {
  DEFAULT_CONTEXT_SELECTION,
  DEFAULT_CONTEXT_SELECTION as DEFAULT_AI_CONTEXT_SELECTION,
  reconcileContextSelection,
  resolveContextSelection,
} from "../../capabilities/terminal";
export type {
  ContextSelection,
  ContextSelection as AiContextSelection,
  TerminalConnectionKind,
  TerminalContextScope as AiContextScope,
  TerminalConnectionMetadata,
  TerminalContextCapability,
  TerminalContextSnapshot,
  TerminalTarget,
  TerminalTarget as TerminalContextTarget,
} from "../../capabilities/terminal";
