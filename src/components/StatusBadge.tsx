import type { RunStatus } from "../types";

interface StatusBadgeProps {
  status: RunStatus;
  label?: string;
}

const STATUS_META: Record<RunStatus, { dot: string; label: string; text: string }> = {
  idle: { dot: "status-dot status-dot-idle", label: "Idle", text: "text-slate-400" },
  busy: { dot: "status-dot status-dot-busy", label: "Running", text: "text-amber-400" },
  ok: { dot: "status-dot status-dot-live", label: "Ready", text: "text-emerald-400" },
  warn: { dot: "status-dot status-dot-busy", label: "Empty", text: "text-amber-400" },
  error: { dot: "status-dot status-dot-error", label: "Failed", text: "text-red-400" },
};

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1">
      <span aria-hidden="true" className={meta.dot} />
      <span className={`text-[11px] font-semibold uppercase tracking-wide ${meta.text}`}>
        {label ?? meta.label}
      </span>
    </span>
  );
}
