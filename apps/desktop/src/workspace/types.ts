import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { TelnetConnection } from "../telnet/types";

interface WorkspaceTabBase {
  id: string;
  title: string;
}

export interface LocalTerminalTab extends WorkspaceTabBase {
  kind: "localTerminal";
  profileId: LocalTerminalProfileId;
}

export type SettingsSection = "terminal";

export interface SettingsTab extends WorkspaceTabBase {
  kind: "settings";
  section: SettingsSection;
}

export interface TelnetTab extends WorkspaceTabBase {
  kind: "telnet";
  connection: TelnetConnection;
}

// SSH, Serial, RDP and tools will extend this union without changing the tab shell.
export type WorkspaceTab = LocalTerminalTab | TelnetTab | SettingsTab;
