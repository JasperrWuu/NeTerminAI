export { ProjectSidebar } from "./ProjectSidebar";
export { useProjects } from "./useProjects";
export type { ProjectsController, ProjectWorkspaceData } from "./useProjects";
export {
  createDefaultProject,
  createEmptyProjectContext,
  createProject,
  normalizeProject,
  persistProjectStore,
  PROJECT_STORAGE_KEY,
  readProjectStore,
} from "./persistence";
export {
  projectSessionsFromTabs,
  resolveProjectTabs,
  restoreProjectWorkspace,
} from "./workspace";
export type {
  Project,
  ProjectContext,
  ProjectContextPatch,
  ProjectDeviceRef,
  ProjectLayoutState,
  ProjectRuntimeState,
  ProjectSessionRef,
  ProjectSessionSource,
} from "./types";
