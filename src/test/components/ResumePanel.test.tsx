import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ResumePanel from "../../components/ResumePanel";

// ResumePanel imports from ../lib/resume, ../lib/accounts, ../lib/splash and
// ../lib/config. Mock all four so the panel renders without touching the
// network. The account region is reactive: it subscribes to
// supabase.auth.onAuthStateChange, which fires INITIAL_SESSION immediately on
// subscribe with the current session. Tests drive that callback with
// fake sessions to flip the panel — no remount, no reload.
const mocks = vi.hoisted(() => ({
  loadResume: vi.fn(),
  saveResume: vi.fn(),
  deleteResume: vi.fn(),
  forgetDevice: vi.fn(),
  readResumeFile: vi.fn(),
  signOutSession: vi.fn(),
  signIn: vi.fn(),
  clearSplashDismissal: vi.fn(),
  requestShowIntro: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("../../lib/resume", () => ({
  MAX_RESUME_CHARS: 20000,
  loadResume: (...args: unknown[]) => mocks.loadResume(...args),
  saveResume: (...args: unknown[]) => mocks.saveResume(...args),
  deleteResume: (...args: unknown[]) => mocks.deleteResume(...args),
  forgetDevice: (...args: unknown[]) => mocks.forgetDevice(...args),
  readResumeFile: (...args: unknown[]) => mocks.readResumeFile(...args),
}));

vi.mock("../../lib/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/accounts")>();
  return {
    ...actual,
    signOutSession: (...args: unknown[]) => mocks.signOutSession(...args),
    signIn: mocks.signIn,
  };
});

vi.mock("../../lib/splash", () => ({
  clearSplashDismissal: (...args: unknown[]) => mocks.clearSplashDismissal(...args),
  requestShowIntro: (...args: unknown[]) => mocks.requestShowIntro(...args),
  hasDismissedSplash: vi.fn().mockReturnValue(true),
  dismissSplash: vi.fn(),
  onShowIntroRequested: vi.fn(),
}));

// The panel subscribes to supabase.auth.onAuthStateChange. The mock returns a
// subscription handle whose callback tests can invoke with fake sessions.
let authCallback: ((event: string, session: { user: unknown } | null) => void) | null = null;

vi.mock("../../lib/config", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (...args: unknown[]) => {
        mocks.onAuthStateChange(...args);
        authCallback = args[0] as typeof authCallback;
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
    },
  },
  ensureAnonSession: vi.fn().mockResolvedValue(true),
}));

function emitAuth(event: string, user: unknown | null) {
  act(() => {
    authCallback?.(event, user ? { user } : null);
  });
}

function anonUser() {
  return { is_anonymous: true, email: null, identities: [] };
}

function emailUser(email: string) {
  return { is_anonymous: false, email, identities: [] };
}

function discordUser(handle: string) {
  return {
    is_anonymous: false,
    email: null,
    identities: [{ provider: "discord", identity_data: { user_name: handle, full_name: handle } }],
  };
}

function githubUser(handle: string) {
  return {
    is_anonymous: false,
    email: null,
    identities: [{ provider: "github", identity_data: { user_name: handle } }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authCallback = null;
  // Anonymous by default — INITIAL_SESSION with an anonymous user.
  mocks.onAuthStateChange.mockImplementation((cb: typeof authCallback) => {
    cb?.("INITIAL_SESSION", { user: anonUser() });
  });
  mocks.loadResume.mockResolvedValue(null);
  mocks.unsubscribe.mockImplementation(() => {
    authCallback = null;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function setup() {
  const onChange = vi.fn();
  const utils = render(<ResumePanel resume={null} onChange={onChange} />);
  // Open the expander so the content is visible.
  fireEvent.click(screen.getByRole("button", { name: /your resume/i }));
  return { onChange, ...utils };
}

describe("ResumePanel — account region (reactive)", () => {
  it("subscribes to onAuthStateChange and unsubscribes on unmount", () => {
    const { unmount } = setup();
    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows the anonymous copy and both buttons, and no sign-out", () => {
    setup();
    expect(screen.getByText(/your resume follows you to another browser/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create an account/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("opens the sign-in form inline from the Sign in button", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    // The shared form is present, and OAuth is reachable from the panel too.
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with discord/i })).toBeInTheDocument();
  });

  it("opens the create-account form inline from Create an account", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /create an account/i }));
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
  });

  it("Back on the account form returns to the quiet anonymous state", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByText(/your resume follows you to another browser/i)).toBeInTheDocument();
  });

  it("a SIGNED_IN event flips the panel to the signed-in state with identity + Sign out, no reload", () => {
    setup();
    // Anonymous initially.
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    // An OAuth redirect return / email sign-in lands as SIGNED_IN.
    emitAuth("SIGNED_IN", emailUser("a@b.com"));
    expect(screen.getByText(/signed in · a@b\.com/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    // No anonymous-only escape hatch for a real account.
    expect(screen.queryByRole("button", { name: /forget me on this device/i })).not.toBeInTheDocument();
  });

  it("a SIGNED_OUT event returns to the anonymous state", () => {
    setup();
    emitAuth("SIGNED_IN", emailUser("a@b.com"));
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    emitAuth("SIGNED_OUT", null);
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your resume follows you to another browser/i)).toBeInTheDocument();
  });

  it("a USER_UPDATED event (email/account change) refreshes the identity", () => {
    setup();
    emitAuth("SIGNED_IN", emailUser("old@b.com"));
    expect(screen.getByText(/signed in · old@b\.com/i)).toBeInTheDocument();
    emitAuth("USER_UPDATED", emailUser("new@b.com"));
    expect(screen.getByText(/signed in · new@b\.com/i)).toBeInTheDocument();
  });

  it("a GitHub sign-in with no email shows the provider + handle", () => {
    setup();
    emitAuth("SIGNED_IN", githubUser("octocat"));
    expect(screen.getByText(/signed in · GitHub · octocat/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("a Discord sign-in with no email shows the provider + @handle", () => {
    setup();
    emitAuth("SIGNED_IN", discordUser("vivi"));
    expect(screen.getByText(/signed in · Discord · @vivi/i)).toBeInTheDocument();
  });

  it("sign-out returns to the anonymous state and reports it (reactive flip)", async () => {
    mocks.signOutSession.mockResolvedValue(true);
    setup();
    emitAuth("SIGNED_IN", emailUser("a@b.com"));
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(mocks.signOutSession).toHaveBeenCalled());
    // The real flow emits SIGNED_OUT then re-signs-in anonymously. Both settle
    // to the anonymous UI, which the subscription reflects without a reload.
    emitAuth("SIGNED_OUT", null);
    emitAuth("SIGNED_IN", anonUser());
    await waitFor(() => expect(screen.getByText(/signed out\. this device is back to a private session/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your resume follows you to another browser/i)).toBeInTheDocument();
  });

  it("surfaces AccountPanel failures as friendly lines, never raw errors", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const { signIn } = await import("../../lib/accounts");
    vi.mocked(signIn).mockResolvedValueOnce({ ok: false, message: "That email and password don't match an account." });

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The ResumePanel keeps a persistent alert region (visually hidden while
    // empty) so screen readers announce updates that land in the same commit —
    // an un-scoped findByRole("alert") matches that empty line first. Find the
    // friendly line itself and confirm it is announced as an alert.
    const friendly = await screen.findByText(/don't match an account/i);
    expect(friendly).toHaveAttribute("role", "alert");
  });

  it("onReady reloads the account's resume in the background", async () => {
    mocks.loadResume.mockResolvedValue({ content: "Account resume", updatedAt: 123 });
    setup();
    // Start anonymous, open the sign-in form, submit it — the email flow's
    // onReady reloads the account's resume in the background.
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    const { signIn } = await import("../../lib/accounts");
    vi.mocked(signIn).mockResolvedValueOnce({ ok: true });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mocks.loadResume).toHaveBeenCalled());
    // The reactive flip shows the signed-in state without a remount.
    emitAuth("SIGNED_IN", emailUser("a@b.com"));
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});

describe("ResumePanel — account control always visible (independent of resume state)", () => {
  it("anonymous + no resume: entry points visible", () => {
    setup();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create an account/i })).toBeInTheDocument();
  });

  it("signed-in + no resume: identity + Sign out visible", () => {
    setup();
    emitAuth("SIGNED_IN", emailUser("a@b.com"));
    expect(screen.getByText(/signed in · a@b\.com/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});

describe("ResumePanel — Show intro again", () => {
  it("renders the link at the bottom and clears the flag then requests the intro", () => {
    setup();
    const link = screen.getByRole("button", { name: /show intro again/i });
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    // Order matters: the flag is cleared first so the intro stays gone until
    // dismissed again, then the app is asked to re-show it.
    expect(mocks.clearSplashDismissal).toHaveBeenCalledTimes(1);
    expect(mocks.requestShowIntro).toHaveBeenCalledTimes(1);
    expect(mocks.clearSplashDismissal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestShowIntro.mock.invocationCallOrder[0],
    );
  });
});
