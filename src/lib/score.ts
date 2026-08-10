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
 * be refined in a later step.
 *
 * Content: relevance (did the answer touch the researched facts the question
 * asked for), specificity (concrete detail — numbers, named facts), structure
 * (a complete, ordered answer as proxied by length).
 *
 * Delivery: pace (words per minute), filler rate (um/uh/like), hesitation
 * (i think/i guess), answer length.
 */
export function scoreAnswer(transcript: string, durationMs: number, question: InterviewQuestion): AnswerScore {
  const text = transcript.trim();
  const w = wordCount(text);

  // ---- Content: relevance / specificity / structure ----
  const matched = question.keyPoints.filter((kp) => (kp.facts.length ? anyFact(text, kp.facts) : false)).length;
  const totalKey = question.keyPoints.filter((kp) => kp.facts.length > 0).length;
  const digits = (text.match(/\d/g) ?? []).length;

  // Relevance — the share of the question's grounding points the answer hit.
  const relevance =
    totalKey === 0 ? 3 : matched >= totalKey ? 5 : matched >= 2 ? 4 : matched === 1 ? 3 : 1;

  // Specificity — concrete detail: numbers plus several named facts.
  const specificity = clamp(1 + (digits >= 2 ? 1 : 0) + (digits >= 5 ? 1 : 0) + (matched >= 2 ? 1 : 0) + (matched >= 3 ? 1 : 0), 1, 5);

  // Structure — length as a proxy for a complete, ordered answer.
  const structure = w >= 110 ? 5 : w >= 75 ? 4 : w >= 45 ? 3 : w >= 20 ? 2 : 1;

  const content: RubricScore[] = [
    { label: "Relevance", score: relevance },
    { label: "Specificity", score: specificity },
    { label: "Structure", score: structure },
  ];

  // ---- Delivery: pace / filler rate / hesitation / answer length ----
  const fillers = (text.match(FILLERS) ?? []).length;
  const hedges = (text.match(HEDGES) ?? []).length;
  const per100 = (n: number) => (w === 0 ? 0 : (n / w) * 100);

  const fillerRate = per100(fillers) === 0 ? 5 : per100(fillers) < 3 ? 4 : per100(fillers) < 6 ? 3 : per100(fillers) < 10 ? 2 : 1;
  const hesitation = per100(hedges) === 0 ? 5 : per100(hedges) < 3 ? 4 : per100(hedges) < 6 ? 3 : 2;

  let pace: number;
  if (durationMs <= 0) {
    pace = 3; // typed answers are not timed
  } else {
    const wpm = w / (durationMs / 60000);
    pace =
      wpm >= 110 && wpm <= 170
        ? 5
        : (wpm >= 90 && wpm < 110) || (wpm > 170 && wpm <= 190)
          ? 4
          : (wpm >= 70 && wpm < 90) || (wpm > 190 && wpm <= 220)
            ? 3
            : 2;
  }

  const answerLength = w === 0 ? 1 : w < 20 ? 2 : w < 45 ? 3 : w < 75 ? 4 : 5;

  const delivery: RubricScore[] = [
    { label: "Pace", score: pace },
    { label: "Filler rate", score: fillerRate },
    { label: "Hesitation", score: hesitation },
    { label: "Answer length", score: answerLength },
  ];

  const missed = question.keyPoints
    .filter((kp) => kp.facts.length > 0 && !anyFact(text, kp.facts))
    .map((kp) => kp.label);

  return { content, delivery, missed };
}

/** Average of a rubric list, kept to one decimal place (1.3, never 1).
 *  0 when the list is empty — the "no answered questions" sentinel. */
export function avgScore(list: { score: number }[]): number {
  if (list.length === 0) return 0;
  return Math.round((list.reduce((s, a) => s + a.score, 0) / list.length) * 10) / 10;
}

/** Readiness band derived from the session's content average alone — delivery
 *  describes how someone sounded, never whether they answered the question, so
 *  blending the two turns a collapse into a shrug. Below 2.0 / 2.0–3.4 / 3.5+. */
export type ContentBand = "not-ready" | "almost" | "ready";

export function contentBand(avgContent: number): ContentBand {
  if (avgContent < 2) return "not-ready";
  if (avgContent < 3.5) return "almost";
  return "ready";
}

/**
 * The band for a whole session, which is NOT the band for its answers.
 *
 * `contentBand` averages the answers that exist. Answer one question of eight
 * well and skip the rest and it returns "ready" — honest about the answer,
 * badly wrong about the rehearsal. A session that skipped most of its
 * questions has not been rehearsed and can never read as ready.
 */
export function sessionBand(avgContent: number, answered: number, total: number): ContentBand {
  if (total <= 0 || answered <= 0) return "not-ready";
  const coverage = answered / total;
  if (coverage < 0.25) return "not-ready";
  const band = contentBand(avgContent);
  if (coverage < 0.5 && band === "ready") return "almost";
  return band;
}

/** The single weakest content axis across a session (lowest average across
 *  answered questions), or null when no answer carries content scores.
 *  Ties resolve to the first axis in rubric order. */
export function weakestContentAxis(
  answers: { content: RubricScore[] }[],
): { label: string; avg: number } | null {
  const scored = answers.filter((a) => a.content.length > 0);
  if (scored.length === 0) return null;
  const labels = scored[0].content.map((c) => c.label);
  let weakest: { label: string; avg: number } | null = null;
  for (const label of labels) {
    const scores = scored.flatMap((a) =>
      a.content.filter((c) => c.label === label).map((c) => c.score),
    );
    if (scores.length === 0) continue;
    const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
    if (!weakest || avg < weakest.avg) weakest = { label, avg };
  }
  return weakest;
}

/** Total key points missed across a session. */
export function missedTotal(answers: { missed: string[] }[]): number {
  return answers.reduce((s, a) => s + a.missed.length, 0);
}
