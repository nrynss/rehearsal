import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SplashScreen from "../../components/SplashScreen";
import { createAccount, signIn } from "../../lib/accounts";

vi.mock("../../lib/accounts", () => ({
  createAccount: vi.fn(),
  signIn: vi.fn(),
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

    // The ways in.
    expect(screen.getByRole("button", { name: /start without an account/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create an account" })).toBeInTheDocument();
  });

  it("renders the credits with the Built with line first and the Runs on list", () => {
    setup();
    // Built with is the platform claim and leads the credits.
    expect(screen.getByText(/Built with native.builder, with AI\/ML API as the model behind Builder/)).toBeInTheDocument();
    // Runs on lists exactly the vendors the app actually calls.
    expect(screen.getByText(/Runs on/)).toBeInTheDocument();
    expect(screen.getByText(/Bright Data —/)).toBeInTheDocument();
    expect(screen.getByText(/Speechmatics —/)).toBeInTheDocument();
    expect(screen.getByText(/Featherless —/)).toBeInTheDocument();
    expect(screen.getByText(/Supabase —/)).toBeInTheDocument();
    // The data-kept footnote.
    expect(screen.getByText(/recordings stay in the browser and are never uploaded/i)).toBeInTheDocument();
  });

  it("Start without an account dismisses and enters the app", () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: /start without an account/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("switches to the sign-in view and signs in", async () => {
    const { onAccountReady } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret123" } });
    vi.mocked(signIn).mockResolvedValueOnce({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onAccountReady).toHaveBeenCalledTimes(1));
  });

  it("switches to the sign-up view and creates an account", async () => {
    const { onAccountReady } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));

    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret123" } });
    vi.mocked(createAccount).mockResolvedValueOnce({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    await waitFor(() => expect(onAccountReady).toHaveBeenCalledTimes(1));
  });

  it("shows a friendly message on a failed sign-in, never a raw error", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    vi.mocked(signIn).mockResolvedValueOnce({ ok: false, message: "That email and password don't match an account." });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match an account/i);
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
