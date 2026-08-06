import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface ExpanderProps {
  /** Two-line title: the job/question label, then the mono metadata line. */
  title: ReactNode;
  meta?: ReactNode;
  /** The notebook entry number shown in the margin. */
  entry: string;
  children: ReactNode;
  defaultOpen?: boolean;
  idPrefix?: string;
}

/** A numbered notebook entry that opens in place — no modals, no overlays.
 *  Uses the disclosure ARIA pattern (button + aria-expanded + aria-controls). */
export function Expander({ title, meta, entry, children, defaultOpen = false, idPrefix }: ExpanderProps) {
  const [open, setOpen] = useState(defaultOpen);
  const uid = useId();
  const prefix = idPrefix ?? uid;
  const contentId = `${prefix}-body`;
  const buttonId = `${prefix}-trigger`;

  return (
    <article className="entry-grid border-b border-ink/15 pb-6">
      <div className="entry-margin" aria-hidden="true">
        <span>{entry}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 -scale-y-100" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </div>

      <div className="min-w-0">
        <button
          id={buttonId}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
          className="group flex w-full items-start justify-between gap-4 py-3 text-left"
        >
          <span className="min-w-0">
            <span className="block font-heading text-display-sm font-semibold leading-tight text-ink">{title}</span>
            {meta ? <span className="mt-1 block font-mono text-[0.6875rem] text-slate">{meta}</span> : null}
          </span>
        </button>

        {/* Height-based collapse — never a remount, so content state survives. */}
        <div id={contentId} className={`collapse-row ${open ? "rows-open" : "rows-closed"}`}>
          <div className="collapse-inner">
            <div className="pt-2">{children}</div>
          </div>
        </div>
      </div>
    </article>
  );
}
