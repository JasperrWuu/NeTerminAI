import { invoke } from "@tauri-apps/api/core";
export interface FtpConfig { ip: string; port: number; root: string; username: string; password: string }
export interface FtpLog { id: number; timestamp: number; level: string; message: string }
export interface FtpProgress { client: string; file: string; direction: string; bytes: number; total: number | null; seconds: number; bytesPerSecond: number }
export interface FtpSnapshot { running: boolean; address: string | null; logs: FtpLog[]; transfers: FtpProgress[]; cursor: number; error: string | null }
export const ftpApi = {
  start: (config: FtpConfig) => invoke<FtpSnapshot>("start_ftp", { config }),
  stop: () => invoke<FtpSnapshot>("stop_ftp"),
  read: (after: number) => invoke<FtpSnapshot>("read_ftp", { after }),
  chooseRoot: () => invoke<string | null>("choose_ftp_root"),
};
