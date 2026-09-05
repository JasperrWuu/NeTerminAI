import { useCallback, useMemo } from "react";
import type { WorkspacePreferences } from "../settings/types";
import type { ApplicationSettingsController } from "../settings/useApplicationSettings";

export interface WorkbenchPreferencesController extends WorkspacePreferences {
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  setRightSidebarWidth: (width: number) => void;
}

type SettingsPreferencesSource = Pick<
  ApplicationSettingsController,
  "workspacePreferences" | "updateWorkspacePreferences"
>;

/**
 * Workbench preferences are a view of ApplicationSettings, not a second
 * persistence store. Keeping the source in one hook makes updates atomic with
 * terminal and shortcut settings.
 */
export function useWorkbenchPreferences(
  settings: SettingsPreferencesSource,
): WorkbenchPreferencesController {
  const update = useCallback(
    (patch: Partial<WorkspacePreferences>) => settings.updateWorkspacePreferences(patch),
    [settings.updateWorkspacePreferences],
  );
  return useMemo(() => ({
    ...settings.workspacePreferences,
    toggleLeftSidebar: () => update({ leftSidebarOpen: !settings.workspacePreferences.leftSidebarOpen }),
    toggleRightSidebar: () => update({ rightSidebarOpen: !settings.workspacePreferences.rightSidebarOpen }),
    setLeftSidebarWidth: (leftSidebarWidth) => update({ leftSidebarWidth }),
    setRightSidebarWidth: (rightSidebarWidth) => update({ rightSidebarWidth }),
  }), [settings.workspacePreferences, update]);
}
