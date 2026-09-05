import assert from "node:assert/strict";
import test from "node:test";
import { TerminalActionExecutor } from "./TerminalActionExecutor.ts";

const proposal = {
  id: "proposal-1",
  target: { tabId: "fw1", sessionId: "session-1" },
  command: "display version",
  explanation: "Check the device version",
};

test("actions require explicit approval and dispatch through the current runtime", () => {
  const writes = [];
  const executor = new TerminalActionExecutor({
    dispatchInput: (target, data) => {
      writes.push({ ...target, data });
      return { ok: true };
    },
  });
  assert.deepEqual(executor.execute(proposal), { status: "requiresApproval" });
  assert.deepEqual(executor.execute(proposal, true), { status: "executed" });
  assert.deepEqual(writes, [{ tabId: "fw1", sessionId: "session-1", data: "display version\r" }]);
});

test("stale, unavailable and invalid proposals are rejected without dispatch", () => {
  const executor = new TerminalActionExecutor({
    dispatchInput: (_target, _data) => ({ ok: false, code: "stale_session" }),
  });
  assert.deepEqual(executor.execute(proposal, true), { status: "rejected", reason: "stale_session" });
  assert.deepEqual(executor.execute({ ...proposal, command: "  " }, true), { status: "rejected", reason: "invalid_command" });
  assert.deepEqual(executor.execute({ ...proposal, command: "show\nrun" }, true), { status: "rejected", reason: "invalid_command" });
});
