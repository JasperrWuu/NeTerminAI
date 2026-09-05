import { invoke } from "@tauri-apps/api/core";
import { invalidResponse, normalizeIpcError } from "./errors";

export const systemApi = {
  async listSystemFonts(): Promise<string[]> {
    try {
      const value = await invoke<unknown>("list_system_fonts");
      if (!Array.isArray(value) || !value.every((font) => typeof font === "string")) {
        throw invalidResponse("系统字体列表格式无效");
      }
      return value;
    } catch (error) {
      throw normalizeIpcError(error);
    }
  },
};
