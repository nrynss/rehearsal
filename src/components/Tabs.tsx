import { useRef } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import type { TabId } from "../lib/types";

export interface TabDef {
  id: TabId;
  label: string;
  panel: ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  active: TabId;
  onChange: (id: TabId) => void;
  /** Unique id prefix so several tablists can coexist on one screen. */
  idPrefix: string;
  labelledBy: string;
}

/** Tabs follow the WAI-ARIA tabs pattern: roving tabindex, Arrow keys move
 *  between tabs, Home/End jump to the ends. Only the active tab is in the
 *  page tab order. Focus moves to the panel heading on switch. */
export function Tabs({ tabs, active, onChange, idPrefix, labelledBy }: TabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (from: number, to: number) => {
    const next = tabs[to];
    if (!next) return;
    tabRefs.current[next.id]?.focus();
    onChange(next.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      move(index, (index + 1) % tabs.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      move(index, (index - 1 + tabs.length) % tabs.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(index, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(index, tabs.length - 1);
    }
  };

  return (
    <div>
      <div role="tablist" aria-label={labelledBy} className="flex flex-wrap gap-8 border-b border-ink/15">
        {tabs.map((tab, i) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`relative -mb-px min-h-[44px] border-b-2 px-1 pb-2 pt-3 font-mono text-[0.6875rem] uppercase tracking-[0.14em] transition-colors duration-150 sm:text-xs ${
                selected ? "border-ink text-ink" : "border-transparent text-slate hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${idPrefix}-panel-${tab.id}`}
            aria-labelledby={`${idPrefix}-tab-${tab.id}`}
            hidden={!selected}
            tabIndex={-1}
            className={`${selected ? "panel-enter" : ""}`}
          >
            {tab.panel}
          </div>
        );
      })}
    </div>
  );
}
