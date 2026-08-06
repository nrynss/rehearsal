import type { ResearchPayload } from "./research";

export type TabId = "research" | "rehearse" | "relive";
export type AnswerMode = "voice" | "text";
export type ResearchStep = "job" | "company" | "news";

/** One of the three research cards inside a dossier. */
export interface DossierCard {
  step: ResearchStep;
  state: "pending" | "ok" | "error";
  payload?: ResearchPayload;
  /** The edge function's fetched_at — the original fetch time, even for cache hits. */
  freshAt?: string;
  /** True when this payload came from the in-memory or database cache. */
  cached?: boolean;
}

/** One line of the prep brief, traceable to the card it came from. */
export interface BriefClaim {
  text: string;
  /** The research card this claim is grounded in. */
  source: ResearchStep;
}

export interface BriefSection {
  heading: string;
  claims: BriefClaim[];
}

/** A complete, expandable research file for one job posting. */
export interface Dossier {
  id: string;
  jobTitle: string;
  company: string;
  jobUrl: string;
  createdAt: number;
  cards: DossierCard[];
  /** Generated from the cards; each claim cites its source card. */
  brief: BriefSection[];
}

export interface Persona {
  id: string;
  label: string;
  voice: string;
}

export const PERSONAS: Persona[] = [
  { id: "hm", label: "Hiring Manager", voice: "Maya" },
  { id: "tech", label: "Technical Panel", voice: "Omar" },
  { id: "peer", label: "Peer Interview", voice: "June" },
];

/** A point a strong answer should hit. `facts` are the matchable tokens. */
export interface KeyPoint {
  label: string;
  facts: string[];
}

export interface InterviewQuestion {
  id: string;
  text: string;
  keyPoints: KeyPoint[];
  modelAnswer: string;
  sourceCard: ResearchStep;
  sourceLabel: string;
}

export interface RubricScore {
  label: string;
  score: number; // 1–5
}

/** One question's outcome inside a completed session. */
export interface AnswerRecord {
  questionId: string;
  questionText: string;
  skipped: boolean;
  transcript: string;
  blobUrl?: string;
  fileName?: string;
  durationMs: number;
  content: RubricScore[];
  delivery: RubricScore[];
  missed: string[];
  modelAnswer: string;
  sourceLabel: string;
}

export interface SessionSummary {
  total: number;
  answered: number;
  skipped: number;
  totalMs: number;
  avgContent: number;
  avgDelivery: number;
}

/** A completed rehearsal, kept in memory for the Relive tab. */
export interface Session {
  id: string;
  dossierId: string;
  jobTitle: string;
  company: string;
  persona: Persona;
  startedAt: number;
  completedAt: number;
  answers: AnswerRecord[];
  summary: SessionSummary;
}
