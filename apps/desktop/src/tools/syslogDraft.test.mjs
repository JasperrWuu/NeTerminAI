import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSyslogDraft, readSyslogDraft, persistSyslogDraft, syslogPort } from "./syslogDraft.ts";

test("SYSLOG defaults and persistence exclude runtime and logs", () => {
  assert.deepEqual(normalizeSyslogDraft(null), { adapter: "", port: "514", protocol: "udp" });
  const saved = { adapter: "usg0|90.1.1.1", port: "1514", protocol: "udp", running: true, logs: ["secret"], socket: 99 };
  let stored;
  globalThis.localStorage = { setItem: (_, value) => { stored = value; }, getItem: () => stored };
  persistSyslogDraft(saved);
  assert.deepEqual(readSyslogDraft(), { adapter: saved.adapter, port: "1514", protocol: "udp" });
  assert.equal(stored.includes("secret"), false);
  delete globalThis.localStorage;
});
test("SYSLOG port rejects invalid and out of range values", () => {
  for (const value of ["", "0", "65536", "5.5", "-1", "abc"]) assert.equal(syslogPort(value), null);
  for (const value of ["1", "514", "65535"]) assert.equal(syslogPort(value), Number(value));
});
