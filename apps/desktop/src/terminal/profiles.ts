export type LocalTerminalProfileId = "powershell" | "commandPrompt";

export interface LocalTerminalProfile {
  id: LocalTerminalProfileId;
  name: string;
  shortName: string;
}
export const localTerminalProfiles: readonly LocalTerminalProfile[] = [
  { id: "powershell", name: "PowerShell", shortName: "PS" },
  { id: "commandPrompt", name: "命令提示符", shortName: "CMD" },
];

export function getLocalTerminalProfile(id: LocalTerminalProfileId) {
  return localTerminalProfiles.find((profile) => profile.id === id) ?? localTerminalProfiles[0];
}
