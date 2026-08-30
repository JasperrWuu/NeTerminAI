import { useEffect } from "react";
import { Workbench } from "../workbench/Workbench";
import { useWorkbenchPreferences } from "../workbench/useWorkbenchPreferences";
import { useApplicationSettings } from "../settings/useApplicationSettings";

export function App() {
  const preferences = useWorkbenchPreferences();
  const settings = useApplicationSettings();

  useEffect(() => {
    document.documentElement.dataset.theme = settings.appearance.theme;
    document.documentElement.style.colorScheme = settings.appearance.theme;
  }, [settings.appearance.theme]);

  return <Workbench preferences={preferences} settings={settings} />;
}
