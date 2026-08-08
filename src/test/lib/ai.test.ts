import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAiCache,
  fingerprint,
  generateAiBrief,
  generateAiQuestions,
  generateFitMatch,
  scoreWithAi,
} from "../../lib/ai";
import type { Dossier, InterviewQuestion } from "../../lib/types";

// ai.ts imports { callEdge } from ./config. Mock it so no network call ever
// happens in unit tests; each test sets the response the edge returns.
// vi.hoisted: vi.mock factories are hoisted above const declarations, so the
// mock fn must be created with vi.hoisted to avoid a temporal-dead-zone error.
const callEdgeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config", () => ({ callEdge: (...args: unknown[]) => callEdgeMock(...args) }));

const JOB_URL = "https://www.linkedin.com/jobs/view/4440232349/";

function okCard(step: "job" | "company" | "news") {
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

function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    id: "d1",
    jobTitle: "Senior Engineer",
    company: "Acme",
    jobUrl: JOB_URL,
    createdAt: 0,
    cards: [okCard("job"), okCard("company"), okCard("news")],
    brief: [],
    ...overrides,
  };
}

beforeEach(() => {
  callEdgeMock.mockReset();
  // ai.ts keeps a module-level session cache keyed on dossier URL / resume
  // fingerprint. Successful responses persist across tests in this file, so
  // clear the cache before each test or a cache hit would skip the mock and
  // make a later test pass (or fail) for the wrong reason.
  clearAiCache("ai_");
});

describe("fingerprint", () => {
  it("returns 'none' for missing text", () => {
    expect(fingerprint(null)).toBe("none");
    expect(fingerprint("")).toBe("none");
    expect(fingerprint(undefined)).toBe("none");
  });

  it("is deterministic for the same text", () => {
    expect(fingerprint("same resume")).toBe(fingerprint("same resume"));
  });

  it("changes when the text changes", () => {
    expect(fingerprint("resume A")).not.toBe(fingerprint("resume B"));
  });
});

describe("generateAiBrief", () => {
  it("requests ai-brief with the dossier's three ok cards and returns cleaned sections", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      sections: [
        {
          heading: "The role",
          claims: [
            { text: "  Own the remit end to end.  ", source: "job" },
            { text: "", source: "job" },
            { text: "   ", source: "job" },
          ],
        },
        { heading: "", claims: [{ text: "orphan claim", source: "job" }] },
      ],
    });
    const brief = await generateAiBrief(makeDossier());
    expect(callEdgeMock).toHaveBeenCalledWith(
      "ai-brief",
      expect.objectContaining({ jobUrl: JOB_URL, job: expect.anything(), company: expect.anything(), news: expect.anything() }),
    );
    expect(brief).toEqual([
      {
        heading: "The role",
        claims: [{ text: "Own the remit end to end.", source: "job" }],
      },
    ]);
  });

  it("returns null when the edge response is not ok", async () => {
    callEdgeMock.mockResolvedValue({ status: "failed" });
    await expect(generateAiBrief(makeDossier())).resolves.toBeNull();
  });

  it("returns null when the edge call throws", async () => {
    callEdgeMock.mockRejectedValue(new Error("network"));
    await expect(generateAiBrief(makeDossier())).resolves.toBeNull();
  });
});

describe("generateAiQuestions", () => {
  const rawQuestion = {
    id: "q1",
    text: "  Tell me about Acme.  ",
    keyPoints: [
      { label: "Name the company", facts: ["acme", "ACME"] }, // lowercased but NOT deduped
      { label: "", facts: ["orphan"] }, // empty label → dropped
      { label: "Name the location", facts: ["Berlin"] },
    ],
    modelAnswer: "  Acme builds tools.  ",
    sourceCard: "company",
    sourceLabel: "company · linkedin.com",
  };

  it("sends the resume (trimmed) and returns cleaned questions, capped at 6", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", questions: [rawQuestion, { text: "" }, { text: "  " }] });
    const qs = await generateAiQuestions(makeDossier(), "  my resume  ");
    expect(callEdgeMock).toHaveBeenCalledWith("ai-questions", expect.objectContaining({ resume: "my resume" }));
    expect(qs?.length).toBe(1);
    expect(qs?.[0]).toEqual({
      id: "q1",
      text: "Tell me about Acme.",
      keyPoints: [
        { label: "Name the company", facts: ["acme", "acme"] },
        { label: "Name the location", facts: ["berlin"] },
      ],
      modelAnswer: "Acme builds tools.",
      sourceCard: "company",
      sourceLabel: "company · linkedin.com",
    });
  });

  it("falls back to a generated id and source label when missing", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      questions: [{ text: "Some question without ids", keyPoints: [], sourceCard: "weird" }],
    });
    const qs = await generateAiQuestions(makeDossier(), null);
    expect(qs?.[0].id).toBe("ai-1");
    expect(qs?.[0].sourceCard).toBe("job");
    expect(qs?.[0].sourceLabel).toBe("job · source");
  });

  it("returns null when no usable questions come back", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", questions: [] });
    await expect(generateAiQuestions(makeDossier(), null)).resolves.toBeNull();
  });
});

describe("generateFitMatch", () => {
  it("returns a cleaned fit match", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      strengths: [{ text: "  React  ", evidence: " 3 years  " }, { text: "" }],
      gaps: [{ text: "Python" }],
      studyPlan: ["Learn Python", "", "   "],
      verdict: "  Good fit  ",
    });
    const fit = await generateFitMatch(makeDossier(), "my resume");
    expect(fit).toEqual({
      strengths: [{ text: "React", evidence: "3 years" }],
      gaps: [{ text: "Python" }],
      studyPlan: ["Learn Python"],
      verdict: "Good fit",
    });
  });

  it("returns null when strengths/gaps/plan are all empty (nothing to say)", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", strengths: [], gaps: [], studyPlan: [] });
    await expect(generateFitMatch(makeDossier(), "my resume")).resolves.toBeNull();
  });

  it("returns null with no resume", async () => {
    await expect(generateFitMatch(makeDossier(), "   ")).resolves.toBeNull();
  });

  it("returns null when the job card is missing", async () => {
    const d = makeDossier({ cards: [okCard("company"), okCard("news")] });
    await expect(generateFitMatch(d, "my resume")).resolves.toBeNull();
  });
});

describe("scoreWithAi", () => {
  const question: InterviewQuestion = {
    id: "q1",
    text: "Tell me about yourself.",
    keyPoints: [],
    modelAnswer: "",
    sourceCard: "job",
    sourceLabel: "job · linkedin.com",
  };

  it("cleans, clamps and backfills rubric scores", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      content: [{ label: "Relevance", score: 9 }, { label: "Specificity", score: 2.6 }],
      delivery: [],
      missed: ["  something  "],
    });
    const result = await scoreWithAi(question, "my answer", 45_000);
    expect(result?.content).toEqual([
      { label: "Relevance", score: 5 },
      { label: "Specificity", score: 3 },
      { label: "Structure", score: 3 }, // backfilled
    ]);
    expect(result?.delivery).toEqual([
      { label: "Pace", score: 3 },
      { label: "Filler rate", score: 3 },
      { label: "Hesitation", score: 3 },
      { label: "Answer length", score: 3 },
    ]);
    expect(result?.missed).toEqual(["  something  "]); // filtered, not trimmed
  });

  it("dedupes rubric labels by name", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      content: [{ label: "Relevance", score: 4 }, { label: "Relevance", score: 1 }],
      delivery: [],
      missed: [],
    });
    const result = await scoreWithAi(question, "answer", 10_000);
    expect(result?.content.filter((c) => c.label === "Relevance")).toHaveLength(1);
  });

  it("returns null when the call fails", async () => {
    callEdgeMock.mockResolvedValue({ status: "failed" });
    await expect(scoreWithAi(question, "a different answer", 10_000)).resolves.toBeNull();
  });
});

describe("edge-function routing contract", () => {
  // The client never picks a model — that lives in the deployed edge functions
  // (FEATHERLESS_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash"). What the client
  // owns is *which* edge function each helper calls and with what payload.
  // Lock that contract here so a rename/re-route is caught in CI.
  it("routes briefs to ai-brief", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", sections: [{ heading: "H", claims: [{ text: "c", source: "job" }] }] });
    await generateAiBrief(makeDossier());
    expect(callEdgeMock).toHaveBeenCalledWith("ai-brief", expect.any(Object));
  });

  it("routes questions to ai-questions", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", questions: [{ text: "Q", keyPoints: [], sourceCard: "job" }] });
    await generateAiQuestions(makeDossier(), null);
    expect(callEdgeMock).toHaveBeenCalledWith("ai-questions", expect.any(Object));
  });

  it("routes fit matches to ai-fit", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", strengths: [{ text: "React" }], gaps: [], studyPlan: [] });
    await generateFitMatch(makeDossier(), "resume");
    expect(callEdgeMock).toHaveBeenCalledWith("ai-fit", expect.any(Object));
  });

  it("routes answer scoring to ai-score", async () => {
    const q: InterviewQuestion = {
      id: "q1",
      text: "T",
      keyPoints: [],
      modelAnswer: "",
      sourceCard: "job",
      sourceLabel: "job · linkedin.com",
    };
    callEdgeMock.mockResolvedValue({ status: "ok", content: [], delivery: [], missed: [] });
    await scoreWithAi(q, "answer", 0);
    expect(callEdgeMock).toHaveBeenCalledWith("ai-score", expect.any(Object));
  });
});

describe("clearAiCache", () => {
  it("is safe to call — drops nothing when empty and does not throw", () => {
    expect(() => clearAiCache("ai_fit:")).not.toThrow();
    expect(() => clearAiCache("")).not.toThrow();
  });
});
