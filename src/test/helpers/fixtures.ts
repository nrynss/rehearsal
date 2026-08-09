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

/**
 * Real-world test case: Anita Fernandes — Senior QA Automation Engineer,
 * Bengaluru. Saved against job https://www.linkedin.com/jobs/view/4440232349/
 * (Principal QA Engineer, Deltek) in the live app. Playwright / TypeScript /
 * GitHub Actions, 9 years — matches the posting's QA-automation ask on paper,
 * which is exactly what the fit match and questions should probe.
 */
export const RESUME_QA = `Anita Fernandes
Senior QA Automation Engineer · Bengaluru, India
anita.fernandes@example.com · linkedin.com/in/example-anita

Summary
Test automation engineer with 9 years building and owning end-to-end automation for B2B SaaS products. Deep Playwright and TypeScript experience, strong CI/CD ownership, and a track record of taking flaky, slow suites and making them fast and trusted. Comfortable mentoring and setting team-wide testing standards.

Experience

Staff QA Engineer — Sentinal Systems (2022 – present)
- Owned the migration of the core regression suite from Selenium to Playwright across three product surfaces — 1,400 tests, cut wall-clock run time from 52 to 11 minutes.
- Built the shared automation framework in TypeScript used by four squads: fixtures, page objects, custom matchers, parallel sharding, and a retry policy that distinguishes genuine failures from infrastructure noise.
- Own the GitHub Actions pipeline for the QA org — PR gates, nightly full runs, and a quarantine lane for known-flaky tests with automatic escalation after 5 days.
- Cut flake rate from 8% to under 1% over two quarters by instrumenting every failure and classifying causes. Wrote a small LLM-backed triage helper (OpenAI API) that reads a failure's stack trace, screenshot and diff, and suggests a likely cause and owner — roughly 70% of suggestions accepted by engineers.
- Heavy use of GitHub Copilot for test authoring; introduced prompt patterns the team uses to generate first-draft specs from acceptance criteria.
- Mentor three mid-level QA engineers; run a fortnightly automation guild.

Senior QA Engineer — Northbay Retail Tech (2019 – 2022)
- Built API test coverage for REST and GraphQL services — contract tests, schema validation, and data-driven suites in Python (pytest).
- Designed the test data strategy: seeded environments, factory helpers, and SQL validation of order and inventory state after each run.
- Ran performance testing with k6 for checkout and search; found and helped fix a connection-pool exhaustion bug that had caused two Black Friday incidents.
- Set up Jenkins pipelines and later moved the team to GitHub Actions.

QA Engineer — Meridian Software (2017 – 2019)
- Manual and automated testing for a healthcare scheduling product.
- Wrote the team's first Selenium suite; introduced the bug triage process still in use.

Skills
Automation: Playwright (2 yrs), Selenium (6 yrs), pytest, k6, REST Assured
Languages: TypeScript, Python, JavaScript, SQL
CI/CD: GitHub Actions, Jenkins, Docker
Testing: API (REST/GraphQL), contract testing, performance, test data design, accessibility basics
Practice: Agile/Scrum, risk-based testing, mentoring, test strategy

Education
B.E. Computer Science — Visvesvaraya Technological University, 2016

Certifications
- ISTQB Advanced Test Automation Engineer (2021)
- AWS Certified Cloud Practitioner (2023)`;

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    dossierId: "d1",
    jobTitle: "Senior Engineer",
    company: "Acme",
    persona: { id: "hm", label: "Hiring Manager", name: "Sarah Okonkwo", voice: "Sarah" },
    startedAt: 0,
    completedAt: 1_700_000_000_000,
    answers: [],
    summary: { total: 0, answered: 0, skipped: 0, totalMs: 0, avgContent: 0, avgDelivery: 0 },
    ...overrides,
  };
}
