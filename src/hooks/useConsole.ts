import { useCallback, useState } from "react";
import type { LogEntry, LogLevel } from "../types";

let nextId = 1;

export function useConsole() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const add = useCallback((level: LogLevel, message: string) => {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    setLogs((prev) => [...prev.slice(-199), { id: nextId++, t, level, message }]);
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, add, clear };
}
