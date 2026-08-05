/**
 * Supabase project: native-builder (msskdpudbvhxbqybqnvk)
 * All third-party calls (Bright Data, Speechmatics) are proxied through
 * Supabase Edge Functions so API keys never reach the browser.
 */
export const SUPABASE_URL = "https://msskdpudbvhxbqybqnvk.supabase.co";

export async function callEdge<T = unknown>(name: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
