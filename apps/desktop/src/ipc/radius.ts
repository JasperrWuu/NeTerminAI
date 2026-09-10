import { invoke } from "@tauri-apps/api/core";
export type RadiusCodeKind = "letters" | "digits" | "uppercase" | "lowercase" | "mixed";
export interface RadiusConfig { ip: string; port: number; codeKind: RadiusCodeKind; codeLength: number }
export interface RadiusEntry { id: number; timestamp: number; source: string; message: string }
export interface RadiusSnapshot { running: boolean; address: string | null; entries: RadiusEntry[]; cursor: number; error: string | null }
export const radiusApi = {
  start: (config: RadiusConfig) => invoke<RadiusSnapshot>("start_radius", { config }),
  stop: () => invoke<RadiusSnapshot>("stop_radius"),
  read: (after: number) => invoke<RadiusSnapshot>("read_radius", { after }),
};
