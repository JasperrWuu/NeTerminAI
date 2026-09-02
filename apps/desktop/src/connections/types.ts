export interface ConnectionFolder {
  id: string;
  name: string;
}

export interface TelnetConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 2;
export type SerialParity = "none" | "odd" | "even";
export type SerialFlowControl = "none" | "software" | "hardware";

export interface SerialConnection {
  name: string;
  portName: string;
  baudRate: number;
  dataBits: SerialDataBits;
  stopBits: SerialStopBits;
  parity: SerialParity;
  flowControl: SerialFlowControl;
}

interface SavedConnectionBase {
  id: string;
  folderId: string | null;
}

export interface SavedTelnetSession extends TelnetConnection, SavedConnectionBase {
  kind: "telnet";
  savesPassword: boolean;
}

export interface SavedSerialSession extends SerialConnection, SavedConnectionBase {
  kind: "serial";
}

export type SavedConnectionSession = SavedTelnetSession | SavedSerialSession;

export const emptyTelnetConnection: TelnetConnection = {
  name: "",
  host: "",
  port: 23,
  username: "",
  password: "",
};

export const emptySerialConnection: SerialConnection = {
  name: "",
  portName: "COM1",
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};
