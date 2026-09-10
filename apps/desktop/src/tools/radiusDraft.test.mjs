import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRadiusDraft, radiusInteger, radiusCodeOptions, persistRadiusDraft, readRadiusDraft } from "./radiusDraft.ts";

test("RADIUS defaults, five alphabets and persisted configuration exclude runtime", () => {
  const defaults = normalizeRadiusDraft(null);
  assert.deepEqual(defaults, { ip: "0.0.0.0", port: "1812", codeKind: "mixed", codeLength: "6" });
  assert.equal(radiusCodeOptions.length, 5);
  let saved;
  globalThis.localStorage = { setItem: (_, value) => { saved = value; }, getItem: () => saved };
  persistRadiusDraft({ ...defaults, ip: "::", codeKind: "digits", running: true, logs: ["secret"], socket: 1 });
  assert.deepEqual(readRadiusDraft(), { ...defaults, ip: "::", codeKind: "digits" });
  assert.equal(saved.includes("secret"), false);
  saved = "malformed"; assert.deepEqual(readRadiusDraft(), defaults);
  assert.equal(normalizeRadiusDraft({ codeKind: "unknown" }).codeKind, "mixed");
});
test("RADIUS port and code length bounds", () => {
  for (const input of ["0", "-1", "1.5", "abc", ""]) assert.equal(radiusInteger(input, 32), null);
  assert.equal(radiusInteger("6", 32), 6);
  assert.equal(radiusInteger("32", 32), 32);
  assert.equal(radiusInteger("33", 32), null);
  assert.equal(radiusInteger("1812", 65535), 1812);
  assert.equal(radiusInteger("65536", 65535), null);
});
