import test from "node:test";
import assert from "node:assert/strict";
import { createRunLogs, appendRunLog, logRunStatus, logSummary, bufferStdout, flushStdout, formatRunLog, runLogFilename } from "./automationLogs.ts";

test("stdout burst preserves chunks, newlines and indentation in one INFO", () => {
  let logs = createRunLogs();
  for (const data of ["Device:\n", "  CPU: ", "10%\nMemory: 40%\n", "\nStatus: Normal"]) logs = bufferStdout(logs, data, 1234);
  assert.equal(logs.entries.length, 0);
  logs = flushStdout(logs);
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].message, "Device:\n  CPU: 10%\nMemory: 40%\n\nStatus: Normal");
  assert.equal(logs.entries[0].timestamp, 1234);
  assert.equal(flushStdout(logs).entries.length, 1);
});
test("SEND, ERROR, SYSTEM and terminal statuses flush pending stdout first", () => {
  for (const level of ["send", "error", "system"]) {
    const logs = appendRunLog(bufferStdout(createRunLogs(), "tail\n"), level, "boundary");
    assert.deepEqual(logs.entries.map(e => e.level), ["info", level]);
    assert.equal(logs.stdout, undefined);
  }
  for (const status of ["success", "error", "cancelled"]) {
    const logs = logRunStatus(bufferStdout(createRunLogs(), "last without newline"), status);
    assert.equal(logs.entries[0].message, "last without newline");
    assert.equal(logs.stdout, undefined);
  }
});
test("idle flush ends a burst; different runs never share stdout", () => {
  const first = bufferStdout(createRunLogs(), "FW1");
  const second = bufferStdout(createRunLogs(), "FW2");
  const next = flushStdout(bufferStdout(flushStdout(first), "next burst"));
  assert.deepEqual(next.entries.map(e => e.message), ["FW1", "next burst"]);
  assert.equal(flushStdout(second).entries[0].message, "FW2");
});
test("UTF-8 text export includes pending stdout and indents multiline messages", () => {
  const timestamp = new Date(2026, 8, 8, 10, 21, 3).getTime();
  const logs = bufferStdout(createRunLogs(), "设备:\n  CPU: 10%\n\n正常\n", timestamp);
  const prefix = "2026-09-08 10:21:03  INFO    ";
  const exported = formatRunLog(logs);
  assert.equal(exported, `${prefix}设备:\n${" ".repeat(prefix.length)}  CPU: 10%\n\n${" ".repeat(prefix.length)}正常\n`);
  assert.equal(Buffer.from(exported, "utf8").toString("utf8"), exported);
  assert.equal(logs.entries.length, 0, "export is a snapshot and does not mutate the run");
  assert.match(runLogFilename("检查/接口", "FW:1", timestamp), /^检查_接口-FW_1-2026-09-08-10-21-03\.log$/);
});

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
