import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { completeFeatherless } from "../_shared/featherless.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Per-answer rubric scoring — frontier model (AI/ML API) when configured,
 *  Featherless open weights as the default fallback. No DB cache: transcripts
 *  are unique, so caching would never hit. */
const SYSTEM_PROMPT = `You are a rigorous interview answer evaluator. Score the candidate's answer to
a specific interview question.

Input: the question text, its key points (label + fact tokens), a transcript,
and speaking duration in milliseconds.

Score two rubrics, each 1-5:
content: Relevance (did they cover the key points), Specificity (concrete
detail: numbers, named facts), Structure (complete, ordered answer).
delivery: Pace (natural for the duration), Filler rate (um/uh/like), Hesitation
(i think/i guess), Answer length.

missed: the labels of key points the answer did not cover (empty array if none).

Be fair and evidence-based. Respond with STRICT JSON only — no markdown fences,
no commentary. Schema:
{"content":[{"label":"Relevance","score":1}],"delivery":[{"label":"Pace","score":1}],"missed":["..."]}`;

/**
 * Tolerant JSON extraction from a model reply.
 *
 * The naive "first { to last }" approach fails on two real-world artifacts:
 *  1. Markdown fences or prose wrapped around the JSON.
 *  2. The Featherless streaming proxy occasionally returns the assistant
 *     message with DUPLICATE "content" keys; JSON.parse keeps only the last
 *     one, so the model's JSON arrives missing its opening brace.
 * We try progressively harder reconstructions and return the first that parses.
 */
function extractJson(text: string): unknown {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();
  if (!cleaned) return null;

  const tryParse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  // 1. The whole (fence-stripped) reply parses as-is.
  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;

  // 2. First { to last } — handles prose wrapped around an object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(cleaned.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }

  // 3. Missing leading brace (Featherless duplicate-"content" artifact).
  const first = cleaned.search(/\S/);
  if (first >= 0 && cleaned[first] === '"') {
    const withBrace = tryParse("{" + cleaned);
    if (withBrace !== undefined) return withBrace;
  }

  // 4. Truncated object — close any unclosed braces at the end.
  let open = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") open++;
    if (ch === "}") open--;
  }
  if (open > 0) {
    const repaired = tryParse(cleaned + "}".repeat(open));
    if (repaired !== undefined) return repaired;
  }

  return null;
}

/** Extract the assistant's content, merging duplicate "content" keys if the
 *  provider split the message across them (Featherless streaming artifact). */
function extractContent(text: string): string | null {
  const msgIdx = text.indexOf('"message"');
  if (msgIdx >= 0) {
    const parts: string[] = [];
    const re = /"content"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(text.slice(msgIdx))) !== null && count < 16) {
      count++;
      try {
        parts.push(JSON.parse(m[1]));
      } catch {
        // skip a malformed chunk
      }
    }
    if (parts.length > 1) {
      const merged = parts.join("");
      if (merged.trim()) return merged;
    }
  }
  try {
    const data = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

async function complete(
  base: string,
  apiKey: string,
  model: string,
  userPrompt: string,
  extraHeaders: Record<string, string> = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`provider ${res.status}: ${errText.slice(0, 200)}`);
    }
    return extractContent(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const question = (body?.question ?? {}) as Record<string, unknown>;
    const durationMs = typeof body?.durationMs === "number" && Number.isFinite(body.durationMs) ? body.durationMs : 0;
    if (!transcript) {
      return json({ status: "failed", what: "Empty answer transcript.", next: "Answer the question first." });
    }

    const keyPoints = Array.isArray(question.keyPoints) ? question.keyPoints : [];
    const userPrompt = `QUESTION\n${typeof question.text === "string" ? question.text : "(unknown)"}\n\nKEY POINTS\n${
      keyPoints.length
        ? keyPoints
            .map((kp) => {
              const r = kp as Record<string, unknown>;
              const facts = Array.isArray(r.facts) ? r.facts.join(", ") : "";
              return `- ${typeof r.label === "string" ? r.label : "?"}${facts ? ` (facts: ${facts})` : ""}`;
            })
            .join("\n")
        : "(none)"
    }\n\nCANDIDATE ANSWER (${Math.round(durationMs / 1000)}s)\n${transcript.slice(0, 4000)}\n\nScore the answer now.`;

    // Preferred: frontier model via AI/ML API when configured; otherwise
    // Featherless open weights. If both fail, degrade honestly.
    let content: string | null = null;
    const aimlKey = Deno.env.get("AIML_API_KEY");
    if (aimlKey) {
      const base = (Deno.env.get("AIML_BASE_URL") ?? "https://api.aimlapi.com/v1").replace(/\/$/, "");
      const model = Deno.env.get("AIML_MODEL") ?? "gpt-4o";
      try {
        content = await complete(base, aimlKey, model, userPrompt);
      } catch {
        content = null;
      }
    }
    const featherlessKey = Deno.env.get("FEATHERLESS_API_KEY");
    if (!content && featherlessKey) {
      content = await completeFeatherless("ai-score", featherlessKey, complete, userPrompt);
    }

    if (!content) {
      return json({
        status: "failed",
        what: "AI scoring isn't configured or the model call failed.",
        next: "Deterministic scoring is shown instead.",
      });
    }

    const parsed = extractJson(content) as { content?: unknown; delivery?: unknown; missed?: unknown } | null;

    // Honest failure: when the model produced nothing usable, say so. The
    // client falls back to the deterministic rubric. Never report a fake
    // "ok" filled with default 3s — that would look like AI feedback it
    // never gave.
    const rawContent = Array.isArray(parsed?.content) ? (parsed!.content as unknown[]) : [];
    const rawDelivery = Array.isArray(parsed?.delivery) ? (parsed!.delivery as unknown[]) : [];
    const rawMissed = Array.isArray(parsed?.missed) ? (parsed!.missed as unknown[]) : [];
    if (!parsed || (rawContent.length === 0 && rawDelivery.length === 0 && rawMissed.length === 0)) {
      console.error("ai-score: unparseable model content", content.slice(0, 400));
      return json({
        status: "failed",
        what: "The AI model returned no usable score.",
        next: "Deterministic scoring is shown instead.",
      });
    }

    const clean = (list: unknown, def: string[]): { label: string; score: number }[] => {
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => {
          const r = item as Record<string, unknown>;
          const score = typeof r.score === "number" && Number.isFinite(r.score) ? Math.max(1, Math.min(5, Math.round(r.score))) : -1;
          return typeof r.label === "string" && r.label.trim() && score >= 1 ? { label: r.label.trim(), score } : null;
        })
        .filter((i): i is { label: string; score: number } => i !== null)
        .concat(
          def.filter((d) => !(Array.isArray(list) && list.some((x) => (x as Record<string, unknown>).label === d))).map((d) => ({ label: d, score: 3 })),
        );
    };
    const contentRubric = clean(parsed!.content, ["Relevance", "Specificity", "Structure"]);
    const deliveryRubric = clean(parsed!.delivery, ["Pace", "Filler rate", "Hesitation", "Answer length"]);
    const missed = Array.isArray(parsed!.missed)
      ? parsed!.missed.filter((m): m is string => typeof m === "string" && m.trim()).map((m) => m.trim())
      : [];

    return json({
      status: "ok",
      content: contentRubric,
      delivery: deliveryRubric,
      missed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ status: "failed", what: "AI scoring failed.", next: "Deterministic scoring is shown instead.", raw: msg });
  }
});
