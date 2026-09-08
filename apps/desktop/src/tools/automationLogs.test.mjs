import test from "node:test";
import assert from "node:assert/strict";
import { createRunLogs, appendRunLog, logRunStatus, logSummary } from "./automationLogs.ts";

test("session logs are independent and status transitions are idempotent", () => {
  const other = createRunLogs();
  let logs = logRunStatus(createRunLogs(), "running", undefined, 1000);
  logs = logRunStatus(logs, "running", undefined, 1100);
  logs = appendRunLog(logs, "send", "display health", 1200);
  logs = appendRunLog(logs, "info", "正常\n", 1300);
  logs = logRunStatus(logs, "success", undefined, 4020);
  assert.equal(other.entries.length, 0);
  assert.deepEqual(logs.entries.map(e => e.level), ["system", "send", "info", "system"]);
  assert.match(logs.entries[3].message, /3.02s/);
  assert.equal(logRunStatus(logs, "success").entries.length, 4);
});
test("stderr retains traceback with final summary, not HTML", () => {
  let logs = appendRunLog(createRunLogs(), "error", "Traceback (most recent call last):\n", 1, true);
  logs = appendRunLog(logs, "error", '  File "test.py", line 1\n', 2, true);
  logs = appendRunLog(logs, "error", "ValueError: test failed\n", 3, true);
  assert.equal(logs.entries.length, 1);
  assert.equal(logSummary(logs.entries[0]), "ValueError: test failed");
  assert.match(logs.entries[0].message, /File "test.py"/);
});
test("stop and runner failures are logged once", () => {
  const stopped = logRunStatus(createRunLogs(), "cancelled");
  assert.equal(logRunStatus(stopped, "cancelled").entries.length, 1);
  assert.match(stopped.entries[0].message, /用户停止/);
  assert.equal(logRunStatus(createRunLogs(), "error", "spawn failed").entries[0].message, "spawn failed");
});
test("bounded logs explicitly report truncation and keep latest output", () => {
  let logs = appendRunLog(createRunLogs(), "info", "a".repeat(210000));
  assert.equal(logs.truncated, true);
  assert.equal(logs.entries[0].message.length, 200000);
  for (let i = 0; i < 2100; i++) logs = appendRunLog(logs, "send", `cmd ${i}`);
  assert.ok(logs.entries.length <= 2000);
  assert.equal(logs.entries.at(-1).message, "cmd 2099");
  assert.equal(new Set(logs.entries.map(e => e.id)).size, logs.entries.length);
});
