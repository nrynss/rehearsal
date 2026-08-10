import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { SiDiscord, SiGithub } from "react-icons/si";
import { createAccount, linkWithProvider, resetPassword, signIn } from "../lib/accounts";
import type { AccountResult, OAuthProvider } from "../lib/accounts";
import { ensureAnonSession } from "../lib/config";
import { dismissSplash } from "../lib/splash";

/**
 * The one-time splash — a full screen the app starts on and leaves.
 *
 * Not a modal: while it is up it replaces the tab surface entirely, and the
 * design system has no overlays anywhere. It introduces the product, lists
 * the three tabs, offers the ways in, and credits the stack — then gets out
 * of the way forever (see lib/splash.ts).
 *
 * Accounts live on this screen too, as views — never dialogs. Sign-up
 * upgrades the anonymous user in place; sign-in switches to an existing
 * account. Both enter the app on success.
 */

type View = "intro" | "signin" | "signup";

interface SplashScreenProps {
  /** A saved resume turned up while the splash was up — the visitor has been
   *  here before, so the splash leaves on its own (never while they are
   *  mid-form on the account views). */
  returningUser: boolean;
  /** Dismiss and enter the app as the current (anonymous) session. */
  onStart: () => void;
  /** Dismiss and enter after an account was created or signed into. */
  onAccountReady: () => void;
}

/** The three tabs, with one concrete line of what actually appears under
 *  each — a real example beats a description. */
const TABS = [
  {
    name: "Research",
    desc: "Paste a job link; it scrapes the posting, the company and recent news, then briefs you on what to study.",
    example: "Senior QA Automation Engineer · Deltek — one dossier holding the posting, the company profile and a week of news.",
  },
  {
    name: "Rehearse",
    desc: "A hiring manager interviews you aloud about that specific role.",
    example: "Priya Nair, hiring manager at Deltek, asks you: “Tell me about a hard problem you've solved.”",
  },
  {
    name: "Relive",
    desc: "Your answers scored against what the research found, with what you missed.",
    example: "A scorecard that names what you missed — “Specificity is your weakest content axis, averaging 2.0” — question by question.",
  },
] as const;

/** Runs on is a runtime claim, so only what the app actually calls belongs
 *  here. AI/ML API is the model behind Builder — a build-time claim, so it
 *  sits on the Built with line, not this one. */
const RUNS_ON = [
  { name: "Bright Data", what: "the posting, the company profile and recent news, scraped live." },
  { name: "Speechmatics", what: "the interviewer's voice, and the transcription of your answers." },
  { name: "Featherless", what: "the prep brief, the questions, the fit match and the scoring." },
  { name: "Supabase", what: "edge functions, so no API key ever reaches the browser." },
] as const;

export default function SplashScreen({ returningUser, onStart, onAccountReady }: SplashScreenProps) {
  const [view, setView] = useState<View>("intro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Keyboard focus lands on the heading on mount, and again on every view
  // switch, so a keyboard user always knows where they are.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  // A returning visitor with saved work skips the splash — but only from the
  // intro view; never yank the account form out from under someone mid-form.
  useEffect(() => {
    if (returningUser && view === "intro") onStart();
  }, [returningUser, view, onStart]);

  const go = (next: View) => {
    setView(next);
    setError(null);
    setResetSent(false);
  };

  /** Forgot your password? A reset email is genuinely sent and must be checked
   *  — unlike signup, this confirmation is required, not friction. */
  const sendReset = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    setResetSent(false);
    const result = await resetPassword(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setResetSent(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result: AccountResult =
      view === "signin" ? await signIn(email, password) : await createAccount(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAccountReady();
  };

  /** Continue with GitHub / Discord. The anonymous session must exist first —
   *  linkIdentity uses its token. Dismiss the splash BEFORE the redirect (any
   *  way in dismisses for good), then link; linkWithProvider auto-redirects to
   *  the provider and back, where detectSessionInUrl picks up the same uid's
   *  session and the dismissal flag keeps the splash away. Never call
   *  onStart/onAccountReady here — the redirect reloads the page. */
  const continueWith = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ready = await ensureAnonSession();
    if (!ready) {
      setBusy(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    // The flag is set before the redirect, so when the provider returns the
    // splash stays dismissed. A failure after this point still dismisses for
    // good — the visitor is in, on the anonymous session.
    dismissSplash();
    const result = await linkWithProvider(provider);
    setBusy(false);
    if (!result.ok) {
      // The redirect may not have happened; stay on the splash (now dismissed
      // in storage) and say what went wrong. Start without an account remains
      // available and never waits on this path.
      setError(result.message);
      return;
    }
    // Success: the browser is heading to the provider. Nothing to render —
    // the page reloads on return.
  };

  if (view !== "intro") {
    const isSignin = view === "signin";
    return (
      <main className="min-h-dvh bg-paper text-ink">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
          <h1 ref={headingRef} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight">
            {isSignin ? "Sign in" : "Create an account"}
          </h1>
          <p className="mt-3 max-w-[68ch] text-sm text-slate">
            {isSignin
              ? "Pick up where you left off — your saved resume comes back with your account."
              : "Your account is this same identity with an email attached — your resume stays yours, nothing moves."}
          </p>

          <form onSubmit={submit} className="mt-8 flex max-w-md flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="account-email"
                className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate"
              >
                email
              </label>
              <input
                id="account-email"
                className="input"
                type="email"
                autoComplete="email"
                required
                disabled={busy}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                placeholder="you@example.com"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label
                htmlFor="account-password"
                className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate"
              >
                password
              </label>
              <input
                id="account-password"
                className="input"
                type="password"
                autoComplete={isSignin ? "current-password" : "new-password"}
                required
                minLength={isSignin ? undefined : 6}
                disabled={busy}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? (isSignin ? "Signing in…" : "Creating account…") : isSignin ? "Sign in" : "Create an account"}
            </button>

            {!isSignin && (
              <p className="font-mono text-[0.6875rem] leading-relaxed text-slate">
                The account stores your email and your resume, deleted after 30 days without activity. You can
                delete the resume at any time from the resume panel.
              </p>
            )}

            {isSignin && (
              <div className="flex flex-col gap-2">
                {resetSent && (
                  <p role="status" className="text-sm font-medium text-ink">
                    Reset link sent — check your inbox to set a new password.
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-ghost justify-start"
                  onClick={() => void sendReset()}
                  disabled={busy || !email.trim()}
                >
                  Forgot your password?
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm font-medium text-ink">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <button type="button" className="btn btn-ghost justify-start" onClick={() => go(isSignin ? "signup" : "signin")}>
                {isSignin ? "Create an account instead" : "Sign in instead"}
              </button>
              <button type="button" className="btn btn-ghost justify-start" onClick={() => go("intro")}>
                Back
              </button>
            </div>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-paper text-ink">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <h1 ref={headingRef} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight">
          Rehearsal
        </h1>

        {/* The one line that carries what makes this different — never the
            generic "AI interview coach" category. */}
        <p className="mt-3 max-w-[68ch] text-lg text-ink">
          Every question comes from this posting, this company, and what's been written about them recently.
        </p>

        {/* The three tabs, all visible at once, separated by rules — never
            paged, never boxed. */}
        <div className="mt-8">
          {TABS.map((tab) => (
            <section key={tab.name} className="border-b border-ink/15 py-4">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ink">{tab.name}</p>
              <p className="mt-2 max-w-[68ch] text-sm text-ink">{tab.desc}</p>
              <p className="mt-1 max-w-[68ch] text-sm text-slate">{tab.example}</p>
            </section>
          ))}
        </div>

        {/* The ways in. Start is the default — visually dominant. GitHub and
            Discord sit beneath as secondary actions; email + password is the
            quietest. All hardcoded — never fetched from the server. */}
        <div className="mt-8 flex max-w-sm flex-col gap-3">
          <button type="button" className="btn btn-primary w-full px-8 text-base" onClick={onStart}>
            Start without an account
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={() => void continueWith("github")}
            disabled={busy}
          >
            <SiGithub aria-hidden="true" className="h-4 w-4 shrink-0" />
            Continue with GitHub
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={() => void continueWith("discord")}
            disabled={busy}
          >
            <SiDiscord aria-hidden="true" className="h-4 w-4 shrink-0" />
            Continue with Discord
          </button>
          <button type="button" className="btn btn-ghost w-full" onClick={() => go("signin")} disabled={busy}>
            Email and password
          </button>
          {error && (
            <p role="alert" className="text-sm font-medium text-ink">
              {error}
            </p>
          )}
        </div>

        {/* The credits — a footnote, not a pitch: mono, small, Slate. Built
            with and Runs on are two different claims and stay visually
            distinct. Names as text, never logos. */}
        <footer className="mt-12 border-t border-ink/15 pt-4 font-mono text-[0.6875rem] leading-relaxed text-slate">
          <p className="font-medium">Built with native.builder, with AI/ML API as the model behind Builder.</p>

          <div className="mt-3">
            <p className="uppercase tracking-[0.14em]">Runs on</p>
            <ul className="mt-2 space-y-1">
              {RUNS_ON.map(({ name, what }) => (
                <li key={name}>
                  {name} — {what}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-3">
            The session and the resume are all that's kept — deleted after 30 days without activity. Recordings
            stay in the browser and are never uploaded.
          </p>
        </footer>
      </div>
    </main>
  );
}
