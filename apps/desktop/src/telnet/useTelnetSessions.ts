import { useEffect, useState } from "react";
import type {
  SavedTelnetSession,
  TelnetConnection,
  TelnetLoginMode,
  TelnetSessionFolder,
} from "./types";

const STORAGE_KEY = "neterminai.telnet-library.v2";
const LEGACY_STORAGE_KEY = "neterminai.telnet-sessions.v1";

interface TelnetLibrary {
  folders: TelnetSessionFolder[];
  sessions: SavedTelnetSession[];
}

interface LegacySession extends Omit<SavedTelnetSession, "folderId" | "loginMode"> {
  folderId?: string | null;
  loginMode?: TelnetLoginMode;
}

function normalizeSession(session: LegacySession): SavedTelnetSession {
  return {
    ...session,
    folderId: session.folderId ?? null,
    loginMode: session.loginMode ?? (session.port === 23 ? "usernamePassword" : "passwordOnly"),
  };
}

function readLibrary(): TelnetLibrary {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) {
      const library = JSON.parse(current) as TelnetLibrary;
      return {
        folders: Array.isArray(library.folders) ? library.folders : [],
        sessions: Array.isArray(library.sessions)
          ? library.sessions.map((session) => normalizeSession(session))
          : [],
      };
    }

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return {
      folders: [],
      sessions: legacy
        ? (JSON.parse(legacy) as LegacySession[]).map((session) => normalizeSession(session))
        : [],
    };
  } catch {
    return { folders: [], sessions: [] };
  }
}

function persist(library: TelnetLibrary) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    // Keep the current session library usable even if persistence is unavailable.
  }
}

export function useTelnetSessions() {
  const [library, setLibrary] = useState<TelnetLibrary>(readLibrary);

  useEffect(() => {
    persist(library);
  }, [library]);

  const updateLibrary = (update: (current: TelnetLibrary) => TelnetLibrary) => {
    setLibrary(update);
  };

  const saveSession = (
    connection: TelnetConnection,
    savesPassword: boolean,
    folderId: string | null,
    existingId?: string,
  ) => {
    const session: SavedTelnetSession = {
      ...connection,
      id: existingId ?? crypto.randomUUID(),
      folderId,
      name: connection.name.trim() || `${connection.host}:${connection.port}`,
      password: savesPassword ? connection.password : "",
      savesPassword,
    };

    updateLibrary((current) => ({
      ...current,
      sessions: existingId
        ? current.sessions.map((item) => (item.id === existingId ? session : item))
        : [...current.sessions, session],
    }));
  };

  const removeSession = (sessionId: string) => {
    updateLibrary((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
    }));
  };

  const createFolder = (name: string) => {
    const folder: TelnetSessionFolder = { id: crypto.randomUUID(), name: name.trim() };
    updateLibrary((current) => ({ ...current, folders: [...current.folders, folder] }));
  };

  const renameFolder = (folderId: string, name: string) => {
    updateLibrary((current) => ({
      ...current,
      folders: current.folders.map((folder) =>
        folder.id === folderId ? { ...folder, name: name.trim() } : folder,
      ),
    }));
  };

  const removeFolder = (folderId: string) => {
    updateLibrary((current) => ({
      folders: current.folders.filter((folder) => folder.id !== folderId),
      sessions: current.sessions.map((session) =>
        session.folderId === folderId ? { ...session, folderId: null } : session,
      ),
    }));
  };

  return {
    folders: library.folders,
    sessions: library.sessions,
    saveSession,
    removeSession,
    createFolder,
    renameFolder,
    removeFolder,
  };
}
