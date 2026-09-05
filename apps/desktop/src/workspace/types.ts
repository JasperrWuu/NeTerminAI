import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { RdpConnection, SerialConnection, SshConnection, TelnetConnection } from "../connections/types";

interface WorkspaceTabBase {
  id: string;
  title: string;
  /** Project scope is a logical owner; it does not control runtime lifetime. */
  projectId?: string;
  /** Saved connection identity, when a tab was opened from the library. */
  connectionId?: string;
}

export interface LocalTerminalTab extends WorkspaceTabBase {
  kind: "localTerminal";
  profileId: LocalTerminalProfileId;
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

export type WorkspaceTab = LocalTerminalTab | TelnetTab | SerialTab | SshTab | RdpTab;

export type WorkspaceSplitDirection = "row" | "column";
export type WorkspaceDropZone = "center" | "left" | "right" | "top" | "bottom";

export interface WorkspacePaneNode {
  type: "pane";
  id: string;
  /** A pane is a visible tab group. The id is its stable group/pane identity. */
  tabIds: string[];
  activeTabId: string | null;
}

/** A visible tab group is represented by a leaf in the pane tree. */
export type WorkspaceTabGroup = WorkspacePaneNode;

export interface WorkspaceSplitNode {
  type: "split";
  id: string;
  direction: WorkspaceSplitDirection;
  /** Relative size of the first child, retained when the layout is resized. */
  ratio?: number;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}

export type WorkspaceLayoutNode = WorkspacePaneNode | WorkspaceSplitNode;

/** In-memory snapshot used when switching the active Project. */
export interface WorkspaceProjectSnapshot {
  projectId: string;
  tabs: WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
}
