import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function adminClient() {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const keys = JSON.parse(secretKeysRaw) as Record<string, string>;
      if (keys["default"]) return createClient(Deno.env.get("SUPABASE_URL")!, keys["default"]);
    } catch {
      // fall through
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return createClient(Deno.env.get("SUPABASE_URL")!, legacy);
  return null;
}

function callerUid(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  try {
    const part = m[1].split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
    ) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * The interviewer's opening greeting — a single short spoken turn, generated
 * only when a resume is saved. This is the ONLY new model call in the
 * continuous-interview change; question generation, scoring and synthesis are
 * untouched.
 *
 * The prompt is deliberately narrow. The interviewer has read the resume and
 * makes exactly ONE specific, accurate observation drawn from it — the kind of
 * remark a hiring manager makes after actually reading it. It must never
 * fabricate, and must never turn into a question. When the call fails or
 * returns nothing, the client falls back to the scripted opening.
 */
const SYSTEM_PROMPT = `You are a hiring manager about to start an interview for a specific role at
your company. You have read the candidate's resume. You are speaking your
OPENING GREETING — the very first thing you say when the call begins.

Write one short spoken greeting (3-5 sentences, under 90 words) that covers,
IN THIS ORDER:
1. Who you are — by name and role (you are the hiring manager for this role).
2. The role being interviewed for.
3. The format — "eight questions, roughly ninety seconds each".

Then weave in EXACTLY ONE specific, accurate observation drawn from the
candidate's resume — the kind of remark a hiring manager makes when they have
actually read it. Pick one concrete, verifiable fact (a role, a company, a
technology, a tenure, an achievement) and reference it naturally.

Rules:
- The observation must be grounded in the resume. Never fabricate.
- It is a greeting, not an interrogation. NEVER end with a question.
- Do not praise the resume. This is not a compliment; it is a signal that you
  have read it.
- Do not summarise or repeat the resume back.
- Write the way a real hiring manager speaks aloud — warm, professional, plain.
- No markdown, no bullet points, no quotes around the text. Just the spoken
  words, as one paragraph.

Respond with STRICT JSON only — no markdown fences, no commentary. Schema:
{"text":"...","speechText":"..."}
"text" is the display text; "speechText" is the SAME greeting written to be
read ALOUD by text-to-speech — expand anything a voice would mangle
("10+ yrs" -> "ten or more years", "CI/CD" -> "C I C D", "K8s" -> "Kubernetes",
"$120K" -> "one hundred and twenty thousand dollars"). No slashes, no plus
signs, no abbreviations, no bare symbols. Keep the meaning and length close.`;

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max).trimEnd()}…`;
}

function buildUserPrompt(body: Record<string, unknown>, resume: string): string {
  const job = (body.job ?? {}) as Record<string, unknown>;
  const meta = [
    ["Title", s(job.title)],
    ["Company", s(job.company)],
    ["Location", s(job.location)],
    ["Seniority", s(job.seniorityLevel)],
    ["Function", s(job.jobFunction)],
  ]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return `INTERVIEWER NAME: ${s(body.interviewerName) || "(the hiring manager)"}\n\nROLE BEING INTERVIEWED FOR\n${meta || "- (no metadata)"}\n\nCANDIDATE RESUME\n${truncate(resume, 8000)}\n\nWrite the opening greeting now.`;
}

/** Tolerant JSON extraction — same defensive ladder as the other AI edge
 *  functions (fences, prose-wrapped JSON, missing brace, truncation). */
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

  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(cleaned.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }

  const first = cleaned.search(/\S/);
  if (first >= 0 && cleaned[first] === '"') {
    const withBrace = tryParse("{" + cleaned);
    if (withBrace !== undefined) return withBrace;
  }

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

async function complete(base: string, apiKey: string, model: string, userPrompt: string, extraHeaders: Record<string, string> = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 500,
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
    const jobUrl = typeof body?.jobUrl === "string" ? body.jobUrl : "";
    if (!jobUrl) {
      return json({ status: "failed", what: "Missing job URL.", next: "Re-run research for the posting." });
    }

    const admin = adminClient();
    const uid = callerUid(req);
    if (!admin || !uid) {
      return json({ status: "failed", http_status: 401, what: "requires an authenticated session", next: "" });
    }

    // A resume makes the greeting personal, so it must never land in the shared
    // row — same privacy rule as ai-questions: no resume → shared row keyed on
    // the job URL; resume → row scoped to the caller.
    const resume = typeof body?.resume === "string" ? body.resume.trim().slice(0, 20_000) : "";
    if (!resume) {
      return json({ status: "failed", what: "A resume is required for the opening.", next: "" });
    }
    const cacheUrl = `ai_opening:${jobUrl}:${uid}`;
    const { data: hit, error: hitError } = await admin
      .from("research_cache")
      .select("url, payload, fetched_at")
      .eq("url", cacheUrl)
      .maybeSingle();
    if (hitError) throw hitError;
    if (hit) {
      const payload = (hit.payload ?? {}) as Record<string, unknown>;
      return json({
        status: "ok",
        cached: true,
        fetched_at: hit.fetched_at,
        text: typeof payload.text === "string" ? payload.text : "",
        speechText: typeof payload.speechText === "string" ? payload.speechText : "",
      });
    }

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("research_cache")
      .select("url", { count: "exact", head: true })
      .eq("requested_by", uid)
      .eq("kind", "ai_opening")
      .gt("fetched_at", since);
    if (countError) throw countError;
    if ((count ?? 0) > 10) {
      return json({
        status: "failed",
        what: "You've generated a lot of openings recently.",
        next: "Wait a few minutes and try again.",
      });
    }

    const userPrompt = buildUserPrompt(body ?? {}, resume);

    // Preferred: frontier model via AI/ML API (OpenAI-compatible) when the
    // secret is set; otherwise fall back to Featherless open weights — exactly
    // the same routing the other AI edge functions use.
    let content: string | null = null;
    const aimlKey = Deno.env.get("AIML_API_KEY");
    if (aimlKey) {
      const base = (Deno.env.get("AIML_BASE_URL") ?? "https://api.aimlapi.com/v1").replace(/\/$/, "");
      const model = Deno.env.get("AIML_MODEL") ?? "gpt-4o";
      try {
        content = await complete(base, aimlKey, model, userPrompt);
      } catch {
        content = null; // fall through to Featherless
      }
    }
    const featherlessKey = Deno.env.get("FEATHERLESS_API_KEY");
    if (!content && featherlessKey) {
      const model = Deno.env.get("FEATHERLESS_MODEL") ?? "deepseek-ai/DeepSeek-V4-Flash";
      try {
        content = await complete("https://api.featherless.ai/v1", featherlessKey, model, userPrompt, {
          "HTTP-Referer": "https://rehearsal.nativelyai.app",
          "X-Title": "Rehearsal",
        });
      } catch {
        content = null;
      }
    }

    if (!content) {
      return json({
        status: "failed",
        what: "Opening generation isn't configured or the model call failed.",
        next: "The scripted opening will be used instead.",
      });
    }

    const parsed = extractJson(content) as { text?: unknown; speechText?: unknown } | null;
    const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    const speechText =
      typeof parsed?.speechText === "string" && parsed.speechText.trim() ? parsed.speechText.trim() : text;
    if (!text) {
      console.error("ai-opening: unparseable model content", content.slice(0, 400));
      return json({ status: "failed", what: "The model returned no usable opening.", next: "The scripted opening will be used instead." });
    }

    const fetchedAt = new Date().toISOString();
    // Only the greeting is stored — never the resume that shaped it.
    const { error: putError } = await admin.from("research_cache").upsert(
      { url: cacheUrl, kind: "ai_opening", payload: { text, speechText }, requested_by: uid },
      { onConflict: "url" },
    );
    if (putError) throw putError;
    return json({ status: "ok", cached: false, fetched_at: fetchedAt, text, speechText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ status: "failed", what: "Opening generation failed.", next: "The scripted opening will be used instead.", raw: msg });
  }
});
