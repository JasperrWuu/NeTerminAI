import type { ContextSelection } from "../capabilities/terminal";
import type { ProjectContext, ProjectContextPatch } from "../capabilities/project";
import type { WorkspaceLayoutNode } from "../workspace/types";

export type { ProjectContext, ProjectContextPatch } from "../capabilities/project";

export const PROJECT_SCHEMA_VERSION = 1 as const;

export type ProjectConnectionKind = "telnet" | "serial" | "ssh" | "rdp";

export interface ProjectDeviceRef {
  connectionId: string;
  alias?: string;
  addedAt: number;
}

export type ProjectSessionSource =
  | { kind: "local"; profileId: string }
  | { kind: "savedConnection"; connectionId: string }
  | { kind: "transient"; connectionKind: "local" | ProjectConnectionKind };

/** A persisted reference to a runtime tab. It deliberately excludes credentials. */
export interface ProjectSessionRef {
  tabId: string;
  title: string;
  source: ProjectSessionSource;
}

export interface ProjectLayoutState {
  layout: WorkspaceLayoutNode | null;
  activePaneId: string | null;
  activeTabId: string | null;
}

export interface ProjectRuntimeState {
  /** Logical active tab identity; runtime sessionIds are ephemeral and not persisted here. */
  activeTabId: string | null;
  aiContextSelection: ContextSelection;
}

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  devices: ProjectDeviceRef[];
  sessions: ProjectSessionRef[];
  layout: ProjectLayoutState;
  context: ProjectContext;
  runtime: ProjectRuntimeState;
}

export interface ProjectStore {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  activeProjectId: string;
  projects: Project[];
}
