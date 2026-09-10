import { ftpApi } from "../ipc/ftp";
import { readFtpDraft } from "./ftpDraft";
import { restoreFtpServer } from "./ftpAutoStart";

let startup: Promise<string | null> | undefined;
/** App-owned, once per launch; never tied to mounting or opening the FTP panel. */
export function startSavedFtp(): Promise<string | null> {
  return startup ??= restoreFtpServer(readFtpDraft(), ftpApi);
}
