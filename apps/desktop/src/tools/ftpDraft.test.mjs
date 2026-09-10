import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFtpDraft, persistFtpDraft, readFtpDraft, ftpPort } from "./ftpDraft.ts";
import { restoreFtpServer } from "./ftpAutoStart.ts";

test("FTP saves unrestricted credentials and autostart but never runtime state", () => {
  const initial = normalizeFtpDraft(null);
  assert.equal(initial.port, "21"); assert.equal(initial.autoStart, false);
  let value;
  globalThis.localStorage = { setItem: (_, text) => { value = text; }, getItem: () => value };
  const config = { ...initial, adapter: "usg10", ip: "90.1.1.10", root: "C:\\FTP", username: " a-测试@ ", password: " password! ", autoStart: true, running: true, socket: 42 };
  persistFtpDraft(config);
  assert.deepEqual(readFtpDraft(), normalizeFtpDraft(config));
  assert.equal(readFtpDraft().password, " password! ");
  assert.equal(value.includes("socket"), false); assert.equal(value.includes("running"), false);
  value = "bad JSON"; assert.deepEqual(readFtpDraft(), initial);
  delete globalThis.localStorage;
});
test("FTP validates only the control port, not credential formats", () => {
  for (const value of ["21", "2121", "65535"]) assert.equal(ftpPort(value), Number(value));
  for (const value of ["0", "-1", "65536", "2.5", "abc", ""]) assert.equal(ftpPort(value), null);
  assert.equal(normalizeFtpDraft({ username: "", password: "" }).username, "");
});

test("startup respects saved flag, preserves credentials, avoids duplicates and reports real bind failure", async () => {
  let reads = 0; const starts = [];
  const service = { read: async () => { reads++; return { running: false }; }, start: async (config) => { starts.push(config); } };
  const config = normalizeFtpDraft({ ip: "90.1.1.1", root: "C:\\FTP", username: " user ", password: " pass " });
  assert.equal(await restoreFtpServer(config, service), null); assert.equal(reads, 0);
  config.autoStart = true;
  assert.equal(await restoreFtpServer(config, service), null); assert.equal(starts.length, 1);
  assert.equal(starts[0].port, 21); assert.equal(starts[0].password, " pass ");
  assert.equal(await restoreFtpServer(config, { ...service, read: async () => ({ running: true }) }), null); assert.equal(starts.length, 1);
  assert.match(await restoreFtpServer(config, { ...service, start: async () => { throw new Error("bind: address in use"); } }), /address in use/);
});
