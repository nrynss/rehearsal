import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ResearchScreen from "../../components/ResearchScreen";
import { makeDossier } from "../helpers/fixtures";

// ResearchScreen imports from ../lib/research (cache helpers + research fns),
// ../lib/config (ensureAnonSession, getAccessToken) and ../lib/ai
// (generateAiBrief, generateFitMatch, clearAiCache, fingerprint). Mock the
// network-touching modules so the smoke test renders instantly and
// deterministically. vi.hoisted: factories are hoisted above consts, so the
// mock fns must be created with vi.hoisted to avoid TDZ errors.
const mocks = vi.hoisted(() => ({
  ensureAnonSession: vi.fn().mockResolvedValue(true),
  getAccessToken: vi.fn().mockReturnValue("token"),
  generateAiBrief: vi.fn().mockResolvedValue(null),
  generateFitMatch: vi.fn().mockResolvedValue(null),
  clearAiCache: vi.fn(),
  fingerprint: vi.fn().mockReturnValue("fp"),
}));

vi.mock("../../lib/config", () => ({
  ensureAnonSession: (...args: unknown[]) => mocks.ensureAnonSession(...args),
  getAccessToken: (...args: unknown[]) => mocks.getAccessToken(...args),
}));

vi.mock("../../lib/research", () => ({
  cacheGet: vi.fn().mockReturnValue(null),
  cacheSet: vi.fn(),
  cacheHas: vi.fn().mockReturnValue(false),
  cleanCompanyUrl: vi.fn(),
  researchCompany: vi.fn(),
  researchJob: vi.fn(),
  researchNews: vi.fn(),
}));

vi.mock("../../lib/ai", () => ({
  generateAiBrief: (...args: unknown[]) => mocks.generateAiBrief(...args),
  generateFitMatch: (...args: unknown[]) => mocks.generateFitMatch(...args),
  clearAiCache: (...args: unknown[]) => mocks.clearAiCache(...args),
  fingerprint: (...args: unknown[]) => mocks.fingerprint(...args),
}));

const baseProps = {
  dossiers: [] as ReturnType<typeof makeDossier>[],
  onDossiersChange: vi.fn(),
  headingId: "main-heading-research",
  mode: "text" as const,
  onModeChange: vi.fn(),
  voiceUnsupported: true,
  resume: null,
  onResumeChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResearchScreen", () => {
  it("renders the heading, URL input and empty state when there are no dossiers", async () => {
    render(<ResearchScreen {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Research" })).toBeInTheDocument();
    expect(screen.getByLabelText(/linkedin job posting url/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run research/i })).toBeInTheDocument();
    expect(screen.getByText("No dossiers yet")).toBeInTheDocument();
  });

  it("renders a dossier entry when one exists", () => {
    const d = makeDossier();
    render(<ResearchScreen {...baseProps} dossiers={[d]} />);
    expect(screen.getByText("Senior Engineer")).toBeInTheDocument();
    expect(screen.getByText(/acme ·/i)).toBeInTheDocument();
  });
});
