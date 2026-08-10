import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, Download, Play, X } from "lucide-react";
import { Expander } from "./Expander";
import { fmtDuration } from "../lib/prep";
import { sessionBand, weakestContentAxis } from "../lib/score";
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

/** One decimal, always — 1.3, never 1. */
function fmtAvg(n: number): string {
  return n.toFixed(1);
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
        {active === "content" ? (
          <div className="flex flex-col gap-4">
            <MissedSection answer={answer} />
            <ScoreBar scores={answer.content} />
          </div>
        ) : (
          <ScoreBar scores={answer.delivery} />
        )}
      </div>
    </div>
  );
}

/** The missed list — the strongest signal on this screen — leads the Content
 *  sub-tab, above the rubric bars. */
function MissedSection({ answer }: { answer: AnswerRecord }) {
  if (answer.skipped) return null;
  return (
    <div className="border-t border-ink/15 pt-3">
      <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-ink">Key points missed</p>
      {answer.missed.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {answer.missed.map((m) => (
            <li key={m} className="text-base leading-snug text-ink">
              {m}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-slate">
          <Check aria-hidden="true" className="h-4 w-4" />
          No key points missed.
        </p>
      )}
    </div>
  );
}

function ScoreBar({ scores }: { scores: RubricScore[] }) {
  if (scores.length === 0) {
    return <p className="text-sm text-slate">No score for this question.</p>;
  }
  return (
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
                  s.summary.totalMs > 0 ? s.summary.totalMs : Math.max(0, s.completedAt - s.startedAt),
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

/** The session verdict — one line, the largest thing in the summary, derived
 *  from the content average alone. Delivery describes how someone sounded,
 *  never whether they answered the question, so blending the two turns a
 *  collapse into a shrug. Bands: below 2.0 / 2.0–3.4 / 3.5+. Worded as
 *  readiness for this interview, never as a grade — the useful sentence is
 *  what to do next, not a mark. */
function verdictFor(avgContent: number, answered: number, total: number): string {
  // Skipping most of the interview is the finding, and it outranks the scores
  // of the few answers given. Say that rather than grading a rehearsal that
  // did not happen.
  if (total > 0 && answered / total < 0.5) {
    return `Most of this interview was skipped — only ${answered} of ${total} questions were answered. Rehearse it end to end.`;
  }
  switch (sessionBand(avgContent, answered, total)) {
    case "not-ready":
      return "Rehearse again before this interview — the answers don't yet carry the research.";
    case "almost":
      return "One more rehearsal before the interview — the answers touch the research but don't fully carry it.";
    case "ready":
      return "Go in with these answers — they carry the research.";
  }
}

function SummaryRow({ session }: { session: Session }) {
  const s = session.summary;
  const hasContent = s.answered > 0;
  const weakest = hasContent ? weakestContentAxis(session.answers) : null;

  const verdict = hasContent
    ? verdictFor(s.avgContent, s.answered, s.answered + s.skipped)
    : "Nothing was answered — rehearse again before the interview.";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="font-heading text-display-md font-semibold leading-snug tracking-tight text-ink">{verdict}</p>
        {weakest ? (
          <p className="text-sm text-slate">
            {weakest.label} is the weakest content axis, averaging {fmtAvg(weakest.avg)} across the session.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCell
          label="avg content"
          value={hasContent ? fmtAvg(s.avgContent) : "—"}
          scale={hasContent ? "/5" : undefined}
        />
        <SummaryCell
          label="avg delivery"
          value={hasContent ? fmtAvg(s.avgDelivery) : "—"}
          scale={hasContent ? "/5" : undefined}
        />
        <SummaryCell label="answered" value={String(s.answered)} demoted />
        <SummaryCell label="skipped" value={String(s.skipped)} demoted />
      </div>

      {hasContent ? (
        <p className="font-mono text-sm tabular-nums text-ink">
          {s.missedTotal === 0
            ? `No key points missed across ${s.answered} ${s.answered === 1 ? "question" : "questions"}.`
            : `${s.missedTotal} key ${s.missedTotal === 1 ? "point" : "points"} missed across ${s.answered} ${
                s.answered === 1 ? "question" : "questions"
              }.`}
        </p>
      ) : null}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  scale,
  demoted,
}: {
  label: string;
  value: string;
  scale?: string;
  demoted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-ink/15 pt-2">
      <span className="font-mono text-[0.625rem] uppercase tracking-wider text-slate">{label}</span>
      <span className={`font-mono tabular-nums ${demoted ? "text-sm text-slate" : "text-lg text-ink"}`}>
        {value}
        {scale ? <span className="ml-0.5 text-sm text-slate">{scale}</span> : null}
      </span>
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
      <span className="font-mono text-[0.6875rem] text-slate">source · {answer.sourceLabel || "—"}</span>
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
