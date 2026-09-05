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

  async getLocalIpv4(): Promise<string | null> {
    try {
      const value = await invoke<unknown>("get_local_ipv4");
      if (value === null) return null;
      if (typeof value !== "string" || !isUsableIpv4(value)) {
        throw invalidResponse("本机 IPv4 地址格式无效");
      }
      return value;
    } catch (error) {
      throw normalizeIpcError(error);
    }
  },
};

function isUsableIpv4(value: string) {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  const numbers = octets.map((octet) => Number(octet));
  if (numbers.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return numbers[0] !== 0
    && numbers[0] !== 127
    && !(numbers[0] === 169 && numbers[1] === 254)
    && numbers[0] < 224
    && numbers.some((octet) => octet !== 255);
}
