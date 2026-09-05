export { TerminalContextProvider } from "./TerminalContextProvider";
export type {
  TerminalContextSessionDescriptor,
  TerminalContextWorkspace,
} from "./TerminalContextProvider";
export { TerminalContextScope, useTerminalContextProvider } from "./TerminalContextScope";
export { AiContextSelector } from "./AiContextSelector";
export { useAiContextSelection } from "./useAiContextSelection";
export {
  DEFAULT_AI_CONTEXT_SELECTION,
  reconcileContextSelection,
  resolveContextSelection,
} from "./selection";
export type { AiContextScope, AiContextSelection } from "./selection";
export type {
  TerminalConnectionMetadata,
  TerminalContextSnapshot,
  TerminalContextTarget,
} from "./types";
