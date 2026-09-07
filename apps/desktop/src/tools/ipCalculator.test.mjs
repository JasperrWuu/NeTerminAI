import test from "node:test";
import assert from "node:assert/strict";
import { parseIpv4MaskOrPrefix, calculateIpv4, calculateIpv6, numberToIpv6, parseIpv6 } from "./ipCalculator.ts";
import { normalizeIpDraft, readIpDraft, persistIpDraft, IP_DRAFT_KEY } from "./ipCalculatorDraft.ts";

test("IPv4 dotted mask and numeric prefix produce identical complete results", () => {
  const result = calculateIpv4("192.168.1.10", "24");
  assert.deepEqual(result, calculateIpv4("192.168.1.10", "255.255.255.0"));
  assert.deepEqual(result, { address: "192.168.1.10", network: "192.168.1.0", mask: "255.255.255.0", prefix: 24,
    broadcast: "192.168.1.255", first: "192.168.1.1", last: "192.168.1.254", total: "256", usable: "254" });
});
test("all IPv4 masks are contiguous; zero, point-to-point and host boundaries", () => {
  for (let prefix = 0; prefix <= 32; prefix++) {
    const result = calculateIpv4("255.255.255.255", String(prefix));
    assert.equal(parseIpv4MaskOrPrefix(result.mask), prefix);
    assert.equal(BigInt(result.total), 1n << BigInt(32 - prefix));
  }
  assert.equal(calculateIpv4("192.168.1.10", "0").network, "0.0.0.0");
  assert.equal(calculateIpv4("192.168.1.10", "0").usable, "4294967294");
  assert.equal(calculateIpv4("192.168.1.10", "31").first, "192.168.1.10");
  assert.equal(calculateIpv4("192.168.1.10", "31").last, "192.168.1.11");
  assert.equal(calculateIpv4("192.168.1.10", "32").usable, "1");
});
test("invalid IPv4 and noncontiguous masks are rejected", () => {
  for (const mask of ["33", "-1", "/24", "1.5", "", "255.0.255.0", "255.255.255.1", "256.0.0.0"]) assert.throws(() => parseIpv4MaskOrPrefix(mask), mask);
  for (const ip of ["1.2.3", "256.1.1.1", "01.2.3.4", "1.2.3.-1", "1e2.0.0.1"]) assert.throws(() => calculateIpv4(ip, "24"), ip);
});
test("IPv6 subnet, expanded form, decimal and range are exact", () => {
  const result = calculateIpv6("2001:db8::1", "64");
  assert.equal(result.network, "2001:db8::");
  assert.equal(result.last, "2001:db8::ffff:ffff:ffff:ffff");
  assert.equal(result.total, "18446744073709551616");
  assert.equal(result.expanded, "2001:0db8:0000:0000:0000:0000:0000:0001");
  assert.equal(result.decimal, "42540766411282592856903984951653826561");
  assert.equal(numberToIpv6(result.decimal).compressed, "2001:db8::1");
});
test("IPv6 compression picks longest then first run, never one zero", () => {
  assert.equal(calculateIpv6("2001:0:0:1:0:0:1:1", "128").compressed, "2001::1:0:0:1:1");
  assert.equal(calculateIpv6("2001:db8:0:1:2:3:4:5", "128").compressed, "2001:db8:0:1:2:3:4:5");
  assert.equal(calculateIpv6("FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF", "0").network, "::");
  assert.equal(calculateIpv6("::1", "128").total, "1");
  assert.equal(calculateIpv6("::ffff:192.0.2.1", "128").compressed, "::ffff:c000:201");
});
test("IPv6 big integers preserve full 128-bit precision and reject overflow", () => {
  const max = (1n << 128n) - 1n;
  assert.equal(numberToIpv6("0").compressed, "::");
  assert.equal(numberToIpv6(max.toString()).expanded, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
  for (const value of ["-1", "1.5", "1e20", "+1", "", (max + 1n).toString()]) assert.throws(() => numberToIpv6(value), value);
  for (let i = 0n; i < 128n; i++) {
    const value = (1n << i) + (i > 0n ? 1n : 0n);
    assert.equal(parseIpv6(numberToIpv6(value.toString()).compressed), value);
  }
  assert.equal(calculateIpv6("::", "0").total, (1n << 128n).toString());
});
test("malformed IPv6 and prefix do not calculate", () => {
  for (const value of ["", "1:2:3", ":::1", "1::2::3", "1:2:3:4:5:6:7:8::", "gg::1", "fe80::1%eth0", "::1/64", "::ffff:256.1.1.1", ":1:2:3:4:5:6:7"]) assert.throws(() => parseIpv6(value), value);
  for (const prefix of ["129", "-1", "/64", "", "64.0"]) assert.throws(() => calculateIpv6("::1", prefix), prefix);
});
test("draft defaults, incomplete input and invalid storage remain safe", () => {
  assert.equal(normalizeIpDraft(null).tab, "ipv4");
  const draft = normalizeIpDraft({ tab: "ipv6", address6: "2001:", number: "340282366920938463463374607431768211455" });
  assert.equal(draft.address6, "2001:");
  assert.equal(draft.prefix6, "64");
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    assert.equal(persistIpDraft(draft), true);
    assert.deepEqual(readIpDraft(), draft);
    store.set(IP_DRAFT_KEY, "invalid");
    assert.equal(readIpDraft().tab, "ipv4");
  } finally { delete globalThis.localStorage; }
  assert.equal(persistIpDraft(draft), false);
});
