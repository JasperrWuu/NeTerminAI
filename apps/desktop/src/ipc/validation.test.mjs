import assert from "node:assert/strict";
import test from "node:test";
import { IpcError, normalizeIpcError } from "./errors.ts";
import {
  createCommandArguments,
  decodeConnectionStateEvent,
  decodeOutputEvent,
  isCurrentSessionEvent,
} from "./validation.ts";

test("createCommandArguments maps each connection request without UI-only fields", () => {
  assert.deepEqual(
    createCommandArguments({
      kind: "local",
      sessionId: "local-1",
      profile: "powershell",
      columns: 120,
      rows: 40,
    }),
    { sessionId: "local-1", profile: "powershell", columns: 120, rows: 40 },
  );
  assert.deepEqual(
    createCommandArguments({
      kind: "telnet",
      sessionId: "telnet-1",
      host: "192.0.2.10",
      port: 23,
      username: "admin",
      password: "secret",
      columns: 100,
      rows: 30,
    }),
    {
      sessionId: "telnet-1",
      host: "192.0.2.10",
      port: 23,
      username: "admin",
      password: "secret",
      columns: 100,
      rows: 30,
    },
  );
  assert.deepEqual(
    createCommandArguments({
      kind: "serial",
      sessionId: "serial-1",
      portName: "COM1",
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    }),
    {
      sessionId: "serial-1",
      portName: "COM1",
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    },
  );
  assert.deepEqual(
    createCommandArguments({
      kind: "ssh",
      sessionId: "ssh-1",
      host: "192.0.2.20",
      port: 22,
      username: "operator",
      authentication: "password",
      identityFile: "",
      hostKeyAction: "strict",
      columns: 100,
      rows: 30,
    }),
    {
      sessionId: "ssh-1",
      host: "192.0.2.20",
      port: 22,
      username: "operator",
      authentication: "password",
      identityFile: "",
      hostKeyAction: "strict",
      columns: 100,
      rows: 30,
    },
  );
});

test("event decoders accept valid DTOs and reject malformed payloads", () => {
  assert.deepEqual(
    decodeOutputEvent({ sessionId: "session-1", data: "AQI=" }),
    { sessionId: "session-1", data: "AQI=" },
  );
  assert.equal(decodeOutputEvent({ sessionId: "session-1", data: 42 }), null);
  assert.deepEqual(
    decodeConnectionStateEvent({
      sessionId: "session-1",
      state: "failed",
      reason: "connectionFailed",
      error: "connection",
      message: "连接失败",
    }),
    {
      sessionId: "session-1",
      state: "failed",
      reason: "connectionFailed",
      error: "connection",
      message: "连接失败",
    },
  );
  assert.equal(decodeConnectionStateEvent({ sessionId: "session-1", state: "unknown" }), null);
});

test("session filter rejects stale runtime events", () => {
  assert.equal(isCurrentSessionEvent({ sessionId: "current" }, "current"), true);
  assert.equal(isCurrentSessionEvent({ sessionId: "old" }, "current"), false);
});

test("IPC errors preserve stable codes and readable messages", () => {
  const backpressure = normalizeIpcError("终端输入队列繁忙，请稍后重试");
  assert.ok(backpressure instanceof IpcError);
  assert.equal(backpressure.code, "backpressure");
  assert.equal(backpressure.message, "终端输入队列繁忙，请稍后重试");

  const typed = normalizeIpcError({ code: "timeout", message: "连接超时" });
  assert.equal(typed.code, "timeout");
  assert.equal(typed.message, "连接超时");
  assert.equal(normalizeIpcError("终端输入通道已关闭").code, "invalid_state");
});
