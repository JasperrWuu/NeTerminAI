import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { TerminalContextCapability } from "../../capabilities/terminal";

const terminalContext = createContext<TerminalContextCapability | null>(null);

/** Makes the read-only context provider available to future AI surfaces. */
export function TerminalContextScope({
  provider,
  children,
}: {
  provider: TerminalContextCapability;
  children: ReactNode;
}) {
  return <terminalContext.Provider value={provider}>{children}</terminalContext.Provider>;
}

export function useTerminalContextProvider() {
  const provider = useContext(terminalContext);
  if (!provider) throw new Error("Terminal context provider is unavailable");
  return provider;
}
