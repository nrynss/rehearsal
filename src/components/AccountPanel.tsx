import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { SiDiscord, SiGithub } from "react-icons/si";
import { createAccount, linkWithProvider, resetPassword, signIn } from "../lib/accounts";
import type { AccountResult, OAuthProvider } from "../lib/accounts";
import { ensureAnonSession } from "../lib/config";

/**
 * The email + password (and OAuth) account surface, shared by the splash and
 * the resume panel — one implementation, never two.
 *
 * Both callers reach the same lib/accounts paths: createAccount upgrades the
 * anonymous user in place (updateUser — never a second user, so a resume
 * saved before signing up stays theirs), signIn switches to an existing
 * account, and OAuth uses linkIdentity (never signInWithOAuth from an
 * anonymous session — that strands the uid and its saved resume).
 * redirectTo is always the origin.
 *
 * The component never touches splash state. The splash caller dismisses the
 * splash before an OAuth redirect via onBeforeOAuth; the resume panel is
 * already past the splash and passes nothing.
 */

interface AccountPanelProps {
  /** Which view to start on. */
  initialView: "signin" | "signup";
  /** Called after a successful sign-in or sign-up. */
  onReady: () => void;
  /** Leave without an account — renders the Back button. */
  onBack?: () => void;
  /** Embed mode: quieter h3 heading, no intro paragraph. */
  compact?: boolean;
  /** Called right before an OAuth redirect so the caller can do any
   *  splash-specific bookkeeping (e.g. dismissing the splash for good). */
  onBeforeOAuth?: () => void;
}

export default function AccountPanel({
  initialView,
  onReady,
  onBack,
  compact = false,
  onBeforeOAuth,
}: AccountPanelProps) {
  const [view, setView] = useState<"signin" | "signup">(initialView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const isSignin = view === "signin";

  // Keyboard focus lands on the heading on mount, and again on every view
  // switch, so a keyboard user always knows where they are.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  const go = (next: "signin" | "signup") => {
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
      isSignin ? await signIn(email, password) : await createAccount(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onReady();
  };

  /** Continue with GitHub / Discord — the same linkIdentity path as the splash
   *  intro, so the anonymous uid (and any resume saved under it) is upgraded
   *  in place, never stranded. The caller's onBeforeOAuth runs first so any
   *  splash-specific bookkeeping happens before the redirect. */
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
    onBeforeOAuth?.();
    const result = await linkWithProvider(provider);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Success: the browser is heading to the provider. Nothing to render —
    // the page reloads on return.
  };

  const heading = isSignin ? "Sign in" : "Create an account";
  const intro = isSignin
    ? "Pick up where you left off — your saved resume comes back with your account."
    : "Your account is this same identity with an email attached — your resume stays yours, nothing moves.";

  const body = (
    <>
      {compact ? (
        <h3 ref={headingRef} tabIndex={-1} className="font-heading text-display-sm font-semibold tracking-tight">
          {heading}
        </h3>
      ) : (
        <h1 ref={headingRef} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight">
          {heading}
        </h1>
      )}

      {!compact && <p className="mt-3 max-w-[68ch] text-sm text-slate">{intro}</p>}

      <form onSubmit={submit} className={`flex max-w-md flex-col gap-4 ${compact ? "mt-4" : "mt-8"}`}>
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
          {busy ? (isSignin ? "Signing in…" : "Creating account…") : heading}
        </button>

        {/* The same OAuth paths as the splash intro — reachable everywhere the
            account surface is, so the resume panel offers them too. */}
        <div className="flex flex-col gap-3">
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
        </div>

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
          {onBack && (
            <button type="button" className="btn btn-ghost justify-start" onClick={onBack}>
              Back
            </button>
          )}
        </div>
      </form>
    </>
  );

  if (compact) {
    return <div className="flex flex-col gap-4">{body}</div>;
  }

  return (
    <main className="min-h-dvh bg-paper text-ink">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">{body}</div>
    </main>
  );
}
