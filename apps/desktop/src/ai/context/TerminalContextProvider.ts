/**
 * @deprecated The concrete adapter belongs to Core. This alias remains only
 * for consumers that imported the pre-boundary symbol.
 */
export { TerminalCapabilityAdapter as TerminalContextProvider } from "../../capabilities/terminalAdapter";
export type { TerminalCapabilityWorkspace as TerminalContextWorkspace } from "../../capabilities/terminalAdapter";
export type {
  TerminalContextCapability,
  TerminalContextSnapshot,
  TerminalSessionDescriptor as TerminalContextSessionDescriptor,
} from "../../capabilities/terminal";
