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

/** Interview questions grounded in the dossier — frontier model (AI/ML API)
 *  when configured, Featherless open weights as the default fallback. */
const SYSTEM_PROMPT = `You are a senior interviewer preparing a candidate for a specific role. Given
the job posting, company profile and recent news, write 4-6 realistic interview
questions a panel would actually ask for THIS role.

Rules:
- Every question must be grounded in the evidence — the posting's
  responsibilities/qualifications, concrete company facts, or a specific
  headline. No generic behavioural questions that could apply to any job.
- keyPoints: 2-4 points a strong answer must hit. Each has a label and 2-5
  lowercase fact tokens (exact words/phrases from the evidence) used to detect
  whether the answer covered it.
- modelAnswer: a 2-4 sentence outline of a strong answer, using the evidence
  (facts, numbers, responsibilities).
- sourceCard: "job", "company", or "news" — which card this question is
  grounded in. sourceLabel: e.g. "job · linkedin.com".
- ids: q1..q6.

Respond with STRICT JSON only — no markdown fences, no commentary. Schema:
{"questions":[{"id":"q1","text":"...","keyPoints":[{"label":"...","facts":["..."]}],"modelAnswer":"...","sourceCard":"job"|"company"|"news","sourceLabel":"..."}]}`;

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
    ["Employment type", s(job.employmentType)],
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
    .map((h) => {
      const r = h as Record<string, unknown>;
      return `- ${s(r.title)}${s(r.domain) ? ` (${s(r.domain)})` : ""}`;
    })
    .join("\n");

  // The resume is the candidate's own document. It shapes which gaps get
  // probed; it is never quoted back at them.
  const resumeBlock = resume
    ? `\n\nCANDIDATE RESUME\n${truncate(resume, 6000)}\n\nUse the resume to aim roughly a third of the questions at what this candidate has NOT evidenced against this posting. Do not quote the resume back to them and do not ask them to confirm what it already says.`
    : "";

  return `JOB POSTING\n${meta || "- (no metadata)"}\n\nJOB DESCRIPTION\n${truncate(s(job.summary), 6000) || "(none)"}\n\nCOMPANY PROFILE\n${companyMeta || "- (no metadata)"}\n${s(company.description) ? `\nABOUT\n${truncate(s(company.description), 1200)}` : ""}\n\nRECENT NEWS HEADLINES\n${newsLines || "(none)"}${resumeBlock}\n\nWrite the interview questions now.`;
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

    // A resume makes the output personal, so it must never land in the shared
    // row: the first user to rehearse with a resume would otherwise poison the
    // cache and every later user researching this posting would be served
    // questions derived from a stranger's resume.
    //
    // No resume  → shared row, one generation per job URL, as before.
    // Resume     → row scoped to the caller, so the benefit survives without
    //              the leak.
    const resume = typeof body?.resume === "string" ? body.resume.trim().slice(0, 20_000) : "";
    const cacheUrl = resume ? `ai_questions:${jobUrl}:${uid}` : `ai_questions:${jobUrl}`;
    const { data: hit, error: hitError } = await admin
      .from("research_cache")
      .select("url, payload, fetched_at")
      .eq("url", cacheUrl)
      .maybeSingle();
    if (hitError) throw hitError;
    if (hit) {
      const payload = (hit.payload ?? {}) as Record<string, unknown>;
      return json({ status: "ok", cached: true, fetched_at: hit.fetched_at, questions: payload.questions ?? [] });
    }

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("research_cache")
      .select("url", { count: "exact", head: true })
      .eq("requested_by", uid)
      .eq("kind", "ai_questions")
      .gt("fetched_at", since);
    if (countError) throw countError;
    if ((count ?? 0) > 10) {
      return json({
        status: "failed",
        what: "You've generated a lot of question sets recently.",
        next: "Wait a few minutes and try again.",
      });
    }

    const userPrompt = buildUserPrompt(body ?? {}, resume);

    // Preferred: frontier model via AI/ML API (OpenAI-compatible) when the
    // secret is set; otherwise fall back to Featherless open weights.
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
        what: "Question generation isn't configured or the model call failed.",
        next: "Add the AI provider key secret, or use the dossier questions while you wait.",
      });
    }

    const parsed = extractJson(content) as { questions?: unknown } | null;
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const validSources = new Set(["job", "company", "news"]);
    const questions = rawQuestions
      .slice(0, 6)
      .map((q, i) => {
        const r = q as Record<string, unknown>;
        if (typeof r.text !== "string" || !r.text.trim()) return null;
        const keyPoints = Array.isArray(r.keyPoints)
          ? r.keyPoints
              .map((kp) => {
                const rk = kp as Record<string, unknown>;
                const facts = Array.isArray(rk.facts)
                  ? rk.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 2).map((f) => f.trim().toLowerCase())
                  : [];
                return typeof rk.label === "string" && rk.label.trim() ? { label: rk.label.trim(), facts } : null;
              })
              .filter((kp): kp is { label: string; facts: string[] } => kp !== null)
          : [];
        const sourceCard = validSources.has(s(r.sourceCard)) ? (r.sourceCard as string) : "job";
        return {
          id: typeof r.id === "string" && r.id ? r.id : `ai-${i + 1}`,
          text: r.text.trim(),
          keyPoints,
          modelAnswer: typeof r.modelAnswer === "string" ? r.modelAnswer.trim() : "",
          sourceCard,
          sourceLabel: typeof r.sourceLabel === "string" && r.sourceLabel.trim() ? r.sourceLabel.trim() : `${sourceCard} · source`,
        };
      })
      .filter((q): q is Record<string, unknown> => q !== null);

    if (questions.length === 0) {
      console.error("ai-questions: unparseable model content", content.slice(0, 400));
      return json({ status: "failed", what: "The model returned no usable questions.", next: "Try again in a moment." });
    }

    const fetchedAt = new Date().toISOString();
    // Only the questions are stored — never the resume that shaped them.
    const { error: putError } = await admin.from("research_cache").upsert(
      { url: cacheUrl, kind: "ai_questions", payload: { questions }, requested_by: uid },
      { onConflict: "url" },
    );
    if (putError) throw putError;
    return json({ status: "ok", cached: false, fetched_at: fetchedAt, questions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ status: "failed", what: "Question generation failed.", next: "Try again in a moment.", raw: msg });
  }
});
