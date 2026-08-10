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
function mapAuthError(err: unknown, context: "signin" | "signup" | "oauth" | "reset"): string {
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
  if (/already (has|linked).*identit|identit.*already/i.test(msg)) {
    return "That login is already connected to an account here. Sign in with that account instead.";
  }
  if (/reauthenticat/i.test(msg)) return "Couldn't finish that just now. Try again in a moment.";

  if (context === "oauth") return "Couldn't connect that account. Try again.";
  if (context === "reset") return "Couldn't send the reset link. Try again.";
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

/** The signed-in identity for display: the email when present, else the
 *  provider name ("GitHub" / "Discord") from app_metadata, else null.
 *  Anonymous users and failed lookups return null — the same safe default
 *  as isAnonymousUser. */
export async function getAccountIdentity(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    const user = data.user;
    if (!user || user.is_anonymous) return null;
    if (user.email) return user.email;
    const provider = user.app_metadata?.provider;
    if (provider === "github") return "GitHub";
    if (provider === "discord") return "Discord";
    return null;
  } catch {
    return null;
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

/** The OAuth providers offered on the splash. Hardcoded — never fetched from
 *  `/auth/v1/settings` at runtime. */
export type OAuthProvider = "github" | "discord";

/**
 * Link an OAuth identity to the current anonymous session — the only correct
 * way to "sign in with GitHub/Discord" here. The user is already an anonymous
 * user; `linkIdentity` upgrades that same user in place, so the uid does not
 * change and a resume saved before linking is still theirs afterwards.
 *
 * Deliberately NOT `signInWithOAuth()`: from an anonymous session that creates
 * a second user and strands the first, silently taking the saved resume with
 * it. This is the single most likely way to break this feature, and it will
 * look like it worked.
 *
 * `linkIdentity` redirects the browser to the provider and back
 * automatically; `redirectTo: window.location.origin` makes the return land on
 * the origin the visitor started from (preview-safe). On a synchronous error
 * (no session, network, manual-linking off) it resolves with a friendly line
 * instead of throwing.
 */
export async function linkWithProvider(provider: OAuthProvider): Promise<AccountResult> {
  try {
    // linkIdentity uses the current session's access token; without a session
    // it fails. ensureAnonSession is deduped, so this is a no-op when the
    // session is already there.
    await ensureAnonSession();
    const { error } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) return { ok: false, message: mapAuthError(error, "oauth") };
    // Success means the browser is being redirected to the provider. The
    // dismissal flag is set before this call, so when the redirect returns the
    // splash stays gone and the linked session (same uid) is picked up from the
    // URL fragment by detectSessionInUrl.
    return { ok: true };
  } catch (err) {
    return { ok: false, message: mapAuthError(err, "oauth") };
  }
}

/** Send a password-reset email. Returns a friendly line when it could not. */
export async function resetPassword(email: string): Promise<AccountResult> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // The recovery link must land back on the app; the preview domain changes
      // per deploy, so it is resolved at call time. detectSessionInUrl:true then
      // processes the callback and fires PASSWORD_RECOVERY.
      redirectTo: window.location.origin,
    });
    if (error) return { ok: false, message: mapAuthError(error, "reset") };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: mapAuthError(err, "reset") };
  }
}

/** Set a new password after a password-recovery link landed. The recovery
 *  session is already a valid session, so the app keeps working either way. */
export async function setNewPassword(password: string): Promise<AccountResult> {
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, message: mapAuthError(error, "signup") };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: mapAuthError(err, "signup") };
  }
}
