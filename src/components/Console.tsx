import { useEffect, useRef } from "react";
import type { LogEntry } from "../types";

const levelStyles: Record<LogEntry["level"], string> = {
  info: "text-slate-400",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

interface ConsoleProps {
  logs: LogEntry[];
  placeholder?: string;
}

export default function Console({ logs, placeholder }: ConsoleProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={ref}
      className="console"
      role="log"
      aria-live="polite"
      aria-label="Activity log"
    >
      {logs.length === 0 ? (
        <p className="italic text-slate-600">{placeholder ?? "// console idle"}</p>
      ) : (
        logs.map((l) => (
          <p key={l.id} className="break-words whitespace-pre-wrap">
            <span className="text-slate-600 select-none">[{l.t}]</span>{" "}
            <span className={levelStyles[l.level]}>{l.message}</span>
          </p>
        ))
      )}
    </div>
  );
}
