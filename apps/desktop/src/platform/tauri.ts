import { invoke } from "@tauri-apps/api/core";

/**
 * Runs lifecycle housekeeping that must never surface as an unhandled promise.
 * Interactive operations should use `invoke` directly so their errors remain visible.
 */
export function invokeInBackground(command: string, arguments_: Record<string, unknown>) {
  void invoke(command, arguments_).catch(() => undefined);
}
