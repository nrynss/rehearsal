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
 * Fit match — the candidate's resume measured against one posting.
 *
 * Deliberately has NO cache, unlike its siblings. `research_cache` is shared
 * public data read with the admin client; a fit match is about a person and
 * must never be stored there. The client caches the result in memory for the
 * session, which is enough. The resume itself is never persisted anywhere.
 */
const SYSTEM_PROMPT = `You are an experienced hiring advisor. Given a job posting, a company
profile, recent news, and a candidate's resume, judge honestly how this candidate fits THIS
posting.

Rules:
- strengths: what the candidate already demonstrably has that this posting asks for.
- gaps: what the posting asks for that the resume does not evidence. Absence of evidence is
  a gap — do not invent experience the resume does not show.
- Every strength and gap carries "evidence": a short phrase quoted from the resume or the
  posting. A claim with no evidence is you inventing a candidate; omit it instead.
- studyPlan: ordered, most important first. Name concrete things — tools, concepts, domain
  vocabulary drawn from the posting. Never "brush up on fundamentals".
- verdict: one honest sentence on the fit. Say so plainly when it is weak. A fit match that
  flatters everyone is worthless the night before an interview.

Voice — this is the candidate's own preparation, not a report written about them:
- Address the candidate as "you". Never write about them in the third person, and NEVER use
  their name, even though the resume contains it. "You have deep Playwright experience", not
  "Anita has deep Playwright experience".
- Refer to the role ONLY by the exact Title given under JOB POSTING, copied verbatim. Do not
  paraphrase it, do not expand it, do not infer a better title from the responsibilities. If
  the title is "Principal QA Engineer (Playwright)", that is the only name this role has.
- Name the company only as it appears in the evidence.

Respond with STRICT JSON only — no markdown fences, no commentary. Schema:
{"verdict":"...","strengths":[{"text":"...","evidence":"..."}],"gaps":[{"text":"...","evidence":"..."}],"studyPlan":["..."]}`;

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max).trimEnd()}…`;
}

function buildUserPrompt(body: Record<string, unknown>, resume: string): string {
  const job = (body.job ?? {}) as Record<string, unknown>;
  const company = (body.company ?? {}) as Record<string, unknown>;
  const news = (body.news ?? {}) as Record<string, unknown>;
  const headlines = Array.isArray(news.headlines) ? news.headlines : [];

  const meta = [
    ["Title", s(job.title)],
    ["Company", s(job.company)],
    ["Location", s(job.location)],
    ["Seniority", s(job.seniorityLevel)],
    ["Function", s(job.jobFunction)],
    ["Industries", s(job.industries)],
  ]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const companyMeta = [
    ["Name", s(company.title) || s(company.company)],
    ["Industry", s(company.industry)],
    ["Size", s(company.size)],
    ["Headquarters", s(company.headquarters)],
  ]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const newsLines = headlines
    .slice(0, 5)
    .map((h) => `- ${s((h as Record<string, unknown>).title)}`)
    .join("\n");

  return `JOB POSTING\n${meta || "- (no metadata)"}\n\nJOB DESCRIPTION\n${truncate(s(job.summary), 20000) || "(none)"}\n\nCOMPANY PROFILE\n${companyMeta || "- (no metadata)"}\n\nRECENT NEWS HEADLINES\n${newsLines || "(none)"}\n\nCANDIDATE RESUME\n${truncate(resume, 8000)}\n\nWrite the fit match now.`;
}

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
  const timer = setTimeout(() => controller.abort(), 90_000);
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
        temperature: 0.3,
        max_tokens: 3000,
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

function cleanItems(list: unknown, limit: number): { text: string; evidence?: string }[] {
  const out: { text: string; evidence?: string }[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    out.push({
      text: r.text.trim(),
      evidence: typeof r.evidence === "string" && r.evidence.trim() ? r.evidence.trim() : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const jobUrl = typeof body?.jobUrl === "string" ? body.jobUrl : "";
    const resume = typeof body?.resume === "string" ? body.resume.trim().slice(0, 20_000) : "";
    if (!jobUrl || !resume) {
      return json({ status: "failed", what: "A posting and a saved resume are both required.", next: "" });
    }
    if (!callerUid(req)) {
      return json({ status: "failed", http_status: 401, what: "requires an authenticated session", next: "" });
    }

    const userPrompt = buildUserPrompt(body ?? {}, resume);

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
      content = await completeFeatherless("ai-fit", featherlessKey, complete, userPrompt);
    }

    if (!content) {
      return json({
        status: "failed",
        what: "The fit match isn't configured or the model call failed.",
        next: "Add the AI provider key secret, then try again.",
      });
    }

    const parsed = (extractJson(content) ?? {}) as Record<string, unknown>;
    const strengths = cleanItems(parsed.strengths, 6);
    const gaps = cleanItems(parsed.gaps, 6);
    const studyPlan = (Array.isArray(parsed.studyPlan) ? parsed.studyPlan : [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 2)
      .map((x) => x.trim())
      .slice(0, 8);

    if (strengths.length === 0 && gaps.length === 0 && studyPlan.length === 0) {
      console.error("ai-fit: unparseable model content", content.slice(0, 400));
      return json({ status: "failed", what: "The model returned no usable fit match.", next: "Try again in a moment." });
    }

    return json({
      status: "ok",
      verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "",
      strengths,
      gaps,
      studyPlan,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Never echo the request body — it contains the resume.
    return json({ status: "failed", what: "The fit match failed.", next: "Try again in a moment.", raw: msg });
  }
});
