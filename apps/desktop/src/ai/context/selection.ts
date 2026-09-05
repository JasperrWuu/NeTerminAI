/** @deprecated Context selection is Core-owned; use capabilities/terminal. */
export {
  DEFAULT_CONTEXT_SELECTION as DEFAULT_AI_CONTEXT_SELECTION,
  reconcileContextSelection,
  resolveContextSelection,
} from "../../capabilities/terminal";
export type {
  ContextSelection as AiContextSelection,
  TerminalContextScope as AiContextScope,
} from "../../capabilities/terminal";
