import type { ReactNode } from "react";

interface PanelProps {
  icon: ReactNode;
  iconClass: string;
  title: string;
  subtitle: string;
  status: ReactNode;
  children: ReactNode;
}

export default function Panel({ icon, iconClass, title, subtitle, status, children }: PanelProps) {
  return (
    <section className="panel flex flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconClass}`}>
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="font-heading text-sm font-semibold tracking-wide text-foreground">{title}</h2>
            <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>
        {status}
      </header>
      <div className="flex flex-1 flex-col gap-4 p-5">{children}</div>
    </section>
  );
}
