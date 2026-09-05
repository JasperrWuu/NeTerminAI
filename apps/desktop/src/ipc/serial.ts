import { invoke } from "@tauri-apps/api/core";
import { invalidResponse, normalizeIpcError } from "./errors";

export const serialApi = {
  async listPorts(): Promise<string[]> {
    try {
      const value = await invoke<unknown>("list_serial_ports");
      if (!Array.isArray(value) || !value.every((port) => typeof port === "string")) {
        throw invalidResponse("串口列表格式无效");
      }
      return value;
    } catch (error) {
      throw normalizeIpcError(error);
    }
  },
};
