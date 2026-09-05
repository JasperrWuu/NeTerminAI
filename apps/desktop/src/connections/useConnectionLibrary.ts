import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConnectionFolder,
  SavedConnectionSession,
  SavedRdpSession,
  SavedSerialSession,
  SavedSshSession,
  SavedTelnetSession,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialConnection,
  SerialStopBits,
  SshConnection,
  TelnetConnection,
  RdpConnection,
} from "./types";

const STORAGE_KEY = "neterminai.connection-library.v3";
const TELNET_STORAGE_KEY = "neterminai.telnet-library.v2";
const LEGACY_TELNET_STORAGE_KEY = "neterminai.telnet-sessions.v1";

interface ConnectionLibrary {
  folders: ConnectionFolder[];
  sessions: SavedConnectionSession[];
}

interface LegacyTelnetSession extends TelnetConnection {
  id: string;
  folderId?: string | null;
  savesPassword?: boolean;
  loginMode?: "usernamePassword" | "passwordOnly";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringValue(record: Record<string, unknown>, key: string, fallback = "") {
  return typeof record[key] === "string" ? record[key] as string : fallback;
}

function numberValue(record: Record<string, unknown>, key: string, fallback: number) {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : fallback;
}

function booleanValue(record: Record<string, unknown>, key: string, fallback: boolean) {
  return typeof record[key] === "boolean" ? record[key] as boolean : fallback;
}

function folderIdValue(record: Record<string, unknown>) {
  return typeof record.folderId === "string" ? record.folderId : null;
}

function enumValue<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizeSession(value: unknown): SavedConnectionSession | null {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") return null;

  const id = stringValue(record, "id");
  if (!id) return null;

  if (record.kind === "serial") {
    const portName = stringValue(record, "portName");
    if (!portName) return null;
    const name = stringValue(record, "name") || portName;
    return {
      id,
      kind: "serial",
      folderId: folderIdValue(record),
      name,
      portName,
      baudRate: numberValue(record, "baudRate", 9600),
      dataBits: enumValue<SerialDataBits>(numberValue(record, "dataBits", 8) as SerialDataBits, [5, 6, 7, 8], 8),
      stopBits: enumValue<SerialStopBits>(numberValue(record, "stopBits", 1) as SerialStopBits, [1, 2], 1),
      parity: enumValue<SerialParity>(stringValue(record, "parity", "none") as SerialParity, ["none", "odd", "even"], "none"),
      flowControl: enumValue<SerialFlowControl>(stringValue(record, "flowControl", "none") as SerialFlowControl, ["none", "software", "hardware"], "none"),
    };
  }

  if (record.kind === "telnet") {
    const host = stringValue(record, "host");
    if (!host) return null;
    const port = numberValue(record, "port", 23);
    return {
      id,
      kind: "telnet",
      folderId: folderIdValue(record),
      name: stringValue(record, "name") || `${host}:${port}`,
      host,
      port,
      username: stringValue(record, "username"),
      password: stringValue(record, "password"),
      savesPassword: booleanValue(record, "savesPassword", false),
    };
  }

  if (record.kind === "ssh") {
    const host = stringValue(record, "host");
    if (!host) return null;
    const port = numberValue(record, "port", 22);
    return {
      id,
      kind: "ssh",
      folderId: folderIdValue(record),
      name: stringValue(record, "name") || `${host}:${port}`,
      host,
      port,
      username: stringValue(record, "username"),
    };
  }

  if (record.kind === "rdp") {
    const host = stringValue(record, "host");
    if (!host) return null;
    const port = numberValue(record, "port", 3389);
    return {
      id,
      kind: "rdp",
      folderId: folderIdValue(record),
      name: stringValue(record, "name") || `${host}:${port}`,
      host,
      port,
      username: stringValue(record, "username"),
      adminSession: booleanValue(record, "adminSession", false),
    };
  }

  return null;
}

function migrateTelnetSession(session: LegacyTelnetSession): SavedTelnetSession {
  return {
    id: session.id,
    kind: "telnet",
    folderId: session.folderId ?? null,
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username ?? "",
    password: session.password ?? "",
    savesPassword: session.savesPassword ?? false,
  };
}

function readLibrary(): ConnectionLibrary {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) {
      const library = asRecord(JSON.parse(current));
      if (!library) return { folders: [], sessions: [] };
      return {
        folders: Array.isArray(library.folders) ? library.folders : [],
        sessions: Array.isArray(library.sessions)
          ? library.sessions.map(normalizeSession).filter((session): session is SavedConnectionSession => session !== null)
          : [],
      };
    }

    const telnetLibrary = localStorage.getItem(TELNET_STORAGE_KEY);
    if (telnetLibrary) {
      const legacy = JSON.parse(telnetLibrary) as { folders?: ConnectionFolder[]; sessions?: LegacyTelnetSession[] };
      return {
        folders: Array.isArray(legacy.folders) ? legacy.folders : [],
        sessions: Array.isArray(legacy.sessions) ? legacy.sessions.map(migrateTelnetSession) : [],
      };
    }

    const legacySessions = localStorage.getItem(LEGACY_TELNET_STORAGE_KEY);
    return {
      folders: [],
      sessions: legacySessions
        ? (JSON.parse(legacySessions) as LegacyTelnetSession[]).map(migrateTelnetSession)
        : [],
    };
  } catch {
    return { folders: [], sessions: [] };
  }
}

function persist(library: ConnectionLibrary) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    // The in-memory library remains usable when persistence is unavailable.
  }
}

export function useConnectionLibrary() {
  const [library, setLibrary] = useState<ConnectionLibrary>(readLibrary);

  useEffect(() => persist(library), [library]);

  const saveTelnet = useCallback((
    connection: TelnetConnection,
    savesPassword: boolean,
    folderId: string | null,
    existingId?: string,
  ) => {
    const session: SavedTelnetSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "telnet",
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
      password: savesPassword ? connection.password : "",
      savesPassword,
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId
        ? current.sessions.map((item) => (item.id === existingId ? session : item))
        : [...current.sessions, session],
    }));
  }, []);

  const saveSerial = useCallback((connection: SerialConnection, folderId: string | null, existingId?: string) => {
    const session: SavedSerialSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "serial",
      folderId,
      name: connection.name.trim() || connection.portName,
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId
        ? current.sessions.map((item) => (item.id === existingId ? session : item))
        : [...current.sessions, session],
    }));
  }, []);

  const saveSsh = useCallback((connection: SshConnection, folderId: string | null, existingId?: string) => {
    const session: SavedSshSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "ssh",
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
      host: connection.host.trim(),
      username: connection.username.trim(),
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId
        ? current.sessions.map((item) => (item.id === existingId ? session : item))
        : [...current.sessions, session],
    }));
  }, []);

  const saveRdp = useCallback((connection: RdpConnection, folderId: string | null, existingId?: string) => {
    const session: SavedRdpSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "rdp",
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
      host: connection.host.trim(),
      username: connection.username.trim(),
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId
        ? current.sessions.map((item) => (item.id === existingId ? session : item))
        : [...current.sessions, session],
    }));
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setLibrary((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
    }));
  }, []);

  const createFolder = useCallback((name: string) => {
    const folder: ConnectionFolder = { id: crypto.randomUUID(), name: name.trim() };
    setLibrary((current) => ({ ...current, folders: [...current.folders, folder] }));
    return folder.id;
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setLibrary((current) => ({
      ...current,
      folders: current.folders.map((folder) => folder.id === folderId ? { ...folder, name: name.trim() } : folder),
    }));
  }, []);

  const removeFolder = useCallback((folderId: string) => {
    setLibrary((current) => ({
      folders: current.folders.filter((folder) => folder.id !== folderId),
      sessions: current.sessions.map((session) => session.folderId === folderId ? { ...session, folderId: null } : session),
    }));
  }, []);

  return useMemo(() => ({
    folders: library.folders,
    sessions: library.sessions,
    saveTelnet,
    saveSerial,
    saveSsh,
    saveRdp,
    removeSession,
    createFolder,
    renameFolder,
    removeFolder,
  }), [
    createFolder,
    library.folders,
    library.sessions,
    removeFolder,
    removeSession,
    renameFolder,
    saveSerial,
    saveSsh,
    saveRdp,
    saveTelnet,
  ]);
}
