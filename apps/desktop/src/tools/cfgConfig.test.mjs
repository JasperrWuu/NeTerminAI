import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildConfig, CONFIG_FEATURES, defaultConfigFeatures, deriveSmallNetworkIp, REQUIRED_CONFIG_FEATURES, toTerminalInput } from "./cfgConfig.ts";

const input = {
  deviceType: "FW", managementInterface: "MEth0/0/0", managementIp: "90.32.106.121",
  localIpv4: "192.168.1.3", vpnEnabled: true, vpnName: "_management_vpn_",
  aaaUsers: [{ username: "admin", password: "Fixture@123" }],
  features: defaultConfigFeatures(),
};
const noFeatures = Object.fromEntries(CONFIG_FEATURES.map(({ id }) => [id, false]));

for (const { id, label } of CONFIG_FEATURES) {
  test(`${id} can be generated independently with Base, without enabling siblings`, () => {
    const result = buildConfig({ ...input, features: { ...noFeatures, [id]: true } });
    const blocks = [...result.matchAll(/# ===== (.+) =====/gu)].map((match) => match[1]);
    const expected = ["管理口配置", ...CONFIG_FEATURES
      .filter((feature) => REQUIRED_CONFIG_FEATURES.includes(feature.id) || feature.id === id)
      .map((feature) => feature.label)];
    assert.deepEqual(blocks, expected);
    for (const required of REQUIRED_CONFIG_FEATURES) {
      const requiredLabel = CONFIG_FEATURES.find((feature) => feature.id === required).label;
      assert.ok(result.includes(`# ===== ${requiredLabel} =====\nreturn\nsystem-view\n`));
    }
    if (!REQUIRED_CONFIG_FEATURES.includes(id)) assert.ok(result.includes(`# ===== ${label} =====\nreturn\n`));
  });
  test(`${id} can be removed without losing other enabled blocks`, () => {
    const result = buildConfig({ ...input, features: { ...input.features, [id]: false } });
    if (REQUIRED_CONFIG_FEATURES.includes(id)) {
      assert.ok(result.includes(`# ===== ${label} =====`));
    } else {
      assert.ok(!result.includes(`# ===== ${label} =====`));
    }
    for (const other of CONFIG_FEATURES.filter((feature) => feature.id !== id)) {
      assert.ok(result.includes(`# ===== ${other.label} =====`));
    }
  });
}

test("Base-only does not require disabled feature parameters", () => {
  const result = buildConfig({ ...input, features: noFeatures, localIpv4: "", aaaUsers: [] });
  assert.equal([...result.matchAll(/# ===== /gu)].length, 4);
  assert.ok(result.includes("interface MEth0/0/0"));
  assert.ok(!result.includes("Fixture@123"));
  for (const label of ["管理口路由", "LLDP", "Telnet"]) assert.ok(result.includes(`# ===== ${label} =====`));
});

test("SSH alone needs usernames, not AAA passwords; SNMP alone needs only the first password", () => {
  assert.doesNotThrow(() => buildConfig({ ...input, localIpv4: "", aaaUsers: [{ username: "operator", password: "" }], features: { ...noFeatures, ssh: true } }));
  assert.doesNotThrow(() => buildConfig({ ...input, aaaUsers: [{ username: "", password: "Fixture#123" }], features: { ...noFeatures, snmp: true } }));
  assert.throws(() => buildConfig({ ...input, aaaUsers: [{ username: "", password: "" }], features: { ...noFeatures, snmp: true } }));
});

for (const deviceType of ["FW", "AR"]) {
  for (const vpnEnabled of [true, false]) {
    const name = `${deviceType}_${vpnEnabled ? "VPN" : "noVPN"}`;
    test(`${name}: export matches except branding and requested standalone management route preamble`, () => {
      const fixture = readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8")
        .replaceAll("\r\n", "\n").trimEnd().replace("# NetOpsTools", "# NeTerminAI")
        .replace("# ===== 管理口路由 =====\n", "# ===== 管理口路由 =====\nreturn\nsystem-view\n") + "\n";
      const expected = vpnEnabled ? fixture.replace(`info-center loghost ${input.localIpv4}\n`, `info-center loghost ${input.localIpv4} vpn-instance ${input.vpnName}\n`) : fixture;
      assert.equal(buildConfig({ ...input, deviceType, vpnEnabled }), expected);
    });
  }
}

test("custom parameters replace all address/interface/VPN references; route remains the source preset's /8", () => {
  const result = buildConfig({ ...input, managementIp: "10.20.30.99", managementInterface: "GE0/0/6", localIpv4: "172.16.1.8", vpnName: "ops_vpn" });
  assert.match(result, /ip address 10\.20\.30\.99 255\.255\.255\.0/u);
  assert.match(result, /ip route-static vpn-instance ops_vpn 90\.0\.0\.0 8 10\.20\.30\.1/u);
  assert.match(result, /firewall log host 172\.16\.1\.8 514 vpn-instance ops_vpn/u);
  assert.match(result, /info-center loghost 172\.16\.1\.8 vpn-instance ops_vpn\n/u);
  assert.match(result, /snmp-agent trap source GE0\/0\/6/u);
  assert.doesNotMatch(result, /90\.32\.106|192\.168\.1\.3|MEth|_management_vpn_/u);
});

test("no VPN always removes the source preset's default binding, regardless of the disabled field", () => {
  const result = buildConfig({ ...input, vpnEnabled: false, vpnName: "other" });
  assert.match(result, /undo ip binding vpn-instance _management_vpn_/u);
  assert.doesNotMatch(result, /vpn-instance other|ip route-static vpn-instance/u);
});

test("multiple AAA users receive separate AAA and SSH entries, shared VTY occurs once", () => {
  const result = buildConfig({ ...input, aaaUsers: [...input.aaaUsers, { username: "operator", password: "Second@456" }] });
  for (const username of ["admin", "operator"]) {
    assert.ok(result.includes(`local-user ${username} privilege level 3`));
    assert.ok(result.includes(`ssh user ${username} authentication-type password`));
  }
  assert.equal(result.match(/user-interface vty 0 20/gu)?.length, 1);
  assert.match(result, /snmp-agent community write cipher Fixture@123/u);
  assert.doesNotMatch(result, /snmp-agent community write cipher Second/u);
});

test("invalid addresses and missing receiver are rejected", () => {
  for (const managementIp of ["", "999.1.2.3", "01.2.3.4", "::1", "1.2.3.4\nreturn"]) {
    assert.throws(() => buildConfig({ ...input, managementIp }));
  }
  assert.throws(() => buildConfig({ ...input, localIpv4: "" }));
  assert.throws(() => buildConfig({ ...input, localIpv4: "192.168.1.300" }));
});

test("missing usernames and passwords cannot become executable placeholders", () => {
  assert.throws(() => buildConfig({ ...input, aaaUsers: [] }));
  for (const user of [{ username: "", password: "Secret" }, { username: "admin", password: "" }]) {
    assert.throws(() => buildConfig({ ...input, aaaUsers: [user] }));
  }
});

test("AAA usernames only require non-empty trimmed text", () => {
  assert.doesNotThrow(() => buildConfig({
    ...input,
    aaaUsers: [{ username: "ops user/@#", password: "Secret@123" }, { username: "ops user/@#", password: "Second@456" }],
  }));
});

test("CLI control/token injection is rejected without leaking passwords into errors", () => {
  for (const password of ["Secret\nreturn", "Secret\r", "Secret\x03", "Secret?", "Secret value", 'Secret"', "Secret\\", "Secret\x7f"]) {
    assert.throws(() => buildConfig({ ...input, aaaUsers: [{ username: "admin", password }] }), (error) => !error.message.includes(password));
  }
  for (const patch of [{ managementInterface: "MEth0/0/0\nreturn" }, { vpnName: "x\nreturn" }]) {
    assert.throws(() => buildConfig({ ...input, ...patch }));
  }
});

test("gateway is derived from the management /24", () => {
  assert.equal(deriveSmallNetworkIp("90.32.106.121"), "90.32.106.1");
  assert.equal(deriveSmallNetworkIp("10.20.30.50"), "10.20.30.1");
  assert.equal(deriveSmallNetworkIp("300.20.30.50"), "");
});

test("dispatch text strips preview comments/spacing but preserves command and confirmation order", () => {
  const config = buildConfig(input);
  const commands = config.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.equal(toTerminalInput(config), commands.join("\r") + "\r");
  assert.equal(toTerminalInput(config.replaceAll("\n", "\r\n")), toTerminalInput(config));
  assert.doesNotMatch(toTerminalInput(config), /#|\n|\r\r/u);
  assert.ok(toTerminalInput(config).endsWith("default action permit\ry\rreturn\r"));
});
