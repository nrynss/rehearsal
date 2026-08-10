import { describe, expect, it } from "vitest";
import { avgScore, contentBand, fmtDuration, missedTotal, scoreAnswer, weakestContentAxis, wordCount } from "../../lib/score";
import type { InterviewQuestion } from "../../lib/types";

/** A question whose key points include the company/role/location grounding
 *  points a real dossier question has. */
const QUESTION: InterviewQuestion = {
  id: "q1",
  text: "Walk me through why you're a strong fit for this role.",
  keyPoints: [
    { label: "Name the company", facts: ["acme"] },
    { label: "Name the role", facts: ["engineer"] },
    { label: "Reference the location", facts: ["berlin"] },
    { label: "Reference the JD line", facts: ["typescript", "react"] },
  ],
  modelAnswer: "…",
  sourceCard: "job",
  sourceLabel: "job · linkedin.com",
};

describe("wordCount", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("one two three")).toBe(3);
  });

  it("ignores leading/trailing whitespace and collapses runs", () => {
    expect(wordCount("   one   two   ")).toBe(2);
  });

  it("returns 0 for empty or blank strings", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("fmtDuration", () => {
  it("renders seconds alone under a minute", () => {
    expect(fmtDuration(30_000)).toBe("30s");
  });

  it("renders minutes and seconds over a minute", () => {
    expect(fmtDuration(90_000)).toBe("1m 30s");
  });

  it("clamps negative durations to 0s", () => {
    expect(fmtDuration(-500)).toBe("0s");
  });

  it("rounds partial seconds", () => {
    expect(fmtDuration(1_400)).toBe("1s");
    expect(fmtDuration(1_600)).toBe("2s");
  });
});

describe("scoreAnswer content rubric", () => {
  it("gives perfect relevance when every grounding fact is hit", () => {
    const score = scoreAnswer("I'm an engineer at Acme and I worked in Berlin, using TypeScript and React.", 60_000, QUESTION);
    const relevance = score.content.find((c) => c.label === "Relevance")?.score;
    expect(relevance).toBe(5);
  });

  it("scores structure by length (long answers = complete/ordered)", () => {
    const long = "word ".repeat(120).trim();
    const score = scoreAnswer(long, 60_000, QUESTION);
    expect(score.content.find((c) => c.label === "Structure")?.score).toBe(5);
  });

  it("flags missed key points that the answer never touches", () => {
    const score = scoreAnswer("I like working on hard problems.", 60_000, QUESTION);
    expect(score.missed).toEqual(["Name the company", "Name the role", "Reference the location", "Reference the JD line"]);
  });
});

describe("scoreAnswer delivery rubric", () => {
  it("scores pace 5 for a natural 130 wpm", () => {
    // 130 words in 60s == 130 wpm
    const text = Array.from({ length: 130 }, (_, i) => `word${i}`).join(" ");
    const score = scoreAnswer(text, 60_000, QUESTION);
    expect(score.delivery.find((c) => c.label === "Pace")?.score).toBe(5);
  });

  it("scores pace 3 for typed answers (durationMs <= 0)", () => {
    const score = scoreAnswer("A typed answer, not timed.", 0, QUESTION);
    expect(score.delivery.find((c) => c.label === "Pace")?.score).toBe(3);
  });

  it("downgrades filler-heavy answers", () => {
    const text = Array.from({ length: 20 }, () => "um").join(" ") + " and also a real sentence here";
    const score = scoreAnswer(text, 60_000, QUESTION);
    expect(score.delivery.find((c) => c.label === "Filler rate")?.score).toBeLessThan(5);
  });

  it("rewards answers with no filler or hesitation", () => {
    const text = "I have deep experience building React applications for large teams.".repeat(3);
    const score = scoreAnswer(text, 60_000, QUESTION);
    expect(score.delivery.find((c) => c.label === "Filler rate")?.score).toBe(5);
    expect(score.delivery.find((c) => c.label === "Hesitation")?.score).toBe(5);
  });
});

describe("scoreAnswer determinism", () => {
  it("is deterministic — same input, same output", () => {
    const a = scoreAnswer("Acme engineer in Berlin with React and TypeScript.", 45_000, QUESTION);
    const b = scoreAnswer("Acme engineer in Berlin with React and TypeScript.", 45_000, QUESTION);
    expect(a).toEqual(b);
  });
});

describe("avgScore", () => {
  it("keeps one decimal place instead of rounding to an integer", () => {
    expect(avgScore([{ score: 1 }, { score: 2 }])).toBe(1.5);
    expect(avgScore([{ score: 1 }, { score: 1 }, { score: 2 }])).toBe(1.3);
    expect(avgScore([{ score: 4 }, { score: 4 }])).toBe(4);
  });

  it("returns 0 for an empty list — the no-answers sentinel", () => {
    expect(avgScore([])).toBe(0);
  });
});

describe("contentBand", () => {
  it("reads below 2.0 as not ready", () => {
    expect(contentBand(0)).toBe("not-ready");
    expect(contentBand(1.9)).toBe("not-ready");
  });

  it("reads 2.0 through 3.4 as almost", () => {
    expect(contentBand(2)).toBe("almost");
    expect(contentBand(3.4)).toBe("almost");
  });

  it("reads 3.5 and above as ready", () => {
    expect(contentBand(3.5)).toBe("ready");
    expect(contentBand(5)).toBe("ready");
  });
});

describe("weakestContentAxis", () => {
  const axis = (label: string, score: number) => ({ label, score });

  it("finds the lowest average across answered questions", () => {
    const answers = [
      { content: [axis("Relevance", 4), axis("Specificity", 2), axis("Structure", 3)] },
      { content: [axis("Relevance", 3), axis("Specificity", 3), axis("Structure", 3)] },
    ];
    // Relevance averages 3.5, Specificity 2.5, Structure 3 — Specificity is weakest.
    expect(weakestContentAxis(answers)).toEqual({ label: "Specificity", avg: 2.5 });
  });

  it("returns null when no answer carries content scores", () => {
    expect(weakestContentAxis([{ content: [] }])).toBeNull();
    expect(weakestContentAxis([])).toBeNull();
  });
});

describe("missedTotal", () => {
  it("sums missed key points across answers", () => {
    expect(missedTotal([{ missed: ["a", "b"] }, { missed: ["c"] }, { missed: [] }])).toBe(3);
  });

  it("is 0 for a clean run", () => {
    expect(missedTotal([{ missed: [] }, { missed: [] }])).toBe(0);
  });
});
