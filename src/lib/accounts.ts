import { ensureAnonSession, supabase } from "./config";

/**
 * Optional email + password accounts, layered on the anonymous session.
 *
 * The app starts every visitor as an anonymous user (see config.ts) and the
 * `resumes` table is keyed on that user's id. Creating an account therefore
 * upgrades the anonymous user in place — `supabase.auth.updateUser({ email,
 * password })` — so the uid does not change and a resume saved before signing
 * up is still theirs afterwards. Never create a second user and migrate rows;
 * that is the version that loses somebody's resume.
 *
 * Signing in switches to an existing account via `signInWithPassword`, the
 * same shape as Supabase's anonymous-linking flow (updateUser rejects a taken
 * email; sign-in replaces the session).
 *
 * Email confirmation is never required to use the app: an unconfirmed account
 * keeps working exactly as the anonymous session did. Every failure below is
 * surfaced in the product's voice — never a raw Supabase error string.
 */

export type AccountResult = { ok: true } | { ok: false; message: string };

/** Map a Supabase auth error to a line a person can act on. */
function mapAuthError(err: unknown, context: "signin" | "signup"): string {
  const e = (err ?? {}) as { code?: string; message?: string };
  const code = e.code ?? "";
  const msg = e.message ?? "";

  if (code === "fetch_error" || /(failed to fetch|fetch failed|network|timed out)/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }

  switch (code) {
    case "invalid_credentials":
      return "That email and password don't match an account. Check them and try again.";
    case "email_not_confirmed":
      return "That email isn't confirmed yet. Check your inbox for the confirmation link, then try again.";
    case "email_exists":
    case "user_already_exists":
      return "That email already has an account. Sign in instead.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a minute and try again.";
    case "weak_password":
      return "That password is too easy to guess. Use a longer one.";
  }

  if (/at least 6 characters/i.test(msg)) return "Passwords need at least 6 characters.";
  if (/already (registered|has an account)|email.*(exist|in use)/i.test(msg)) {
    return "That email already has an account. Sign in instead.";
  }
  if (/manual linking/i.test(msg)) return "Couldn't add an account right now. Try again later.";
  if (/reauthenticat/i.test(msg)) return "Couldn't finish that just now. Try again in a moment.";

  return context === "signin"
    ? "Couldn't sign you in. Check your details and try again."
    : "Couldn't create your account. Try again.";
}

/**
 * Upgrade the current anonymous user to a real account in place. The uid is
 * preserved, so anything saved under the anonymous session — the resume —
 * stays theirs. When email confirmation is required the session keeps working
 * regardless; confirming later completes the account without a reload.
 */
export async function createAccount(email: string, password: string): Promise<AccountResult> {
  try {
    const { error } = await supabase.auth.updateUser(
      { email: email.trim(), password },
      // Confirmation links must land back on the app; the preview domain
      // changes per deploy, so it is resolved at call time.
      { emailRedirectTo: window.location.origin },
    );
    if (error) return { ok: false, message: mapAuthError(error, "signup") };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: mapAuthError(err, "signup") };
  }
}

/** Sign into an existing account, replacing the current (anonymous) session. */
export async function signIn(email: string, password: string): Promise<AccountResult> {
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, message: mapAuthError(error, "signin") };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: mapAuthError(err, "signin") };
  }
}

/** True when the current session is anonymous (or we can't tell). Drives
 *  whether the resume panel offers a sign-out: only a real account can leave. */
export async function isAnonymousUser(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.is_anonymous !== false;
  } catch {
    return true;
  }
}

/** Sign out of the account and settle back into an anonymous session so the
 *  app keeps working. The saved resume stays with the account. */
export async function signOutSession(): Promise<boolean> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) return false;
    await ensureAnonSession();
    return true;
  } catch {
    return false;
  }
}
