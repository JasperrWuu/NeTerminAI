import type { TerminalCommandProposal } from "../analysis/types";
import type { TerminalInputCapability } from "../../capabilities/terminal";

export type TerminalActionResult =
  | { status: "requiresApproval" }
  | { status: "executed" }
  | { status: "rejected"; reason: "invalid_command" | "stale_session" | "unavailable" };

/** Executes only user-approved proposals after validating the current runtime identity. */
export class TerminalActionExecutor {
  private readonly input: TerminalInputCapability;

  constructor(input: TerminalInputCapability) {
    this.input = input;
  }

  execute(proposal: TerminalCommandProposal, approved = false): TerminalActionResult {
    if (!approved) return { status: "requiresApproval" };
    const command = proposal.command.trim();
    if (!command || /[\r\n]/u.test(command)) return { status: "rejected", reason: "invalid_command" };

    const result = this.input.dispatchInput(proposal.target, `${command}\r`);
    if (result.ok) return { status: "executed" };
    return {
      status: "rejected",
      reason: result.code === "stale_session" ? "stale_session" : "unavailable",
    };
  }
}
