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

export type SettingsSection = "terminal" | "keyboard";

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

export type WorkspaceTab = LocalTerminalTab | TelnetTab | SerialTab | SshTab | RdpTab | SettingsTab;

export type WorkspaceSplitDirection = "row" | "column";
export type WorkspaceDropZone = "center" | "left" | "right" | "top" | "bottom";

export interface WorkspacePaneNode {
  type: "pane";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface WorkspaceSplitNode {
  type: "split";
  id: string;
  direction: WorkspaceSplitDirection;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode;
