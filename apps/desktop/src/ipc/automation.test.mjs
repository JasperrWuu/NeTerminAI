import test from "node:test";
import assert from "node:assert/strict";
import { decodeAutomationOutputEvent, decodeAutomationStatusEvent } from "./automation.ts";

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

test("automation output events preserve stream and session identity", () => {
  assert.deepEqual(
    decodeAutomationOutputEvent({
      runId: "run-1",
      scriptId: "script-1",
      tabId: "tab-1",
      sessionId: "session-1",
      stream: "stdout",
      data: "Health normal\n",
    }),
    {
      runId: "run-1",
      scriptId: "script-1",
      tabId: "tab-1",
      sessionId: "session-1",
      stream: "stdout",
      data: "Health normal\n",
    },
  );
  assert.equal(decodeAutomationOutputEvent({
    runId: "run-1", scriptId: "script-1", tabId: "tab-1", data: "x", stream: "logs",
  }), null);
  assert.equal(decodeAutomationOutputEvent({
    runId: "run-1", scriptId: "script-1", tabId: "tab-1", stream: "stderr", data: 3,
  }), null);
});
