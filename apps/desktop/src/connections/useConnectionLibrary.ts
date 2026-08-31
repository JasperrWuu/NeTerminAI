import { useEffect, useState } from "react";
import type {
  ConnectionFolder,
  SavedConnectionSession,
  SavedRdpSession,
  SavedSerialSession,
  SavedSshSession,
  SavedTelnetSession,
  RdpConnection,
  SerialConnection,
  SshConnection,
  TelnetConnection,
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

function normalizeSession(session: SavedConnectionSession): SavedConnectionSession | null {
  if (session.kind === "serial") {
    return {
      ...session,
      folderId: session.folderId ?? null,
      baudRate: session.baudRate || 9600,
      dataBits: session.dataBits || 8,
      stopBits: session.stopBits || 1,
      parity: session.parity || "none",
      flowControl: session.flowControl || "none",
    };
  }
  if (session.kind === "telnet") {
    return { ...session, folderId: session.folderId ?? null };
  }
  if (session.kind === "ssh") {
    return { ...session, folderId: session.folderId ?? null, port: session.port || 22, identityFile: session.identityFile ?? "" };
  }
  if (session.kind === "rdp") {
    const connection = { ...session } as SavedRdpSession & { displayMode?: unknown };
    delete connection.displayMode;
    return { ...connection, folderId: session.folderId ?? null, port: session.port || 3389, adminSession: session.adminSession ?? false };
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
      const library = JSON.parse(current) as ConnectionLibrary;
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

  const saveTelnet = (
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
  };

  const saveSerial = (connection: SerialConnection, folderId: string | null, existingId?: string) => {
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
  };

  const saveSsh = (connection: SshConnection, folderId: string | null, existingId?: string) => {
    const session: SavedSshSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "ssh",
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId ? current.sessions.map((item) => item.id === existingId ? session : item) : [...current.sessions, session],
    }));
  };

  const saveRdp = (connection: RdpConnection, folderId: string | null, existingId?: string) => {
    const session: SavedRdpSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      kind: "rdp",
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
    };
    setLibrary((current) => ({
      ...current,
      sessions: existingId ? current.sessions.map((item) => item.id === existingId ? session : item) : [...current.sessions, session],
    }));
  };

  const removeSession = (sessionId: string) => {
    setLibrary((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
    }));
  };

  const createFolder = (name: string) => {
    const folder: ConnectionFolder = { id: crypto.randomUUID(), name: name.trim() };
    setLibrary((current) => ({ ...current, folders: [...current.folders, folder] }));
    return folder.id;
  };

  const renameFolder = (folderId: string, name: string) => {
    setLibrary((current) => ({
      ...current,
      folders: current.folders.map((folder) => folder.id === folderId ? { ...folder, name: name.trim() } : folder),
    }));
  };

  const removeFolder = (folderId: string) => {
    setLibrary((current) => ({
      folders: current.folders.filter((folder) => folder.id !== folderId),
      sessions: current.sessions.map((session) => session.folderId === folderId ? { ...session, folderId: null } : session),
    }));
  };

  return {
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
  };
}
