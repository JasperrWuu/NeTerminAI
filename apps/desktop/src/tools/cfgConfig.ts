/** NetOpsTools export preset (2026-09-06), not a device/firmware compatibility layer. */
export type DeviceType = "FW" | "AR";

export interface ConfigValues {
  deviceType: DeviceType;
  managementInterface: string;
  managementIp: string;
  localIpv4: string;
  aaaUsers: readonly { username: string; password: string }[];
  vpnEnabled: boolean;
  vpnName: string;
  features: ConfigFeatures;
}

export const DEFAULT_VPN_NAME = "_management_vpn_";
export const CONFIG_FEATURES = [
  { id: "managementRoute", label: "管理口路由" },
  { id: "aaa", label: "AAA" },
  { id: "lldp", label: "LLDP" },
  { id: "telnet", label: "Telnet" },
  { id: "ssh", label: "SSH" },
  { id: "web", label: "WEB" },
  { id: "netconf", label: "NETCONF" },
  { id: "infoCenter", label: "Info-Center" },
  { id: "firewallLog", label: "Firewall Log" },
  { id: "snmp", label: "SNMP" },
  { id: "ftp", label: "FTP" },
  { id: "securityPolicy", label: "安全策略" },
] as const;
export type ConfigFeature = typeof CONFIG_FEATURES[number]["id"];
export type ConfigFeatures = Record<ConfigFeature, boolean>;

/** Features that are part of every device bootstrap configuration. */
export const REQUIRED_CONFIG_FEATURES = ["managementRoute", "lldp", "telnet"] as const;
export type RequiredConfigFeature = typeof REQUIRED_CONFIG_FEATURES[number];

export function isRequiredConfigFeature(id: ConfigFeature): id is RequiredConfigFeature {
  return (REQUIRED_CONFIG_FEATURES as readonly string[]).includes(id);
}

export function defaultConfigFeatures(): ConfigFeatures {
  return {
    managementRoute: true, aaa: true, lldp: true, telnet: true, ssh: true, web: true,
    netconf: true, infoCenter: true, firewallLog: true, snmp: true, ftp: true, securityPolicy: true,
  };
}

/**
 * Normalize persisted/user-provided flags while keeping the core bootstrap
 * modules enabled. This is also applied by the generator so UI state cannot
 * accidentally produce an incomplete base configuration.
 */
export function normalizeConfigFeatures(value: Partial<Record<ConfigFeature, unknown>> | undefined): ConfigFeatures {
  const features = defaultConfigFeatures();
  for (const { id } of CONFIG_FEATURES) {
    if (typeof value?.[id] === "boolean") features[id] = value[id] as boolean;
  }
  for (const id of REQUIRED_CONFIG_FEATURES) features[id] = true;
  return features;
}

function isIpv4(value: string) {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
}

export function deriveSmallNetworkIp(value: string) {
  const address = value.trim();
  return isIpv4(address) ? `${address.split(".").slice(0, 3).join(".")}.1` : "";
}

function validate(values: ConfigValues): ConfigValues {
  if (values.deviceType !== "FW" && values.deviceType !== "AR") throw new Error("请选择 FW 或 AR。");
  const features = normalizeConfigFeatures(values.features);
  const managementIp = values.managementIp.trim();
  const localIpv4 = values.localIpv4.trim();
  if (!isIpv4(managementIp)) throw new Error("请输入有效的管理口 IPv4 地址。");
  if ((features.infoCenter || features.firewallLog || features.snmp) && !isIpv4(localIpv4)) {
    throw new Error("已选日志或 SNMP 功能，需要有效的本机 IPv4。");
  }
  if (!/^(MEth0\/0\/0|GE0\/0\/[0-6])$/u.test(values.managementInterface)) throw new Error("请选择支持的管理接口。");
  const vpnName = values.vpnName.trim();
  if (values.vpnEnabled && !/^[\w.-]+$/u.test(vpnName)) throw new Error("VPN 名称只能包含字母、数字、下划线、点和连字符。");
  const needsUsers = features.aaa || features.ssh || features.snmp;
  if (needsUsers && !values.aaaUsers.length) throw new Error("已选 AAA、SSH 或 SNMP 功能，请至少添加一个管理用户。");
  const aaaUsers = values.aaaUsers.map((user, index) => {
    if (!needsUsers) return user;
    const needsUsername = features.aaa || features.ssh;
    const needsPassword = features.aaa || (features.snmp && index === 0);
    const username = user.username.trim();
    if (needsUsername && !username) throw new Error(`请填写用户 ${index + 1} 的用户名。`);
    // CLI arguments are single tokens. Reject control/help/quoting characters rather than silently altering secrets.
    if (needsPassword && (!/^[\x21-\x7e]+$/u.test(user.password) || /["'\\?]/u.test(user.password))) {
      throw new Error(`请填写用户 ${index + 1} 的密码；模板不支持空白、控制字符、引号、反斜杠或问号。`);
    }
    return { username, password: user.password };
  });
  return { ...values, managementIp, localIpv4, vpnName, aaaUsers, features };
}

export function buildConfig(input: ConfigValues): string {
  const values = validate(input);
  const { deviceType, managementInterface, managementIp, localIpv4, aaaUsers, vpnEnabled, vpnName, features } = values;
  const lines = [
    "# NeTerminAI · 设备启动配置",
    `# 设备类型：${deviceType}`,
    `# 管理接口：${managementInterface}`,
    `# 管理口 IP：${managementIp}`,
    `# VPN 实例：${vpnEnabled ? vpnName : "未启用"}`,
    `# 已选功能：${CONFIG_FEATURES.filter((feature) => features[feature.id]).map((feature) => feature.label).join("、")}`,
  ];
  const section = (name: string, commands: readonly string[]) => {
    lines.push("", `# ===== ${name} =====`, ...commands);
  };
  const systemSection = (name: string, commands: readonly string[]) => {
    section(name, ["return", "system-view", ...commands]);
  };

  // VPN mode intentionally assumes an existing binding, exactly as in the supplied exports.
  systemSection("管理口配置", [
    `interface ${managementInterface}`,
    ...(!vpnEnabled ? [`undo ip binding vpn-instance ${DEFAULT_VPN_NAME}`] : []),
    `ip address ${managementIp} 255.255.255.0`, "quit",
  ]);
  if (features.managementRoute) systemSection("管理口路由", [
    `ip route-static ${vpnEnabled ? `vpn-instance ${vpnName} ` : ""}90.0.0.0 8 ${deriveSmallNetworkIp(managementIp)}`,
  ]);
  if (features.aaa) systemSection("AAA", [
    "aaa",
    ...aaaUsers.flatMap(({ username, password }) => [
      `local-user ${username} password irreversible-cipher ${password}`,
      `local-user ${username} password-force-change disable`,
      `local-user ${username} privilege level 3`, "y",
      `local-user ${username} service-type telnet terminal ssh ftp http`, "y",
      `local-user ${username} ftp-directory flash: read execute write`,
    ]),
    "quit", "user-interface maximum-vty 21", "user-interface vty 0 20",
    "authentication-mode aaa", "user privilege level 3", "protocol inbound all", "idle-timeout 0 0",
  ]);
  if (features.lldp) systemSection("LLDP", ["lldp enable"]);
  if (features.telnet) systemSection("Telnet", [
    "telnet server-source all-interface", "y", "telnet ipv6 server-source all-interface", "y",
    "telnet server ip-block disable",
    ...(deviceType === "FW"
      ? ["undo telnet server disable", "undo telnet ipv6 server disable"]
      : ["telnet server enable", "telnet ipv6 server enable"]),
  ]);
  if (features.ssh) systemSection("SSH", [
    "stelnet server enable",
    ...aaaUsers.flatMap(({ username }) => [
      `ssh user ${username}`, `ssh user ${username} authentication-type password`, `ssh user ${username} service-type all`,
    ]),
    "ssh server-source all-interface", "y", "ssh server ip-block disable",
  ]);
  if (features.web) systemSection("WEB", [
    "web-manager timeout 1440", "web-manager enable port 8443", "undo web-manager captcha enable", "y",
    "web-manager security server-certificate server_vpnf.crt",
  ]);
  if (features.netconf) systemSection("NETCONF", ["netconf", "protocol inbound ssh port 830"]);
  if (features.infoCenter) systemSection("Info-Center", [`info-center loghost source ${managementInterface}`, `info-center loghost ${localIpv4}`]);
  if (features.firewallLog) systemSection("Firewall Log", [
    `firewall log source ${managementIp} 1617`,
    `firewall log host ${localIpv4} 514${vpnEnabled ? ` vpn-instance ${vpnName}` : ""}`,
    "firewall log session multi-host-mode concurrent", "firewall log session log-type syslog",
    "firewall log session new-session enable", "firewall log service log-type syslog",
  ]);
  // NetOpsTools uses the AAA password for SNMP. With multiple users, use the first user's password.
  const community = aaaUsers[0]?.password ?? "";
  if (features.snmp) systemSection("SNMP", [
    "snmp-agent", `snmp-agent community read cipher ${community}`, `snmp-agent community write cipher ${community}`,
    "snmp-agent sys-info version all",
    `snmp-agent target-host trap address udp-domain ${localIpv4} udp-port 162 params securityname cipher ${community} v2c`,
    "snmp-agent trap enable", `snmp-agent trap source ${managementInterface}`, `snmp-agent protocol source-interface ${managementInterface}`,
  ]);
  if (features.ftp) systemSection("FTP", ["ftp server enable"]);
  if (features.securityPolicy) systemSection("安全策略", ["security-policy", "default action permit", "y", "return"]);
  return `${lines.join("\n")}\n`;
}

export function toTerminalInput(config: string) {
  // Comments/section spacing are for preview only; retain every command and confirmation in order.
  return `${config.split(/\r?\n/u).filter((line) => line.trim() && !line.trimStart().startsWith("#")).join("\r")}\r`;
}
