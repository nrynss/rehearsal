import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SplashScreen from "../../components/SplashScreen";
import { createAccount, linkWithProvider, resetPassword, signIn } from "../../lib/accounts";
import { ensureAnonSession } from "../../lib/config";
import { dismissSplash } from "../../lib/splash";

vi.mock("../../lib/accounts", () => ({
  createAccount: vi.fn(),
  signIn: vi.fn(),
  linkWithProvider: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock("../../lib/config", () => ({
  ensureAnonSession: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/splash", () => ({
  dismissSplash: vi.fn(),
}));

function setup() {
  const onStart = vi.fn();
  const onAccountReady = vi.fn();
  const utils = render(
    <SplashScreen returningUser={false} onStart={onStart} onAccountReady={onAccountReady} />,
  );
  return { onStart, onAccountReady, ...utils };
}

describe("SplashScreen", () => {
  it("renders the intro: heading, tagline, three tabs and the ways in", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Rehearsal" })).toBeInTheDocument();
    expect(screen.getByText(/Every question comes from this posting/)).toBeInTheDocument();

    // The three tabs, all visible at once — never paged.
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Rehearse")).toBeInTheDocument();
    expect(screen.getByText("Relive")).toBeInTheDocument();
    expect(screen.getByText(/scrapes the posting, the company and recent news/i)).toBeInTheDocument();
    expect(screen.getByText(/hiring manager interviews you aloud/i)).toBeInTheDocument();
    expect(screen.getByText(/scored against what the research found/i)).toBeInTheDocument();

    // The ways in — Start is dominant; GitHub and Discord secondary; email
    // + password quietest beneath. The standalone intro Sign in / Create an
    // account buttons are gone.
    expect(screen.getByRole("button", { name: /start without an account/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with discord/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /email and password/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create an account" })).not.toBeInTheDocument();
  });

  it("renders the credits with the Built with line first, the Runs on list and the 30-day clause", () => {
    setup();
    // Built with is the platform claim and leads the credits.
    expect(screen.getByText(/Built with native.builder, with AI\/ML API as the model behind Builder/)).toBeInTheDocument();
    // Runs on lists exactly the vendors the app actually calls.
    expect(screen.getByText(/Runs on/)).toBeInTheDocument();
    expect(screen.getByText(/Bright Data —/)).toBeInTheDocument();
    expect(screen.getByText(/Speechmatics —/)).toBeInTheDocument();
    expect(screen.getByText(/Featherless —/)).toBeInTheDocument();
    expect(screen.getByText(/Supabase —/)).toBeInTheDocument();
    // The data-kept footnote — what is kept, how long, what is not.
    expect(screen.getByText(/deleted after 30 days without activity/i)).toBeInTheDocument();
    expect(screen.getByText(/recordings stay in the browser and are never uploaded/i)).toBeInTheDocument();
  });

  it("Start without an account dismisses and enters the app", () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: /start without an account/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("Continue with GitHub links the identity via linkWithProvider", async () => {
    const { onStart, onAccountReady } = setup();
    vi.mocked(linkWithProvider).mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    // The anonymous session is ensured first, then the splash is dismissed
    // before the redirect (any way in dismisses for good).
    await waitFor(() => expect(ensureAnonSession).toHaveBeenCalled());
    await waitFor(() => expect(dismissSplash).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(linkWithProvider).toHaveBeenCalledWith("github"));
    // Never onStart/onAccountReady — the redirect reloads the page.
    expect(onStart).not.toHaveBeenCalled();
    expect(onAccountReady).not.toHaveBeenCalled();
  });

  it("Continue with Discord links the identity via linkWithProvider", async () => {
    setup();
    vi.mocked(linkWithProvider).mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /continue with discord/i }));
    await waitFor(() => expect(linkWithProvider).toHaveBeenCalledWith("discord"));
  });

  it("an OAuth failure shows a friendly line and keeps Start available", async () => {
    setup();
    vi.mocked(linkWithProvider).mockResolvedValueOnce({
      ok: false,
      message: "Couldn't add an account right now. Try again later.",
    });
    fireEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't add an account right now/i);
    // Start never waits on this path.
    expect(screen.getByRole("button", { name: /start without an account/i })).toBeEnabled();
  });

  it("reaches the sign-in view via Email and password and signs in", async () => {
    const { onAccountReady } = setup();
    fireEvent.click(screen.getByRole("button", { name: /email and password/i }));

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret123" } });
    vi.mocked(signIn).mockResolvedValueOnce({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onAccountReady).toHaveBeenCalledTimes(1));
  });

  it("switches to the sign-up view and creates an account", async () => {
    const { onAccountReady } = setup();
    fireEvent.click(screen.getByRole("button", { name: /email and password/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create an account instead" }));

    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret123" } });
    vi.mocked(createAccount).mockResolvedValueOnce({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    await waitFor(() => expect(onAccountReady).toHaveBeenCalledTimes(1));
  });

  it("shows a friendly message on a failed sign-in, never a raw error", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /email and password/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    vi.mocked(signIn).mockResolvedValueOnce({ ok: false, message: "That email and password don't match an account." });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match an account/i);
  });

  it("states what the account stores on the create-account form, before it is created", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /email and password/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create an account instead" }));

    // One sentence above the submit, not a checkbox or a policy link.
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(screen.getByText(/stores your email and your resume/i)).toBeInTheDocument();
    expect(screen.getByText(/deleted after 30 days without activity/i)).toBeInTheDocument();
    expect(screen.getByText(/delete the resume at any time from the resume panel/i)).toBeInTheDocument();
  });

  it("offers forgot-password on the sign-in view and confirms the reset link", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /email and password/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    vi.mocked(resetPassword).mockResolvedValueOnce({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: /forgot your password\?/i }));
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith("a@b.com"));
    expect(await screen.findByText(/reset link sent — check your inbox/i)).toBeInTheDocument();
  });

  it("focus lands on the heading when the intro mounts", () => {
    setup();
    const heading = screen.getByRole("heading", { name: "Rehearsal" });
    expect(heading).toHaveFocus();
  });

  it("a returning user with saved work skips the splash on its own", () => {
    const onStart = vi.fn();
    render(<SplashScreen returningUser={true} onStart={onStart} onAccountReady={vi.fn()} />);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
