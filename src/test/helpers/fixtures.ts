import type { Dossier, Session } from "../../lib/types";

export const JOB_URL = "https://www.linkedin.com/jobs/view/4440232349/";

export function okCard(step: "job" | "company" | "news") {
  return {
    step,
    state: "ok" as const,
    payload: {
      status: "ok" as const,
      kind: step,
      label: step,
      raw: {},
    },
  };
}

export function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  const job = okCard("job");
  return {
    id: "d1",
    jobTitle: "Senior Engineer",
    company: "Acme",
    jobUrl: JOB_URL,
    createdAt: 0,
    cards: [
      // The job card carries the fields finishDossier derives the dossier
      // title/company from — without them a dossier that passes through
      // `finishDossier` (as the fit-match flow does) collapses to
      // "Researching…" / "Unknown company".
      { ...job, payload: { ...job.payload, title: "Senior Engineer", company: "Acme" } },
      okCard("company"),
      okCard("news"),
    ],
    brief: [],
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    dossierId: "d1",
    jobTitle: "Senior Engineer",
    company: "Acme",
    persona: { id: "hm", label: "Hiring Manager", voice: "Sarah" },
    startedAt: 0,
    completedAt: 1_700_000_000_000,
    answers: [],
    summary: { total: 0, answered: 0, skipped: 0, totalMs: 0, avgContent: 0, avgDelivery: 0 },
    ...overrides,
  };
}
