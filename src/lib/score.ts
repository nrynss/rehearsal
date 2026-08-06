import type { InterviewQuestion, RubricScore } from "./types";

const FILLERS = /\b(um+|uh+|er+|hmm|like|you know|i mean)\b/gi;
const HEDGES = /\b(i think|i guess|maybe|perhaps|probably|kind of|sort of|i suppose|i believe)\b/gi;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function anyFact(text: string, facts: string[]): boolean {
  const t = text.toLowerCase();
  return facts.some((f) => f.length > 2 && t.includes(f.toLowerCase()));
}

export interface AnswerScore {
  content: RubricScore[];
  delivery: RubricScore[];
  missed: string[];
}

/**
 * Deterministic rubric scoring — no LLM, transparent heuristics that will
 * be refined in a later step. Content reads length, specificity and how
 * many research facts the answer actually touched; delivery reads fillers,
 * pace and hedging from the transcript.
 */
export function scoreAnswer(transcript: string, durationMs: number, question: InterviewQuestion): AnswerScore {
  const text = transcript.trim();
  const w = wordCount(text);

  // ---- Content ----
  const matched = question.keyPoints.filter((kp) => (kp.facts.length ? anyFact(text, kp.facts) : false)).length;
  const digits = (text.match(/\d/g) ?? []).length;

  const completeness = w >= 110 ? 5 : w >= 75 ? 4 : w >= 45 ? 3 : w >= 20 ? 2 : 1;
  const specificity = clamp(1 + (digits >= 2 ? 1 : 0) + (digits >= 5 ? 1 : 0) + (matched >= 2 ? 1 : 0) + (matched >= 3 ? 1 : 0), 1, 5);
  const grounding = matched >= 3 ? 5 : matched === 2 ? 4 : matched === 1 ? 3 : 1;

  const content: RubricScore[] = [
    { label: "Completeness", score: completeness },
    { label: "Specificity", score: specificity },
    { label: "Research grounding", score: grounding },
  ];

  // ---- Delivery ----
  const fillers = (text.match(FILLERS) ?? []).length;
  const hedges = (text.match(HEDGES) ?? []).length;
  const per100 = (n: number) => (w === 0 ? 0 : (n / w) * 100);

  const clarity = per100(fillers) === 0 ? 5 : per100(fillers) < 3 ? 4 : per100(fillers) < 6 ? 3 : per100(fillers) < 10 ? 2 : 1;
  const confidence = per100(hedges) === 0 ? 5 : per100(hedges) < 3 ? 4 : per100(hedges) < 6 ? 3 : 2;

  let pacing: number;
  if (durationMs <= 0) {
    pacing = 3; // typed answers are not timed
  } else {
    const wpm = w / (durationMs / 60000);
    pacing =
      wpm >= 110 && wpm <= 170
        ? 5
        : (wpm >= 90 && wpm < 110) || (wpm > 170 && wpm <= 190)
          ? 4
          : (wpm >= 70 && wpm < 90) || (wpm > 190 && wpm <= 220)
            ? 3
            : 2;
  }

  const delivery: RubricScore[] = [
    { label: "Clarity", score: clarity },
    { label: "Pacing", score: pacing },
    { label: "Confidence", score: confidence },
  ];

  const missed = question.keyPoints
    .filter((kp) => kp.facts.length > 0 && !anyFact(text, kp.facts))
    .map((kp) => kp.label);

  return { content, delivery, missed };
}
