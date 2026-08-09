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

// Admin client (secret key bypasses RLS) for the shared research_cache.
function adminClient() {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const keys = JSON.parse(secretKeysRaw) as Record<string, string>;
      if (keys["default"]) return createClient(Deno.env.get("SUPABASE_URL")!, keys["default"]);
    } catch {
      // fall through to the legacy key
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return createClient(Deno.env.get("SUPABASE_URL")!, legacy);
  return null;
}

// The gateway (verify_jwt) already validated the Bearer token — read the uid from it.
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
 * Prep brief — an interview study guide that ANALYSES the evidence rather
 * than restating it. The candidate can read the posting above; a brief that
 * quotes the posting back is worthless. Preferred provider: AI/ML API frontier
 * model when configured; Featherless open weights as the default fallback.
 */
const SYSTEM_PROMPT = `You are a meticulous interview-prep coach. You are given evidence scraped from a
LinkedIn job posting, the employer's LinkedIn company profile, and recent news
headlines. Produce a targeted prep brief for a candidate interviewing for THIS
specific role.

YOUR JOB IS ANALYSIS, NOT SUMMARY. The candidate can already read the posting —
it renders directly above your brief. Restating it is worthless.

- NEVER invent facts, figures, people, products or news. If it is not in the
  evidence, it does not exist.
- But DO draw conclusions from the evidence. Inference is the entire point.
  Connect the news to the role. Read between the lines. Say what the wording
  implies about what they actually want, then cite what you reasoned from.
    BAD  (restating):  "The posting mentions Playwright and LLM agents."
    GOOD (analysing):  "This is an AI-first automation role, not regression
                        testing — they say outright they don't want someone who
                        automates feature regression. Expect to defend framework
                        decisions, not to demo test scripts."

Return these sections, in this order, using exactly these headings:

1. "What this role actually is" — the real job behind the title. What are they
   hiring to solve, and what does the wording signal about who succeeds here?
2. "What you'd own" — the shape of the work in plain language, grouped. Not a
   copy of the bullet list.
3. "Must have vs nice to have" — split the qualifications honestly. Where the
   posting does not separate them, judge from emphasis and ordering. Say which
   gaps are disqualifying and which are not.
4. "What to study" — the most valuable section. ORDERED, most important first.
   Name specific tools, concepts, frameworks and domain vocabulary from the
   evidence, and for each say briefly what to be able to SAY about it in the
   room. Never "brush up on fundamentals" or "review your experience".
5. "What the news means for this interview" — synthesise the headlines INTO
   implications: pressure, direction, what they will probe. If the news says
   nothing useful, say so plainly rather than padding.
6. "Angles they're likely to push on" — what will this panel actually dig into?

Rules:
- Cite each claim's source with exactly one of: "job", "company", "news".
- Do NOT include a "Recent news" section that merely lists headlines — they are
  already on the news card. Section 5 is about what they MEAN.
- 3-6 claims per section, full sentences, concrete enough to study from.
- If company or news evidence is thin, still produce the role sections and say
  the evidence was thin. Never pad.

Respond with STRICT JSON only — no markdown fences, no commentary. Schema:
{"sections":[{"heading":"...","claims":[{"text":"...","source":"job"|"company"|"news"}]}]}`;

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max).trimEnd()}…`;
}

function buildUserPrompt(body: Record<string, unknown>): string {
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
    ["Posted", s(job.postedTime) ? `${s(job.postedTime)}${s(job.postedDate) ? ` (${s(job.postedDate)})` : ""}` : s(job.postedDate)],
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
      const domain = s(r.domain);
      const date = s(r.date);
      return `- ${s(r.title)}${domain ? ` (${domain}${date ? `, ${date}` : ""})` : ""}`;
    })
    .join("\n");

  return `JOB POSTING\n${meta || "- (no metadata)"}\n\nJOB DESCRIPTION\n${truncate(s(job.summary), 20000) || "(none)"}\n\nCOMPANY PROFILE\n${companyMeta || "- (no metadata)"}\n${truncate(s(company.description), 1400) ? `\nABOUT\n${truncate(s(company.description), 1400)}` : ""}\n\nRECENT NEWS HEADLINES\n${newsLines || "(none)"}\n\nBuild the prep brief now.`;
}

/**
 * Tolerant JSON extraction from a model reply.
 *
 * The naive "first { to last }" approach fails on two real-world artifacts:
 *  1. Markdown fences or prose wrapped around the JSON.
 *  2. The Featherless streaming proxy occasionally returns the assistant
 *     message with DUPLICATE "content" keys; JSON.parse keeps only the last
 *     one, so the model's JSON arrives missing its opening brace
 *     (e.g. `"sections":[...]}` instead of `{"sections":[...]}`).
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

  // 3. Missing leading brace (Featherless duplicate-"content" artifact): the
  //    reply starts mid-object with a key (e.g. `"sections":[...]}`).
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

/**
 * Extract the assistant's content from a completion response, merging
 * duplicate "content" keys if the provider split the message across them.
 * Falls back to a plain JSON.parse (which keeps the last duplicate).
 */
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
        max_tokens: 4000,
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

    // ---- shared cache — one AI spend per job URL, served to every user ----
    const cacheUrl = `ai_brief:${jobUrl}`;
    const { data: hit, error: hitError } = await admin
      .from("research_cache")
      .select("url, payload, fetched_at")
      .eq("url", cacheUrl)
      .maybeSingle();
    if (hitError) throw hitError;
    if (hit) {
      const payload = (hit.payload ?? {}) as Record<string, unknown>;
      return json({ status: "ok", cached: true, fetched_at: hit.fetched_at, sections: payload.sections ?? [] });
    }

    // ---- rate limit: >10 AI briefs by this user in the last hour ----
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("research_cache")
      .select("url", { count: "exact", head: true })
      .eq("requested_by", uid)
      .eq("kind", "ai_brief")
      .gt("fetched_at", since);
    if (countError) throw countError;
    if ((count ?? 0) > 10) {
      return json({
        status: "failed",
        what: "You've generated a lot of prep briefs recently.",
        next: "Wait a few minutes and try again.",
      });
    }

    const userPrompt = buildUserPrompt(body ?? {});

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
        what: "The AI prep brief isn't configured or the model call failed.",
        next: "Add the AI provider key secret, then try again.",
      });
    }

    const parsed = extractJson(content) as { sections?: unknown } | null;
    const rawSections = Array.isArray(parsed?.sections) ? parsed.sections : [];
    const sections = rawSections
      .map((sec) => {
        const r = sec as Record<string, unknown>;
        const claims = Array.isArray(r.claims)
          ? r.claims
              .map((c) => {
                const rc = c as Record<string, unknown>;
                const source = rc.source === "company" || rc.source === "news" ? rc.source : "job";
                return typeof rc.text === "string" && rc.text.trim() ? { text: rc.text.trim(), source } : null;
              })
              .filter((c): c is { text: string; source: "job" | "company" | "news" } => c !== null)
          : [];
        return typeof r.heading === "string" && r.heading.trim() && claims.length > 0
          ? { heading: r.heading.trim(), claims }
          : null;
      })
      // The news card already lists the headlines — a "Recent news" section
      // is duplication, so drop it even if the model insists.
      .filter((sec): sec is { heading: string; claims: { text: string; source: "job" | "company" | "news" }[] } =>
        sec !== null && !/recent news/i.test(sec.heading),
      );

    if (sections.length === 0) {
      // Log the raw content so a future provider/model change is diagnosable
      // from the edge function logs without shipping the key anywhere.
      console.error("ai-brief: unparseable model content", content.slice(0, 400));
      return json({ status: "failed", what: "The AI model returned no usable sections.", next: "Try again in a moment." });
    }

    const fetchedAt = new Date().toISOString();
    const { error: putError } = await admin.from("research_cache").upsert(
      { url: cacheUrl, kind: "ai_brief", payload: { sections }, requested_by: uid },
      { onConflict: "url" },
    );
    if (putError) throw putError;
    return json({ status: "ok", cached: false, fetched_at: fetchedAt, sections });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ status: "failed", what: "The AI prep brief call failed.", next: "Try again in a moment.", raw: msg });
  }
});
