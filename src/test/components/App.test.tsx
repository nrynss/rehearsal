import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../../App";

// App's boot path: ensure an anonymous session, then touch resume activity and
// load the resume — in parallel, neither awaited. This test owns that boot
// contract (one RPC per mount, failures swallowed), so the network-touching
// modules and the four screens are stubbed.
// vi.hoisted: factories are hoisted above consts, so the mock fns must be
// created with vi.hoisted to avoid TDZ errors.
const mocks = vi.hoisted(() => ({
  ensureAnonSession: vi.fn(),
  rpc: vi.fn(),
  loadResume: vi.fn(),
  hasDismissedSplash: vi.fn(),
  dismissSplash: vi.fn(),
  pickMimeType: vi.fn(),
  onAuthStateChange: vi.fn(),
}));

vi.mock("../../lib/config", () => ({
  ensureAnonSession: (...args: unknown[]) => mocks.ensureAnonSession(...args),
  supabase: {
    rpc: (...args: unknown[]) => mocks.rpc(...args),
    auth: { onAuthStateChange: (...args: unknown[]) => mocks.onAuthStateChange(...args) },
  },
}));

vi.mock("../../lib/resume", () => ({
  loadResume: (...args: unknown[]) => mocks.loadResume(...args),
}));

vi.mock("../../lib/splash", () => ({
  hasDismissedSplash: (...args: unknown[]) => mocks.hasDismissedSplash(...args),
  dismissSplash: (...args: unknown[]) => mocks.dismissSplash(...args),
}));

vi.mock("../../lib/audio", () => ({
  pickMimeType: (...args: unknown[]) => mocks.pickMimeType(...args),
}));

// Stub the four screens: App renders them behind Tabs, but this test only
// cares about the session → activity-touch boot path.
vi.mock("../../components/SplashScreen", () => ({ default: () => null }));
vi.mock("../../components/ResearchScreen", () => ({ default: () => <div>research stub</div> }));
vi.mock("../../components/RehearseScreen", () => ({ default: () => <div>rehearse stub</div> }));
vi.mock("../../components/ReliveScreen", () => ({ default: () => <div>relive stub</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureAnonSession.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.loadResume.mockResolvedValue(null);
  mocks.hasDismissedSplash.mockReturnValue(true); // splash already dismissed
  mocks.pickMimeType.mockReturnValue(null); // voice unsupported → text mode
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

describe("App — resume activity touch", () => {
  it("touches resume activity exactly once per mount, only after the session resolves", async () => {
    render(<App />);
    // Not before the anonymous session exists — the RPC must not fire on a
    // sessionless boot.
    expect(mocks.rpc).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith("touch_resume_activity");
  });

  it("swallows touch_resume_activity failures without breaking the app", async () => {
    mocks.rpc.mockRejectedValue(new Error("rpc down"));
    render(<App />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    // The rejection is handled (no unhandled rejection) and the app renders.
    expect(screen.getByText("Rehearsal")).toBeInTheDocument();
  });
});
