import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RehearseScreen from "../../components/RehearseScreen";
import { makeDossier } from "../helpers/fixtures";

// The screen imports ai (generateAiQuestions, scoreWithAi), audio
// (pickMimeType, transcribeBlob, ...), score (pure), config (callEdge...).
// Mock the network/audio-touching modules; scoreAnswer stays real.
// vi.hoisted: factories are hoisted above consts, so the mock fns must be
// created with vi.hoisted to avoid TDZ errors.
const mocks = vi.hoisted(() => ({
  generateAiQuestions: vi.fn().mockResolvedValue(null),
  scoreWithAi: vi.fn().mockResolvedValue(null),
  pickMimeType: vi.fn().mockReturnValue(null), // voice unsupported
  transcribeBlob: vi.fn(),
  speakQuestion: vi.fn(),
  stopQuestionAudio: vi.fn(),
}));

vi.mock("../../lib/ai", () => ({
  generateAiQuestions: (...args: unknown[]) => mocks.generateAiQuestions(...args),
  scoreWithAi: (...args: unknown[]) => mocks.scoreWithAi(...args),
}));

vi.mock("../../lib/audio", () => ({
  pickMimeType: (...args: unknown[]) => mocks.pickMimeType(...args),
  transcribeBlob: (...args: unknown[]) => mocks.transcribeBlob(...args),
  speakQuestion: (...args: unknown[]) => mocks.speakQuestion(...args),
  stopQuestionAudio: (...args: unknown[]) => mocks.stopQuestionAudio(...args),
  extFor: () => "webm",
}));

const baseProps = {
  dossiers: [] as ReturnType<typeof makeDossier>[],
  onSessionComplete: vi.fn(),
  goResearch: vi.fn(),
  onRunningChange: vi.fn(),
  headingId: "main-heading-rehearse",
  mode: "text" as const,
  onModeChange: vi.fn(),
  voiceUnsupported: true,
  resumeText: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RehearseScreen", () => {
  it("renders the empty state with a Go to Research CTA when there are no dossiers", () => {
    render(<RehearseScreen {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Rehearse" })).toBeInTheDocument();
    expect(screen.getByText("Nothing to rehearse yet")).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /go to research/i });
    expect(cta).toBeInTheDocument();
  });

  it("lists a dossier as a selectable job when one exists", () => {
    render(<RehearseScreen {...baseProps} dossiers={[makeDossier()]} />);
    expect(screen.getByText("Senior Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /begin interview/i })).toBeInTheDocument();
  });
});
