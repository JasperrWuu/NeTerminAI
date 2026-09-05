import { listen } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors";
import { decodeConnectionStateEvent } from "./validation";
import type { TerminalConnectionStateEvent } from "./types";

const STATE_EVENT = "connection:state";
type Unlisten = () => void;

export const connectionStateApi = {
  subscribe(onEvent: (event: TerminalConnectionStateEvent) => void): Promise<Unlisten> {
    return listen<unknown>(STATE_EVENT, ({ payload }) => {
      const event = decodeConnectionStateEvent(payload);
      if (event) onEvent(event);
    }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },
};
