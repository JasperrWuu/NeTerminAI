import { ftpPort, type FtpDraft } from "./ftpDraft.ts";

interface StartupService {
  read(after: number): Promise<{ running: boolean }>;
  start(config: { ip: string; port: number; root: string; username: string; password: string }): Promise<unknown>;
}
export async function restoreFtpServer(draft: FtpDraft, service: StartupService): Promise<string | null> {
  if (!draft.autoStart) return null;
  try {
    const port = ftpPort(draft.port);
    if (!port) throw new Error("端口必须为 1–65535");
    const state = await service.read(0);
    if (!state.running) await service.start({ ip: draft.ip, port, root: draft.root, username: draft.username, password: draft.password });
    return null;
  } catch (error) { return String(error); }
}
