import { invoke } from "@tauri-apps/api/core";
export interface SyslogEntry { id: number; timestamp: number; source: string; message: string }
export interface SyslogSnapshot { running: boolean; address: string | null; entries: SyslogEntry[]; cursor: number; discarded: number; error: string | null }
export const syslogApi = {
  read: (after: number) => invoke<SyslogSnapshot>("read_syslog", { after }),
  start: (ip: string, port: number) => invoke<SyslogSnapshot>("start_syslog", { ip, port }),
  stop: () => invoke<SyslogSnapshot>("stop_syslog"),
  clear: () => invoke<SyslogSnapshot>("clear_syslog"),
};
