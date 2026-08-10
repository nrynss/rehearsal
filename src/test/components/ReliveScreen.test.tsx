import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReliveScreen from "../../components/ReliveScreen";
import { makeSession } from "../helpers/fixtures";
import type { AnswerRecord } from "../../lib/types";

const CONTENT_AXES = [
  { label: "Relevance", score: 4 },
  { label: "Specificity", score: 2 },
  { label: "Structure", score: 3 },
];

/** One answered question whose rubric numbers make the session's averages
 *  land on clean one-decimal values. */
function answeredQuestion(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    questionId: "q1",
    questionText: "Walk me through your background.",
    sourceCard: "job",
    skipped: false,
    transcript: "I am an engineer at Acme, in Berlin, working with TypeScript and React.",
    durationMs: 30_000,
    content: CONTENT_AXES,
    delivery: [
      { label: "Pace", score: 3 },
      { label: "Filler rate", score: 4 },
      { label: "Hesitation", score: 4 },
      { label: "Answer length", score: 5 },
    ],
    missed: ["Name the company"],
    modelAnswer: "…",
    sourceLabel: "job · linkedin.com",
    ...overrides,
  };
}

describe("ReliveScreen", () => {
  it("renders the empty state when there are no sessions", () => {
    render(<ReliveScreen sessions={[]} headingId="main-heading-relive" />);
    expect(screen.getByRole("heading", { name: "Relive" })).toBeInTheDocument();
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
  });

  it("lists a completed session when one exists", () => {
    const session = makeSession({
      summary: {
        total: 3,
        answered: 2,
        skipped: 1,
        totalMs: 120_000,
        avgContent: 3,
        avgDelivery: 4,
        missedTotal: 5,
      },
    });
    render(<ReliveScreen sessions={[session]} />);
    expect(screen.getByText("Senior Engineer · Acme")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // answered
    expect(screen.getByText("1")).toBeInTheDocument(); // skipped
  });

  it("renders the verdict, scaled averages, demoted attendance and the missed total", () => {
    const session = makeSession({
      summary: {
        total: 1,
        answered: 1,
        skipped: 0,
        totalMs: 30_000,
        avgContent: 3,
        avgDelivery: 4,
        missedTotal: 1,
      },
      answers: [answeredQuestion()],
    });
    render(<ReliveScreen sessions={[session]} />);

    // The verdict is derived from the content average alone (3 → one more
    // rehearsal), and is the largest element in the summary.
    expect(
      screen.getByText("One more rehearsal before the interview — the answers touch the research but don't fully carry it."),
    ).toBeInTheDocument();

    // Averages keep one decimal and show their scale.
    expect(screen.getByText("3.0")).toBeInTheDocument();
    expect(screen.getByText("4.0")).toBeInTheDocument();
    expect(screen.getAllByText("/5")).toHaveLength(2);

    // The weakest content axis is named under the verdict.
    expect(screen.getByText(/Specificity is the weakest content axis, averaging 2\.0/)).toBeInTheDocument();

    // Missed total surfaces as its own line.
    expect(screen.getByText("1 key point missed across 1 question.")).toBeInTheDocument();
  });

  it("renders the not-ready verdict for a low content average", () => {
    const session = makeSession({
      summary: {
        total: 2,
        answered: 2,
        skipped: 0,
        totalMs: 60_000,
        avgContent: 1.5,
        avgDelivery: 4,
        missedTotal: 8,
      },
      answers: [
        answeredQuestion({ questionId: "q1", content: CONTENT_AXES.map((a) => ({ ...a, score: 1 })) }),
        answeredQuestion({
          questionId: "q2",
          questionText: "Tell me about a hard problem.",
          transcript: "Some short answer.",
          content: CONTENT_AXES.map((a) => ({ ...a, score: 2 })),
          missed: ["Name the company", "Name the role", "Reference the location", "Reference the JD line"],
        }),
      ],
    });
    render(<ReliveScreen sessions={[session]} />);

    expect(screen.getByText(/Rehearse again before this interview/)).toBeInTheDocument();
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText("8 key points missed across 2 questions.")).toBeInTheDocument();
  });

  it("handles a session where nothing was answered", () => {
    const session = makeSession({
      summary: {
        total: 2,
        answered: 0,
        skipped: 2,
        totalMs: 0,
        avgContent: 0,
        avgDelivery: 0,
        missedTotal: 0,
      },
      answers: [
        {
          questionId: "q1",
          questionText: "Walk me through your background.",
          sourceCard: "job",
          skipped: true,
          transcript: "",
          durationMs: 0,
          content: [],
          delivery: [],
          missed: [],
          modelAnswer: "…",
          sourceLabel: "job · linkedin.com",
        },
        {
          questionId: "q2",
          questionText: "Tell me about a hard problem.",
          sourceCard: "job",
          skipped: true,
          transcript: "",
          durationMs: 0,
          content: [],
          delivery: [],
          missed: [],
          modelAnswer: "…",
          sourceLabel: "job · linkedin.com",
        },
      ],
    });
    render(<ReliveScreen sessions={[session]} />);

    // No verdict is derivable from content alone — the summary says what the
    // session amounted to without grading delivery.
    expect(screen.getByText("Nothing was answered — rehearse again before the interview.")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument(); // answered
    expect(screen.getByText("2")).toBeInTheDocument(); // skipped
    expect(screen.getAllByText("—")).toHaveLength(2); // averages show the empty sentinel
  });
});
