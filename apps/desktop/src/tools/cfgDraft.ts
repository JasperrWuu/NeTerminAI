import { DEFAULT_VPN_NAME, defaultConfigFeatures, normalizeConfigFeatures } from "./cfgConfig.ts";
import type { ConfigValues } from "./cfgConfig.ts";

export const CFG_DRAFT_KEY = "neterminai.cfg-draft.v1";
export interface CfgStartupDraft extends ConfigValues {
  schemaVersion: 1;
  aaaUsers: { id: string; username: string; password: string }[];
}

export function createCfgDraft(): CfgStartupDraft {
  return {
    schemaVersion: 1, deviceType: "FW", managementInterface: "MEth0/0/0",
    managementIp: "90.32.106.121", localIpv4: "",
    aaaUsers: [{ id: "user-1", username: "admin", password: "" }],
    vpnEnabled: true, vpnName: DEFAULT_VPN_NAME, features: defaultConfigFeatures(),
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Merge each field separately so a malformed/older record does not lose unrelated draft data. */
export function normalizeCfgDraft(value: unknown): CfgStartupDraft {
  const defaults = createCfgDraft();
  const saved = record(value);
  const flags = record(saved.features);
  const features = normalizeConfigFeatures(flags);
  const users = Array.isArray(saved.aaaUsers) ? saved.aaaUsers.flatMap((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const user = record(value);
    return [{
      id: `user-${index + 1}`,
      username: typeof user.username === "string" ? user.username : "",
      password: typeof user.password === "string" ? user.password : "",
    }];
  }) : [];
  return {
    ...defaults,
    deviceType: saved.deviceType === "FW" || saved.deviceType === "AR" ? saved.deviceType : defaults.deviceType,
    managementInterface: typeof saved.managementInterface === "string" && /^(MEth0\/0\/0|GE0\/0\/[0-6])$/u.test(saved.managementInterface)
      ? saved.managementInterface : defaults.managementInterface,
    // Preserve incomplete text too: this is a draft, not an executable config.
    managementIp: typeof saved.managementIp === "string" ? saved.managementIp : defaults.managementIp,
    localIpv4: typeof saved.localIpv4 === "string" ? saved.localIpv4 : defaults.localIpv4,
    vpnEnabled: typeof saved.vpnEnabled === "boolean" ? saved.vpnEnabled : defaults.vpnEnabled,
    vpnName: typeof saved.vpnName === "string" ? saved.vpnName : defaults.vpnName,
    aaaUsers: users.length ? users : defaults.aaaUsers,
    features,
  };
}

// Same browser application storage used by settings and saved connection profiles.
// This is not encrypted storage. Never log this payload or persist generated CLI/runtime IDs.
export function readCfgDraft(): CfgStartupDraft {
  try { return normalizeCfgDraft(JSON.parse(localStorage.getItem(CFG_DRAFT_KEY) ?? "null")); }
  catch { return createCfgDraft(); }
}

export function persistCfgDraft(draft: CfgStartupDraft): boolean {
  try {
    localStorage.setItem(CFG_DRAFT_KEY, JSON.stringify(normalizeCfgDraft(draft)));
    return true;
  } catch { return false; }
}
