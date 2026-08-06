import { callEdge, sleep } from "./config";
import type { BriefSection } from "./types";

/**
 * A payload read back from the database cache. `fetched_at` is the original
 * fetch time the edge function stored — the card shows that date, not today's.
 */
export interface CachedPayload {
  payload: ResearchPayload;
  fetchedAt: string;
}

export type ResearchKind = "job" | "company" | "news";

export interface NewsHeadline {
  title: string;
  url: string;
  domain: string;
  date: string;
}

/** The normalized, display-ready payload for one research card. */
export interface ResearchResult {
  status: "ok";
  kind: ResearchKind;
  label: string;
  title?: string;
  company?: string;
  location?: string;
  jobUrl?: string;
  companyUrl?: string;
  industry?: string;
  size?: string;
  headquarters?: string;
  description?: string;
  headlines?: NewsHeadline[];
  /** Full edge-function response, shown raw behind <details>. */
  raw: unknown;
}

export interface ResearchFailure {
  status: "failed";
  kind: ResearchKind;
  label: string;
  what: string;
  next: string;
  raw?: unknown;
}

export type ResearchPayload = ResearchResult | ResearchFailure;

export interface ResearchOutcome {
  status: "ok" | "failed" | "pending";
  payload?: ResearchPayload;
}

/**
 * Root-level aliases (snake_case + camelCase) for a dataset record. The
 * company dataset (gd_l1vikfnt1wgvvqz95w) names its fields differently from
 * the job dataset — the names below were read off a live record, not guessed:
 * the company name arrives as `name`, industry as `industries` (a string),
 * size as `company_size` / `employees_in_linkedin`, headquarters as
 * `headquarters`, and the about text as `description` / `about` /
 * `unformatted_about`.
 */
const ALIASES: Record<string, string[]> = {
  title: ["job_title", "title", "job_position", "position", "headline"],
  company: ["company_name", "company", "name", "employer", "organization"],
  location: ["job_location", "location", "job_base_pay_location", "city"],
  url: ["url", "job_url", "link", "job_posting_url", "job_link"],
  industry: ["company_industry", "industry", "industries"],
  size: ["company_size", "company_size_range", "size", "employees", "employees_in_linkedin", "employees_on_linkedin"],
  headquarters: ["company_headquarters", "headquarters", "hq", "location_city"],
  description: ["company_description", "description", "about", "unformatted_about", "tagline"],
};

function pick(obj: Record<string, unknown> | null | undefined, aliases: string[]): string {
  if (!obj) return "";
  for (const key of aliases) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** In-memory session cache, keyed by the exact input URL. Never re-fetches within a session. */
const cache = new Map<string, CachedPayload>();

export function cacheGet(key: string): CachedPayload | null {
  return cache.get(key) ?? null;
}
export function cacheSet(key: string, payload: ResearchPayload, fetchedAt: string) {
  cache.set(key, { payload, fetchedAt });
}
export function cacheHas(key: string) {
  return cache.has(key);
}

/**
 * Reused by every dataset call: 202 → poll bright-data-status until ready;
 * non-ok → failed; rows → normalized record.
 *
 * Returns cache metadata alongside the outcome: `cached` is true when the edge
 * function served the row from the database (memory was already checked by the
 * caller), and `fetchedAt` is the original fetch time in that case.
 */
interface RawCollectResult {
  outcome: ResearchOutcome;
  cached: boolean;
  fetchedAt?: string;
}

/**
 * Bright Data's collect-by-URL scrape for these datasets returns ONE record
 * object, not an array. Wrap a lone object so every normalize() can read
 * rows[0]; a real array passes through untouched. This guards against a stale
 * edge function response too (rows: [] with the record stranded in raw).
 */
function toRows(rows: unknown[] | undefined, raw: unknown): unknown[] {
  if (Array.isArray(rows) && rows.length > 0) return rows;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return [raw];
  return Array.isArray(rows) ? rows : [];
}

async function collectByUrl(
  fn: string,
  url: string,
  normalize: (rows: unknown[], raw: unknown) => ResearchOutcome,
): Promise<RawCollectResult> {
  const first = await callEdge<{
    status?: string;
    cached?: boolean;
    fetched_at?: string;
    snapshot_id?: string;
    rows?: unknown[];
    raw?: unknown;
    snapshotId?: unknown;
  }>(fn, { url });

  if (first.status === "failed") return { outcome: { status: "failed" }, cached: false };

  if (first.status === "pending" && first.snapshot_id) {
    // Reuse the existing bright-data-status polling for any 202. Async
    // snapshots are the slow path, so poll every 5s up to 2 minutes
    // before reporting a genuine timeout.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(5000);
      const poll = await callEdge<{ status?: string; rows?: unknown[]; raw?: unknown }>("brightdata-status", {
        snapshot_id: first.snapshot_id,
      });
      if (poll.status === "ready") return { outcome: normalize(toRows(poll.rows, poll.raw), poll.raw), cached: false };
      if (poll.status === "failed") return { outcome: { status: "failed" }, cached: false };
    }
    return { outcome: { status: "pending" }, cached: false };
  }

  const outcome = normalize(toRows(first.rows, first.raw), first.raw);
  if (first.cached && outcome.status === "ok") {
    return { outcome, cached: true, fetchedAt: first.fetched_at };
  }
  return { outcome, cached: false };
}

/**
 * Pull a human explanation out of a dead/blocked scrape so the card can say
 * *why* instead of a generic "no readable data". Bright Data surfaces dead
 * pages two ways: a top-level `error_code: "dead_page"` on the snapshot, or an
 * error record inside `rows` (because include_errors=true keeps failures).
 */
function pageErrorReason(
  rows: unknown[],
  raw: unknown,
  noun: "posting" | "company page",
): { what: string; next: string } | null {
  const first = (rows[0] ?? {}) as Record<string, unknown>;
  if (typeof first.error === "string" && first.error.trim() !== "") {
    return {
      what: `LinkedIn wouldn't serve this ${noun} (${first.error}).`,
      next: `Confirm the ${noun} still exists, then re-run.`,
    };
  }
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const code = typeof r.error_code === "string" ? r.error_code : "";
    const err = typeof r.error === "string" ? r.error : "";
    if (code === "dead_page" || /dead page|4xx/i.test(err)) {
      return {
        what: `This ${noun} is no longer live on LinkedIn.`,
        next:
          noun === "posting"
            ? "It may have been filled or removed — paste a different posting to research."
            : "Check the company page still resolves, then re-run.",
      };
    }
    if (err) {
      return {
        what: `The scraper couldn't read this ${noun} (${err}).`,
        next: `Confirm the ${noun} still exists, then re-run.`,
      };
    }
  }
  return null;
}

/** Step 1 — the job posting (dataset gd_lpfll7v5hcqtkxl6l, collect by URL). */
export async function researchJob(url: string): Promise<RawCollectResult> {
  return collectByUrl("brightdata-jobs", url, (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const title = pick(record, ALIASES.title);
    const company = pick(record, ALIASES.company);
    const location = pick(record, ALIASES.location);
    const jobUrl = pick(record, ALIASES.url) || url;
    if (!title && !company) {
      const reason = pageErrorReason(rows, raw, "posting");
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "job",
          label: "job",
          what: reason?.what ?? "Bright Data returned no readable job data for this URL.",
          next: reason?.next ?? "Confirm the job posting still exists, then re-run.",
          raw,
        },
      };
    }
    return {
      status: "ok",
      payload: {
        status: "ok",
        kind: "job",
        label: "job",
        title,
        company,
        location,
        jobUrl,
        raw,
      },
    };
  });
}

/** Step 2 — the company profile (dataset gd_l1vikfnt1wgvvqz95w, collect by URL). */
export async function researchCompany(companyUrl: string): Promise<RawCollectResult> {
  return collectByUrl("brightdata-company", companyUrl, (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const name = pick(record, ALIASES.company) || pick(record, ["company_name", "name", "organization"]);
    const industry = pick(record, ALIASES.industry);
    const size = pick(record, ALIASES.size);
    const headquarters = pick(record, ALIASES.headquarters);
    const description = pick(record, ALIASES.description);
    if (!name && !industry && !size) {
      const reason = pageErrorReason(rows, raw, "company page");
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "company",
          label: "company",
          what: reason?.what ?? "Bright Data returned no readable company profile for this URL.",
          next: reason?.next ?? "Check the company page still resolves, then re-run.",
          raw,
        },
      };
    }
    return {
      status: "ok",
      payload: {
        status: "ok",
        kind: "company",
        label: "company",
        title: name,
        company: name,
        industry,
        size,
        headquarters,
        description,
        companyUrl,
        raw,
      },
    };
  });
}

/** Step 3 — one SERP news query for the company, headlines + source domains + dates only. */
export async function researchNews(companyName: string): Promise<RawCollectResult> {
  try {
    const res = await callEdge<{
      status?: string;
      cached?: boolean;
      fetched_at?: string;
      query?: string;
      headlines?: NewsHeadline[];
      raw?: unknown;
    }>("brightdata-news", { companyName });
    if (res.status === "failed") {
      return {
        outcome: {
          status: "failed",
          payload: {
            status: "failed",
            kind: "news",
            label: "news",
            what: "The news search call failed.",
            next: "Check the SERP zone secret and try again.",
            raw: res.raw,
          },
        },
        cached: false,
      };
    }
    const headlines = (res.headlines ?? []).slice(0, 5);
    if (headlines.length === 0) {
      return {
        outcome: {
          status: "failed",
          payload: {
            status: "failed",
            kind: "news",
            label: "news",
            what: "The news search returned no headlines.",
            next: "Try a different company or re-run later.",
            raw: res.raw,
          },
        },
        cached: false,
      };
    }
    const outcome: ResearchOutcome = {
      status: "ok",
      payload: {
        status: "ok",
        kind: "news",
        label: "news",
        title: companyName,
        headlines,
        raw: res.raw,
      },
    };
    if (res.cached) return { outcome, cached: true, fetchedAt: res.fetched_at };
    return { outcome, cached: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: {
        status: "failed",
        payload: {
          status: "failed",
          kind: "news",
          label: "news",
          what: `The news search call failed: ${msg}`,
          next: "Check the network and try again.",
        },
      },
      cached: false,
    };
  }
}

/** Strip the query string from a LinkedIn company URL (…?trk=… → clean URL). */
export function cleanCompanyUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return rawUrl;
  }
}
