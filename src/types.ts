export type LogLevel = "info" | "ok" | "warn" | "error";

export interface LogEntry {
  id: number;
  t: string;
  level: LogLevel;
  message: string;
}

export type RunStatus = "idle" | "busy" | "ok" | "warn" | "error";
