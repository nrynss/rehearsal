import { createClient } from "@supabase/supabase-js";

/**
 * Supabase project: native-builder (msskdpudbvhxbqybqnvk)
 * All third-party calls (Bright Data, Speechmatics) are proxied through
 * Supabase Edge Functions so API keys never reach the browser.
 */
export const SUPABASE_URL = "https://msskdpudbvhxbqybqnvk.supabase.co";

/** Public anon key — safe in the browser; RLS protects the data behind it. */
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zc2tkcHVkYnZoeGJxeWJxbnZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MzM0MDYsImV4cCI6MjEwMTUwOTQwNn0.1w1JS2z0NgwaaJjmue5-lfEcL8guhsDS1rP6R6URSz0";

/**
 * Anonymous auth — no login screen, no user-visible step.
 *
 * The session IS persisted, deliberately: the stored resume belongs to a user,
 * and a fresh anonymous id on every load would orphan it immediately. Supabase
 * can later link this anonymous user to a real account, so a resume saved today
 * survives the move to accounts.
 *
 * "Refresh = start over" still holds for everything the user *does* — dossiers,
 * questions and sessions are in-memory only. What persists is identity, not
 * session state.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

let accessToken: string | null = null;

/** The JWT sent as `Authorization: Bearer …` on every edge function call. */
export function getAccessToken(): string | null {
  return accessToken;
}

let anonPromise: Promise<boolean> | null = null;

/**
 * Sign in anonymously, once per page load. Deduped so React StrictMode's
 * double-mount in dev still produces a single anonymous user.
 */
export function ensureAnonSession(): Promise<boolean> {
  if (!anonPromise) {
    anonPromise = (async () => {
      try {
        // Reuse the persisted session when there is one, so the same anonymous
        // user — and their saved resume — survives a reload. Anonymous users do
        // get cleaned up server-side, so a persisted-but-dead session must fall
        // through to a fresh sign-in rather than handing back a token that 401s
        // on every later call.
        const { data: existing, error: sessionError } = await supabase.auth.getSession();
        const session = sessionError ? null : existing.session;
        const expiresAt = session?.expires_at ? session.expires_at * 1000 : 0;
        if (session?.access_token && expiresAt > Date.now() + 30_000) {
          const { error: userError } = await supabase.auth.getUser();
          if (!userError) {
            accessToken = session.access_token;
            return true;
          }
          // The persisted user no longer exists. Clear it out before retrying.
          await supabase.auth.signOut().catch(() => undefined);
        }
        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) return false;
        accessToken = data.session?.access_token ?? null;
        return accessToken !== null;
      } catch {
        return false;
      }
    })();
  }
  return anonPromise;
}

// Keep the cached token in step with refreshes; a stale token would 401 every
// edge function call once the first hour elapsed. On sign-out or a failed
// refresh, drop the token AND the memoised promise, so the next call can
// re-authenticate instead of failing silently for the rest of the page's life.
supabase.auth.onAuthStateChange((event, session) => {
  if (session?.access_token) {
    accessToken = session.access_token;
    return;
  }
  if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") {
    accessToken = null;
    anonPromise = null;
  }
});

function authHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export async function callEdge<T = unknown>(name: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && (data as { error?: string; message?: string }).error
      ? (data as { error: string }).error
      : (data && (data as { message?: string }).message) || `Edge function ${name} failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

export async function callEdgeForm<T = unknown>(name: string, form: FormData): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && (data as { error?: string; message?: string }).error
      ? (data as { error: string }).error
      : (data && (data as { message?: string }).message) || `Edge function ${name} failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

/** POST JSON to an edge function that answers with a binary body (e.g. audio). */
export async function callEdgeAudio(name: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const msg =
      data && (data as { error?: string }).error
        ? (data as { error: string }).error
        : `Edge function ${name} failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.blob();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
