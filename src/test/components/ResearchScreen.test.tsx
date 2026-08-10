import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import ResearchScreen from "../../components/ResearchScreen";
import { makeDossier } from "../helpers/fixtures";
import type { Dossier, FitMatch } from "../../lib/types";

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
  // ResumePanel subscribes to supabase.auth.onAuthStateChange; return a
  // subscription handle with an unsubscribe no-op.
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
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
    // The title appears in the expander header AND the job card body.
    expect(screen.getAllByText("Senior Engineer").length).toBeGreaterThan(0);
    expect(screen.getByText(/acme ·/i)).toBeInTheDocument();
  });

  it("lands the fit match even though the claim re-renders the effect before the AI call resolves", async () => {
    // Regression test: the fit-match effect claims a dossier by writing
    // `fitStatus: "generating"`, which re-renders and tears down the effect's
    // first run. A cleanup guard then cancelled the in-flight AI call, so the
    // result was discarded and the dossier stayed on "generating" forever. The
    // write must survive that re-render (guarded by the `fitKey` re-check, not
    // by effect cleanup).
    const fit: FitMatch = {
      verdict: "You fit this posting.",
      strengths: [{ text: "React experience", evidence: "5 years React" }],
      gaps: [{ text: "No Kubernetes", evidence: "posting requires k8s" }],
      studyPlan: ["Kubernetes basics"],
    };
    let resolveFit: (v: FitMatch | null) => void = () => undefined;
    mocks.generateFitMatch.mockReturnValue(
      new Promise<FitMatch | null>((resolve) => {
        resolveFit = resolve;
      }),
    );

    // Drive state through the same functional updater App uses, so the claim
    // write actually lands and re-renders.
    function Harness() {
      const [dossiers, setDossiers] = useState<Dossier[]>([]);
      const [resume, setResume] = useState<{ content: string } | null>(null);
      return (
        <>
          <button onClick={() => setDossiers([makeDossier()])}>add dossier</button>
          <button onClick={() => setResume({ content: "My resume" })}>add resume</button>
          <ResearchScreen
            {...baseProps}
            dossiers={dossiers}
            onDossiersChange={(update) => setDossiers((prev) => update(prev))}
            resume={resume as never}
            onResumeChange={(r) => setResume(r as { content: string } | null)}
          />
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "add dossier" }));
    fireEvent.click(screen.getByRole("button", { name: "add resume" }));

    // Open the dossier expander so the fit match section is visible.
    fireEvent.click(screen.getByRole("button", { name: /senior engineer/i }));

    // The claim has re-rendered; the AI call is still in flight.
    expect(await screen.findByText(/measuring your resume against this posting/i)).toBeInTheDocument();

    await act(async () => {
      resolveFit(fit);
    });
    // The fit must land despite the effect having been torn down and re-run.
    expect(await screen.findByText(/You fit this posting/i)).toBeInTheDocument();
    expect(screen.getByText("What you already have")).toBeInTheDocument();
    expect(screen.getByText("React experience")).toBeInTheDocument();
    expect(screen.queryByText(/measuring your resume against this posting/i)).not.toBeInTheDocument();
  });
});
