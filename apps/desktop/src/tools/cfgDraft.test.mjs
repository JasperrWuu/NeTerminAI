import assert from "node:assert/strict";
import test from "node:test";
import { CFG_DRAFT_KEY, createCfgDraft, normalizeCfgDraft, persistCfgDraft, readCfgDraft } from "./cfgDraft.ts";

test("old partial drafts merge defaults field-by-field and retain false flags", () => {
  const draft = normalizeCfgDraft({ deviceType: "AR", managementIp: "10.20.", features: { aaa: false, telnet: "bad" }, vpnEnabled: false });
  assert.equal(draft.deviceType, "AR");
  assert.equal(draft.managementIp, "10.20.");
  assert.equal(draft.features.aaa, false);
  assert.equal(draft.features.managementRoute, true);
  assert.equal(draft.features.lldp, true);
  assert.equal(draft.features.telnet, true);
  assert.equal(draft.vpnEnabled, false);
  assert.equal(draft.vpnName, "_management_vpn_");
});

test("malformed records do not break draft restoration", () => {
  for (const value of [null, [], "broken", 23]) assert.deepEqual(normalizeCfgDraft(value), createCfgDraft());
  const draft = normalizeCfgDraft({ managementIp: "10.0.0.9", deviceType: "oops", aaaUsers: [null, 123, { id: "same", username: "one" }, { id: "same", username: "two" }] });
  assert.equal(draft.managementIp, "10.0.0.9");
  assert.equal(draft.deviceType, "FW");
  assert.equal(draft.aaaUsers.length, 2);
  assert.equal(new Set(draft.aaaUsers.map((user) => user.id)).size, 2);
});

test("storage round trip preserves draft/passwords, excludes generated/ephemeral state", () => {
  const data = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
  try {
    const draft = { ...createCfgDraft(), localIpv4: "10.0.0.3", aaaUsers: [{ id: "a", username: "test", password: "Fixture#123" }], preview: "not saved", target: { sessionId: "ephemeral" } };
    assert.equal(persistCfgDraft(draft), true);
    const restored = readCfgDraft();
    assert.equal(restored.localIpv4, "10.0.0.3");
    assert.equal(restored.aaaUsers[0].password, "Fixture#123");
    assert.equal(restored.features.aaa, true);
    const saved = JSON.parse(data.get(CFG_DRAFT_KEY));
    assert.equal(saved.preview, undefined);
    assert.equal(saved.target, undefined);
    data.set(CFG_DRAFT_KEY, "broken JSON");
    assert.deepEqual(readCfgDraft(), createCfgDraft());
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("storage failure is reported without throwing or logging payloads", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
  try {
    assert.deepEqual(readCfgDraft(), createCfgDraft());
    assert.equal(persistCfgDraft(createCfgDraft()), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});
