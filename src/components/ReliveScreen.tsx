import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, Download, Play, X } from "lucide-react";
import { Expander } from "./Expander";
import { fmtDuration } from "../lib/prep";
import type { AnswerRecord, RubricScore, Session } from "../lib/types";

interface ReliveProps {
  sessions: Session[];
  headingId?: string;
}

function fmtStamp(ms: number): string {
  return new Date(ms).toLocaleString([], { hour12: false });
}

function downloadAnswer(a: AnswerRecord) {
  if (!a.blobUrl) return;
  const aEl = document.createElement("a");
  aEl.href = a.blobUrl;
  aEl.download = a.fileName ?? "answer.webm";
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}

function playBlob(url: string) {
  const audio = new Audio(url);
  void audio.play();
}

/** A second, nested tablist inside each question — its own roving tabindex,
 *  so inner Arrow keys never move the outer tablist. */
function Subtabs({ answer }: { answer: AnswerRecord }) {
  const [active, setActive] = useState<"content" | "delivery">("content");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const OPTIONS = ["content", "delivery"] as const;

  const move = (to: number) => {
    refs.current[to]?.focus();
    setActive(OPTIONS[to]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      move((i + 1) % OPTIONS.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      move((i - 1 + OPTIONS.length) % OPTIONS.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(OPTIONS.length - 1);
    }
  };

  const scores: RubricScore[] = active === "content" ? answer.content : answer.delivery;
  const label = active === "content" ? "Content" : "Delivery";

  return (
    <div>
      <div role="tablist" aria-label="Analysis" className="mt-3 flex gap-6 border-b border-ink/15">
        {OPTIONS.map((k, i) => (
          <button
            key={k}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`sub-tab-${k}-${answer.questionId}`}
            aria-selected={active === k}
            aria-controls={`sub-panel-${k}-${answer.questionId}`}
            tabIndex={active === k ? 0 : -1}
            onClick={() => setActive(k)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`relative -mb-px min-h-[44px] border-b-2 px-1 pb-2 pt-3 font-mono text-[0.6875rem] uppercase tracking-[0.14em] transition-colors duration-150 ${
              active === k ? "border-ink text-ink" : "border-transparent text-slate hover:text-ink"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`sub-panel-${active}-${answer.questionId}`}
        aria-labelledby={`sub-tab-${active}-${answer.questionId}`}
        className="pt-4"
      >
        <ScoreBar label={label} scores={scores} />
      </div>
    </div>
  );
}

function ScoreBar({ label, scores }: { label: string; scores: RubricScore[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">{label}</span>
      </div>
      {scores.length === 0 ? (
        <p className="text-sm text-slate">No score for this question.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {scores.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span className="w-28 flex-none text-sm text-ink">{s.label}</span>
              <span className="h-2 flex-1 bg-flag">
                <span className="block h-full bg-ink" style={{ width: `${(s.score / 5) * 100}%` }} />
              </span>
              <span className="w-6 flex-none text-right font-mono text-[0.6875rem] text-slate">{s.score}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Relive({ sessions, headingId }: ReliveProps) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
          Relive
        </h1>
        <p className="mt-2 max-w-[68ch] text-sm text-slate">
          Completed sessions live in this tab for this page load — replay, re-read and download your answers.
        </p>
      </header>

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col">
          {sessions.map((s, i) => (
            <li key={s.id}>
              <Expander
                entry={String(i + 1).padStart(2, "0")}
                title={`${s.jobTitle || "Untitled job"} · ${s.company || "Unknown company"}`}
                meta={`${s.persona.label} · ${fmtStamp(s.completedAt)} · ${s.answers.length} questions · ${fmtDuration(
                  s.summary.totalMs,
                )}`}
              >
                <SessionBody session={s} />
              </Expander>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionBody({ session }: { session: Session }) {
  return (
    <div className="flex flex-col gap-6">
      <SummaryRow session={session} />
      {session.answers.map((a) => (
        <QuestionBlock key={a.questionId} answer={a} />
      ))}
    </div>
  );
}

function SummaryRow({ session }: { session: Session }) {
  const s = session.summary;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <SummaryCell label="answered" value={String(s.answered)} />
      <SummaryCell label="skipped" value={String(s.skipped)} />
      <SummaryCell label="avg content" value={s.avgContent ? String(s.avgContent) : "—"} />
      <SummaryCell label="avg delivery" value={s.avgDelivery ? String(s.avgDelivery) : "—"} />
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-ink/15 pt-2">
      <span className="font-mono text-[0.625rem] uppercase tracking-wider text-slate">{label}</span>
      <span className="font-mono text-lg text-ink">{value}</span>
    </div>
  );
}

function QuestionBlock({ answer }: { answer: AnswerRecord }) {
  const [showModel, setShowModel] = useState(false);
  return (
    <article className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-heading text-display-sm font-semibold leading-tight text-ink">{answer.questionText}</h3>
        <div className="flex flex-none items-center gap-2">
          {answer.blobUrl ? (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="Play answer"
                onClick={() => playBlob(answer.blobUrl!)}
              >
                <Play aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="Download answer"
                onClick={() => downloadAnswer(answer)}
              >
                <Download aria-hidden="true" className="h-4 w-4" />
              </button>
            </>
          ) : null}
          {answer.skipped ? (
            <span className="inline-flex items-center gap-1 font-mono text-[0.625rem] uppercase tracking-wider text-slate">
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              skipped
            </span>
          ) : null}
        </div>
      </div>

      {!answer.skipped ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.625rem] uppercase tracking-wider text-slate">transcript</span>
            <span className="font-mono text-[0.6875rem] text-slate">{fmtDuration(answer.durationMs)}</span>
          </div>
          <p className="text-sm leading-relaxed text-ink">{answer.transcript || "No transcript."}</p>

          {answer.missed.length > 0 ? (
            <div className="flex flex-col gap-1 border-l-2 border-ink/15 pl-3">
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-slate">missed</span>
              <ul className="flex flex-col gap-1">
                {answer.missed.map((m) => (
                  <li key={m} className="text-sm text-ink">
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Check aria-hidden="true" className="h-4 w-4 text-slate" />
              <span className="text-sm text-slate">No key points missed.</span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-sm w-fit"
            aria-expanded={showModel}
            onClick={() => setShowModel((v) => !v)}
          >
            Model answer
          </button>
          {showModel ? <p className="text-sm leading-relaxed text-slate">{answer.modelAnswer}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-slate">This question was skipped — no answer recorded.</p>
      )}

      <Subtabs answer={answer} />
      <span className="font-mono text-[0.6875rem] text-slate">
        source · {answer.sourceLabel || "—"}
      </span>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-ink/25 px-6 py-12 text-center">
      <p className="font-heading text-display-sm font-semibold text-slate">No sessions yet</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate">
        Complete a rehearsal and it will appear here, ready to replay and download.
      </p>
    </div>
  );
}
