import test from "node:test";
import assert from "node:assert/strict";
import { decodeAutomationStatusEvent } from "./automation.ts";

test("automation status events are decoded without widening the payload", () => {
  assert.deepEqual(
    decodeAutomationStatusEvent({
      runId: "run-1",
      scriptId: "script-1",
      tabId: "tab-1",
      sessionId: "session-1",
      status: "running",
      message: "ok",
    }),
    {
      runId: "run-1",
      scriptId: "script-1",
      tabId: "tab-1",
      sessionId: "session-1",
      status: "running",
      message: "ok",
    },
  );
  assert.equal(decodeAutomationStatusEvent({ status: "running" }), null);
  assert.equal(decodeAutomationStatusEvent({
    runId: "run-1", scriptId: "script-1", tabId: "tab-1", status: "unknown",
  }), null);
});
