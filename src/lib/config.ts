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
 * Anonymous auth — no login screen, no user-visible step. Sessions are
 * deliberately not persisted or refreshed: every page load signs in fresh,
 * so "refresh = start over" stays true.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
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
    anonPromise = supabase.auth
      .signInAnonymously()
      .then(({ data, error }) => {
        if (error) return false;
        accessToken = data.session?.access_token ?? null;
        return accessToken !== null;
      })
      .catch(() => false);
  }
  return anonPromise;
}

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

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
