import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface ExpanderProps {
  /** Two-line title: the job/question label, then the mono metadata line. */
  title: ReactNode;
  meta?: ReactNode;
  /** Persistent third line, mono 11 Slate, naming what is inside and its state
   *  ("3 cards · prep brief", "researching…"). A closed entry is never silent
   *  about its own contents. */
  status?: ReactNode;
  /** The notebook entry number shown in the margin. */
  entry: string;
  children: ReactNode;
  defaultOpen?: boolean;
  idPrefix?: string;
}

/** A numbered notebook entry that opens in place — no modals, no overlays.
 *  Uses the disclosure ARIA pattern (button + aria-expanded + aria-controls).
 *
 *  The chevron sits on the right-hand edge of the title row (justify-between),
 *  never in the margin — the margin is for metadata (the entry number), not
 *  controls. The whole title row is the hit target (min 44px) with a pointer
 *  cursor; on hover/focus the title shifts to full-weight Ink and the chevron
 *  drops 1px. The chevron rotates 180° on open with the same 200ms ease-out as
 *  the collapse row. prefers-reduced-motion removes the rotation and the
 *  collapse transition, never the state change. */
export function Expander({ title, meta, status, entry, children, defaultOpen = false, idPrefix }: ExpanderProps) {
  const [open, setOpen] = useState(defaultOpen);
  const uid = useId();
  const prefix = idPrefix ?? uid;
  const contentId = `${prefix}-body`;
  const buttonId = `${prefix}-trigger`;

  return (
    <article className="entry-grid border-b border-ink/15 pb-6">
      <div className="entry-margin" aria-hidden="true">
        <span>{entry}</span>
      </div>

      <div className="min-w-0">
        <button
          id={buttonId}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
          className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="block font-heading text-display-sm font-medium leading-tight text-ink group-focus-visible:font-semibold group-hover:font-semibold">
              {title}
            </span>
            {meta ? <span className="mt-1 block font-mono text-[0.6875rem] text-slate">{meta}</span> : null}
            {status ? <span className="mt-1 block font-mono text-[0.6875rem] text-slate">{status}</span> : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 flex-none text-slate transition-transform duration-200 ease-out group-focus-visible:translate-y-px group-hover:translate-y-px ${
              open ? "rotate-180" : ""
            }`}
          />
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
