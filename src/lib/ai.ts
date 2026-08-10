import { callEdge } from "./config";
import type { ResearchResult } from "./research";
import type { AnswerScore } from "./score";
import type {
  Dossier,
  FitMatch,
  FitMatchItem,
  InterviewQuestion,
  ResearchStep,
  RubricScore,
} from "./types";

/**
 * AI prep helpers — prep brief, interview questions and per-answer rubric
 * scoring, generated server-side by the ai-brief / ai-questions / ai-score
 * edge functions (Featherless open weights; frontier model when configured).
 *
 * Every call degrades gracefully: any failure returns null and the caller
 * falls back to the deterministic dossier-grounded content, so the app keeps
 * working with or without AI keys.
 */

const SOURCES = new Set<ResearchStep>(["job", "company", "news"]);

/** In-memory session cache keyed by the same keys the edge functions use. */
const sessionCache = new Map<string, unknown>();

/**
 * Drop cached responses whose keys start with `prefix`.
 *
 * Deleting a resume must not leave resume-derived output sitting in memory for
 * the rest of the page's life — a delete control that leaves the data behind is
 * a broken promise.
 */
export function clearAiCache(prefix: string): void {
  for (const key of [...sessionCache.keys()]) {
    if (key.startsWith(prefix)) sessionCache.delete(key);
  }
}

async function aiCall<T>(key: string, name: string, body: unknown): Promise<T | null> {
  if (sessionCache.has(key)) return sessionCache.get(key) as T;
  try {
    const res = await callEdge<{ status?: string } & T>(name, body);
    if (!res || res.status !== "ok") return null;
    sessionCache.set(key, res);
    return res;
  } catch {
    return null;
  }
}

function okCard(d: Dossier, step: ResearchStep): ResearchResult | null {
  const card = d.cards.find((c) => c.step === step && c.state === "ok" && c.payload?.status === "ok");
  return card?.payload?.status === "ok" ? card.payload : null;
}

export interface AiBriefPayload {
  sections: { heading: string; claims: { text: string; source: ResearchStep }[] }[];
}

/** Generate a targeted prep brief grounded in the dossier's three cards.
 *  Returns null when AI is unavailable — callers keep the evidence brief. */
export async function generateAiBrief(d: Dossier): Promise<Dossier["brief"] | null> {
  const job = okCard(d, "job");
  const company = okCard(d, "company");
  const news = okCard(d, "news");
  const res = await aiCall<AiBriefPayload>(`ai_brief:${d.jobUrl}`, "ai-brief", {
    jobUrl: d.jobUrl,
    job,
    company,
    news,
  });
  if (!res) return null;
  const sections = (res.sections ?? [])
    .map((sec) => ({
      heading: typeof sec.heading === "string" ? sec.heading : "",
      claims: (Array.isArray(sec.claims) ? sec.claims : [])
        .filter((c) => c && typeof c.text === "string" && c.text.trim() && SOURCES.has(c.source))
        .map((c) => ({ text: c.text.trim(), source: c.source })),
    }))
    // The news card already lists the headlines — a "Recent news" section in
    // the brief is pure duplication. Drop it if the model insists on one.
    .filter((sec) => sec.heading && sec.claims.length > 0 && !/recent news/i.test(sec.heading));
  return sections.length > 0 ? sections : null;
}

interface RawQuestion {
  id?: unknown;
  text?: unknown;
  speechText?: unknown;
  keyPoints?: { label?: unknown; facts?: unknown }[];
  modelAnswer?: unknown;
  sourceCard?: unknown;
  sourceLabel?: unknown;
}

export interface AiQuestionsPayload {
  questions: RawQuestion[];
}

/** Short stable fingerprint of the resume, so cache keys change when the
 *  resume does — otherwise editing a resume would keep serving questions
 *  targeted at the old one. */
export function fingerprint(text: string | null | undefined): string {
  if (!text) return "none";
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Generate exactly 8 AI interview questions grounded in the dossier, and —
 *  when a resume is saved — targeted at the gaps between it and the posting.
 *  The ai-questions edge function is the single source of truth for the
 *  count (its prompt asks for q1..q8 and it caps at 8); this client cap is a
 *  defensive ceiling, never a truncation that would silently lose questions
 *  the model already produced. Returns null when AI is unavailable; callers
 *  keep the deterministic questions. */
export async function generateAiQuestions(
  d: Dossier,
  resumeText?: string | null,
): Promise<InterviewQuestion[] | null> {
  const job = okCard(d, "job");
  const company = okCard(d, "company");
  const news = okCard(d, "news");
  const resume = resumeText?.trim() || null;
  const res = await aiCall<AiQuestionsPayload>(
    `ai_questions:${d.jobUrl}:${fingerprint(resume)}`,
    "ai-questions",
    {
      jobUrl: d.jobUrl,
      job,
      company,
      news,
      resume,
      // The prep brief rides along only when the dossier has one — absent, the
      // edge function falls back to the raw evidence exactly as before. It is
      // wrapped in the { sections } envelope the deployed ai-questions edge
      // function reads (renderBrief reads brief.sections); the brief content
      // itself passes through unchanged — never reshaped, stripped or
      // summarised.
      ...(d.brief.length > 0 ? { brief: { sections: d.brief } } : {}),
    },
  );
  if (!res) return null;
  const qs: InterviewQuestion[] = [];
  (res.questions ?? []).slice(0, 8).forEach((raw, i) => {
    if (typeof raw.text !== "string" || !raw.text.trim()) return;
    const sourceCard: ResearchStep = SOURCES.has(raw.sourceCard as ResearchStep)
      ? (raw.sourceCard as ResearchStep)
      : "job";
    const keyPoints = (Array.isArray(raw.keyPoints) ? raw.keyPoints : [])
      .filter((kp) => kp && typeof kp.label === "string" && kp.label.trim())
      .map((kp) => ({
        label: (kp.label as string).trim(),
        facts: (Array.isArray(kp.facts) ? kp.facts : [])
          .filter((f): f is string => typeof f === "string" && f.trim().length > 2)
          .map((f) => f.trim().toLowerCase()),
      }));
    qs.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `ai-${i + 1}`,
      text: raw.text.trim(),
      speechText:
        typeof raw.speechText === "string" && raw.speechText.trim() ? raw.speechText.trim() : undefined,
      keyPoints,
      modelAnswer: typeof raw.modelAnswer === "string" ? raw.modelAnswer.trim() : "",
      sourceCard,
      sourceLabel:
        typeof raw.sourceLabel === "string" && raw.sourceLabel.trim() ? raw.sourceLabel.trim() : `${sourceCard} · source`,
    });
  });
  return qs.length > 0 ? qs : null;
}

interface RawFitItem {
  text?: unknown;
  evidence?: unknown;
}

export interface AiFitPayload {
  strengths?: RawFitItem[];
  gaps?: RawFitItem[];
  studyPlan?: unknown[];
  verdict?: unknown;
}

function cleanFitItems(list: RawFitItem[] | undefined, limit: number): FitMatchItem[] {
  const out: FitMatchItem[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw.text !== "string" || !raw.text.trim()) continue;
    out.push({
      text: raw.text.trim(),
      evidence: typeof raw.evidence === "string" && raw.evidence.trim() ? raw.evidence.trim() : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Measure the saved resume against one posting. Returns null when AI is
 * unavailable or the model gave nothing usable — the dossier then simply shows
 * no fit section, rather than an empty or invented one.
 *
 * The resume is sent for this call and never stored alongside the dossier: the
 * result is an opinion about a pairing, not a copy of the resume.
 */
export async function generateFitMatch(d: Dossier, resumeText: string): Promise<FitMatch | null> {
  const resume = resumeText.trim();
  if (!resume) return null;
  const job = okCard(d, "job");
  if (!job) return null;
  const res = await aiCall<AiFitPayload>(
    `ai_fit:${d.jobUrl}:${fingerprint(resume)}`,
    "ai-fit",
    { jobUrl: d.jobUrl, job, company: okCard(d, "company"), news: okCard(d, "news"), resume },
  );
  if (!res) return null;
  const strengths = cleanFitItems(res.strengths, 6);
  const gaps = cleanFitItems(res.gaps, 6);
  const studyPlan = (Array.isArray(res.studyPlan) ? res.studyPlan : [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 2)
    .map((s) => s.trim())
    .slice(0, 8);
  // A fit match with no strengths, no gaps and no plan says nothing. Treat it
  // as a failure so the UI hides the section instead of rendering an empty one.
  if (strengths.length === 0 && gaps.length === 0 && studyPlan.length === 0) return null;
  return {
    strengths,
    gaps,
    studyPlan,
    verdict: typeof res.verdict === "string" && res.verdict.trim() ? res.verdict.trim() : undefined,
  };
}

export interface AiScorePayload {
  content: RubricScore[];
  delivery: RubricScore[];
  missed: string[];
}

/** Score one answer with the small model. Returns null when AI is unavailable
 *  — callers fall back to the deterministic rubric. */
export async function scoreWithAi(
  question: InterviewQuestion,
  transcript: string,
  durationMs: number,
): Promise<AnswerScore | null> {
  // Keying on LENGTH collided: two different answers to the same question with
  // the same character count and duration served each other's score, and
  // rehearsing the same eight questions in one page load is the core loop.
  const key = `ai_score:${question.id}:${fingerprint(transcript.trim())}:${durationMs}`;
  const res = await aiCall<AiScorePayload>(key, "ai-score", { question, transcript, durationMs });
  if (!res) return null;
  const clean = (list: RubricScore[] | undefined, def: string[]): RubricScore[] => {
    const seen = new Set<string>();
    const out: RubricScore[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.label !== "string" || !item.label.trim() || seen.has(item.label)) continue;
      const score = typeof item.score === "number" && Number.isFinite(item.score) ? Math.max(1, Math.min(5, Math.round(item.score))) : 3;
      seen.add(item.label);
      out.push({ label: item.label.trim(), score });
    }
    for (const label of def) if (!seen.has(label)) out.push({ label, score: 3 });
    return out;
  };
  return {
    content: clean(res.content, ["Relevance", "Specificity", "Structure"]),
    delivery: clean(res.delivery, ["Pace", "Filler rate", "Hesitation", "Answer length"]),
    missed: (Array.isArray(res.missed) ? res.missed : []).filter(
      (m): m is string => typeof m === "string" && m.trim().length > 0,
    ),
  };
}

export interface AiOpeningPayload {
  /** The interviewer's spoken greeting — plain prose, covers who they are, the
   *  role being interviewed for, and the format (eight questions, roughly
   *  ninety seconds each). It is never a question. */
  text?: unknown;
}

/** A short spoken greeting for the start of an interview, generated by the
 *  `ai-opening` edge function when a resume is saved.
 *
 *  The prompt is deliberately narrow: the interviewer has read the resume and
 *  makes exactly ONE specific, accurate observation drawn from it — the kind of
 *  remark a hiring manager makes after actually reading it. It must never
 *  fabricate, and must never turn into a question. When no resume is saved, or
 *  the call fails or returns nothing, callers fall back to the scripted
 *  opening — a missing pleasantry is never worth an error state.
 *
 *  The returned opening carries a `speechText` variant alongside its display
 *  text (same as questions), so abbreviations are spoken correctly. */
export async function generateOpening(
  d: Dossier,
  resumeText: string | null | undefined,
  interviewerName: string,
): Promise<{ text: string; speechText: string } | null> {
  const resume = resumeText?.trim() || null;
  if (!resume) return null;
  const job = okCard(d, "job");
  if (!job) return null;
  const res = await aiCall<AiOpeningPayload>(`ai_opening:${d.jobUrl}:${fingerprint(resume)}`, "ai-opening", {
    jobUrl: d.jobUrl,
    job,
    interviewerName,
    resume,
  });
  if (!res) return null;
  const text = typeof res.text === "string" ? res.text.trim() : "";
  if (!text) return null;
  // The speech variant is optional; the caller falls back to the display text.
  const rawSpeech = (res as AiOpeningPayload & { speechText?: unknown }).speechText;
  const speechText = typeof rawSpeech === "string" && rawSpeech.trim() ? rawSpeech.trim() : text;
  return { text, speechText };
}
