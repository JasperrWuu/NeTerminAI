import { useEffect, useState } from "react";
import type { WorkbenchPreferences } from "./types";

const STORAGE_KEY = "neterminai.workbench.preferences.v1";

const defaultPreferences: WorkbenchPreferences = {
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  leftSidebarWidth: 268,
  rightSidebarWidth: 328,
};

function readPreferences(): WorkbenchPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? { ...defaultPreferences, ...JSON.parse(stored) }
      : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

export interface WorkbenchPreferencesController extends WorkbenchPreferences {
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  setRightSidebarWidth: (width: number) => void;
}

export function useWorkbenchPreferences(): WorkbenchPreferencesController {
  const [preferences, setPreferences] =
    useState<WorkbenchPreferences>(readPreferences);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Layout remains usable for this window when persistence is unavailable.
    }
  }, [preferences]);

  const update = (patch: Partial<WorkbenchPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  };

  return {
    ...preferences,
    toggleLeftSidebar: () =>
      setPreferences((current) => ({
        ...current,
        leftSidebarOpen: !current.leftSidebarOpen,
      })),
    toggleRightSidebar: () =>
      setPreferences((current) => ({
        ...current,
        rightSidebarOpen: !current.rightSidebarOpen,
      })),
    setLeftSidebarWidth: (leftSidebarWidth) => update({ leftSidebarWidth }),
    setRightSidebarWidth: (rightSidebarWidth) => update({ rightSidebarWidth }),
  };
}
