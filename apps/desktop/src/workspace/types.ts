import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { RdpConnection, SerialConnection, SshConnection, TelnetConnection } from "../connections/types";

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

export interface SerialTab extends WorkspaceTabBase {
  kind: "serial";
  connection: SerialConnection;
}

export interface SshTab extends WorkspaceTabBase {
  kind: "ssh";
  connection: SshConnection;
}

export interface RdpTab extends WorkspaceTabBase {
  kind: "rdp";
  connection: RdpConnection;
}

// SSH, RDP and tools can extend this union without changing the tab shell.
export type WorkspaceTab = LocalTerminalTab | TelnetTab | SerialTab | SshTab | RdpTab | SettingsTab;
