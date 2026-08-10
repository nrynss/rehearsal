/**
 * Shared Featherless model resolution for the AI edge functions.
 *
 * Two-model chain, same cost: a primary model for better output, and a stable
 * fallback used when the primary errors OR returns nothing. FEATHERLESS_MODEL
 * overrides the PRIMARY only — the fallback stays the flash model so an
 * override experiment can never take the whole chain down with it.
 */
export const FEATHERLESS_PRIMARY_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
export const FEATHERLESS_FALLBACK_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export function featherlessModels(): { primary: string; fallback: string } {
  return {
    primary: Deno.env.get("FEATHERLESS_MODEL") ?? FEATHERLESS_PRIMARY_MODEL,
    fallback: FEATHERLESS_FALLBACK_MODEL,
  };
}

const FEATHERLESS_BASE = "https://api.featherless.ai/v1";
const FEATHERLESS_HEADERS = {
  "HTTP-Referer": "https://rehearsal.nativelyai.app",
  "X-Title": "Rehearsal",
};

/**
 * Resolve one completion across the two-model chain: try the primary, then
 * the fallback when the primary errors or returns nothing. Logs which model
 * answered so a silent downgrade is visible in the edge-function logs.
 *
 * `complete` is the calling function's own completion helper — each function
 * tunes temperature/max_tokens to its output, so the chain only decides
 * WHICH model, never how the call is made.
 */
export async function completeFeatherless(
  fn: string,
  apiKey: string,
  complete: (
    base: string,
    apiKey: string,
    model: string,
    userPrompt: string,
    extraHeaders?: Record<string, string>,
  ) => Promise<string | null>,
  userPrompt: string,
): Promise<string | null> {
  const { primary, fallback } = featherlessModels();
  try {
    const content = await complete(FEATHERLESS_BASE, apiKey, primary, userPrompt, FEATHERLESS_HEADERS);
    if (content) {
      console.log(`${fn}: Featherless answered with ${primary}`);
      return content;
    }
    console.warn(`${fn}: Featherless primary ${primary} returned nothing — falling back to ${fallback}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${fn}: Featherless primary ${primary} failed (${msg}) — falling back to ${fallback}`);
  }
  const content = await complete(FEATHERLESS_BASE, apiKey, fallback, userPrompt, FEATHERLESS_HEADERS);
  if (content) {
    console.log(`${fn}: Featherless answered with ${fallback} (fallback)`);
    return content;
  }
  console.error(`${fn}: Featherless fallback ${fallback} also failed`);
  return null;
}
