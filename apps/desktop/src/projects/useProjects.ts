import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceLayoutNode, WorkspaceProjectSnapshot } from "../workspace/types";
import {
  createProject as createPersistedProject,
  persistProjectStore,
  readProjectStore,
} from "./persistence";
import type {
  Project,
  ProjectContextPatch,
  ProjectDeviceRef,
  ProjectRuntimeState,
  ProjectStore,
} from "./types";

export interface ProjectWorkspaceData {
  sessions: Project["sessions"];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
  activeTabId: string | null;
}

export interface ProjectsController {
  projects: Project[];
  activeProjectId: string;
  activeProject: Project;
  createProject: (name: string) => Project;
  activateProject: (projectId: string) => boolean;
  updateWorkspace: (projectId: string, workspace: ProjectWorkspaceData) => void;
  updateRuntime: (projectId: string, patch: Partial<ProjectRuntimeState>) => void;
  addDevice: (projectId: string, connectionId: string, alias?: string) => void;
  removeDevice: (projectId: string, connectionId: string) => void;
  updateContext: (projectId: string, patch: ProjectContextPatch) => void;
}

export function useProjects(): ProjectsController {
  const [store, setStore] = useState<ProjectStore>(readProjectStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    persistProjectStore(store);
  }, [store]);

  const createProject = useCallback((name: string) => {
    const project = createPersistedProject(name);
    setStore((current) => ({
      ...current,
      activeProjectId: project.id,
      projects: [...current.projects, project],
    }));
    return project;
  }, []);

  const activateProject = useCallback((projectId: string) => {
    if (!storeRef.current.projects.some((project) => project.id === projectId)) return false;
    setStore((current) => current.activeProjectId === projectId
      ? current
      : { ...current, activeProjectId: projectId });
    return true;
  }, []);

  const updateWorkspace = useCallback((projectId: string, workspace: ProjectWorkspaceData) => {
    setStore((current) => mapProject(current, projectId, (project) => {
      const nextLayout = {
        layout: workspace.layout,
        activePaneId: workspace.activePaneId,
        activeTabId: workspace.activeTabId,
      };
      if (sameJson(project.sessions, workspace.sessions) && sameJson(project.layout, nextLayout)) return project;
      return { ...project, sessions: workspace.sessions, layout: nextLayout, updatedAt: Date.now() };
    }));
  }, []);

  const updateRuntime = useCallback((projectId: string, patch: Partial<ProjectRuntimeState>) => {
    setStore((current) => mapProject(current, projectId, (project) => {
      const runtime = { ...project.runtime, ...patch };
      if (sameJson(project.runtime, runtime)) return project;
      return { ...project, runtime, updatedAt: Date.now() };
    }));
  }, []);

  const addDevice = useCallback((projectId: string, connectionId: string, alias?: string) => {
    if (!connectionId) return;
    setStore((current) => mapProject(current, projectId, (project) => {
      if (project.devices.some((device) => device.connectionId === connectionId)) return project;
      const device: ProjectDeviceRef = {
        connectionId,
        ...(alias?.trim() ? { alias: alias.trim() } : {}),
        addedAt: Date.now(),
      };
      return { ...project, devices: [...project.devices, device], updatedAt: Date.now() };
    }));
  }, []);

  const removeDevice = useCallback((projectId: string, connectionId: string) => {
    setStore((current) => mapProject(current, projectId, (project) => {
      const devices = project.devices.filter((device) => device.connectionId !== connectionId);
      return devices.length === project.devices.length
        ? project
        : { ...project, devices, updatedAt: Date.now() };
    }));
  }, []);

  const updateContext = useCallback((projectId: string, patch: ProjectContextPatch) => {
    setStore((current) => mapProject(current, projectId, (project) => ({
      ...project,
      context: mergeProjectContext(project.context, patch),
      updatedAt: Date.now(),
    })));
  }, []);

  const activeProject = store.projects.find((project) => project.id === store.activeProjectId) ?? store.projects[0];
  return useMemo(() => ({
    projects: store.projects,
    activeProjectId: activeProject.id,
    activeProject,
    createProject,
    activateProject,
    updateWorkspace,
    updateRuntime,
    addDevice,
    removeDevice,
    updateContext,
  }), [
    activateProject,
    activeProject,
    addDevice,
    createProject,
    removeDevice,
    store.projects,
    updateContext,
    updateRuntime,
    updateWorkspace,
  ]);
}

function mapProject(
  store: ProjectStore,
  projectId: string,
  update: (project: Project) => Project,
): ProjectStore {
  let changed = false;
  const projects = store.projects.map((project) => {
    if (project.id !== projectId) return project;
    const next = update(project);
    changed = next !== project;
    return next;
  });
  return changed ? { ...store, projects } : store;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const MAX_CONTEXT_ITEMS = 64;

function mergeProjectContext(
  current: Project["context"],
  patch: ProjectContextPatch,
): Project["context"] {
  const next = { ...current, ...patch };
  return {
    ...next,
    keyConfigurations: boundedContextItems(next.keyConfigurations),
    confirmedFacts: boundedContextItems(next.confirmedFacts),
    issues: boundedContextItems(next.issues),
    conclusions: boundedContextItems(next.conclusions),
    nextSteps: boundedContextItems(next.nextSteps),
    updatedAt: Date.now(),
  };
}

function boundedContextItems(items: readonly string[]) {
  const unique = new Set<string>();
  for (const item of items) {
    const value = item.trim();
    if (value) unique.add(value);
  }
  return [...unique].slice(-MAX_CONTEXT_ITEMS);
}
