import type { TerminalSessionRegistry } from "../../terminal/TerminalSessionRegistry";
import type { TerminalCommandProposal } from "../analysis/types";

export type TerminalActionResult =
  | { status: "requiresApproval" }
  | { status: "executed" }
  | { status: "rejected"; reason: "invalid_command" | "stale_session" | "unavailable" };

/** Executes only user-approved proposals after validating the current runtime identity. */
export class TerminalActionExecutor {
  private readonly registry: Pick<TerminalSessionRegistry, "dispatchInput">;

  constructor(registry: Pick<TerminalSessionRegistry, "dispatchInput">) {
    this.registry = registry;
  }

  execute(proposal: TerminalCommandProposal, approved = false): TerminalActionResult {
    if (!approved) return { status: "requiresApproval" };
    const command = proposal.command.trim();
    if (!command || /[\r\n]/u.test(command)) return { status: "rejected", reason: "invalid_command" };

    const result = this.registry.dispatchInput(
      proposal.target.tabId,
      proposal.target.sessionId,
      `${command}\r`,
    );
    if (result.ok) return { status: "executed" };
    return {
      status: "rejected",
      reason: result.code === "stale_session" ? "stale_session" : "unavailable",
    };
  }
}
