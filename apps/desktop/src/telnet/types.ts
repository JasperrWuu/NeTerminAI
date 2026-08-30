export type TelnetLoginMode = "usernamePassword" | "passwordOnly";

export interface TelnetConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  loginMode: TelnetLoginMode;
}

export interface SavedTelnetSession extends TelnetConnection {
  id: string;
  savesPassword: boolean;
  folderId: string | null;
}

export interface TelnetSessionFolder {
  id: string;
  name: string;
}

export const emptyTelnetConnection: TelnetConnection = {
  name: "",
  host: "",
  port: 23,
  username: "",
  password: "",
  loginMode: "usernamePassword",
};
