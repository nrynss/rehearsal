import { callEdge, sleep } from "./config";

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
  /** LinkedIn square logo — company and job cards (jobs carry company_logo). */
  logo?: string;
  /** LinkedIn wide cover image — company cards only. */
  image?: string;
  /** One-line company slogan/tagline — company cards only. */
  slogan?: string;
  headlines?: NewsHeadline[];

  // ---- Job-card extras (all read off the cached LinkedIn job record) ----
  /** The full job-description text (LinkedIn `job_summary`) — the richest
   *  field in the cache and the core of the AI brief. Job cards only. */
  summary?: string;
  /** e.g. "Full-time" — job cards only. */
  employmentType?: string;
  /** e.g. "Mid-Senior level" — job cards only. */
  seniorityLevel?: string;
  /** e.g. "Quality Assurance" — job cards only. */
  jobFunction?: string;
  /** e.g. "Software Development" — job cards only. */
  industries?: string;
  /** ISO date the posting was published — job cards only. */
  postedDate?: string;
  /** Human relative time, e.g. "3 weeks ago" — job cards only. */
  postedTime?: string;
  /** Number of applicants LinkedIn shows (may be 0) — job cards only. */
  numApplicants?: number;
  /** External apply link when the posting routes off LinkedIn — job cards only. */
  applyLink?: string;
  /** True when LinkedIn "Easy Apply" is offered — job cards only. */
  easyApply?: boolean;

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
  /** The edge function's response body — shown on the card as a detail line. */
  detail?: string;
  /** HTTP status from the edge function's upstream call, when applicable. */
  httpStatus?: number;
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

/** Logo / cover / slogan only exist on the LinkedIn company record — they are
 *  not part of the shared ALIASES table (job records have none of them). */
const LOGO_ALIASES = ["logo", "company_logo", "logo_url", "company_logo_url"];
const IMAGE_ALIASES = ["image", "cover", "cover_image", "company_image", "banner", "background_cover_image"];
const SLOGAN_ALIASES = ["slogan", "company_slogan", "motto"];

/** Keep only values that look like real http(s) URLs — scraped rows can hold
 *  relative paths or empty strings for the image fields. */
function httpUrl(v: string): string | undefined {
  return /^https?:\/\//i.test(v) ? v : undefined;
}

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

/**
 * Build a failure payload from the edge function's response, carrying through
 * what/next/body/http_status when the function supplies them so the card can
 * show what actually failed instead of a generic line.
 */
function failedPayload(
  kind: ResearchKind,
  res: { what?: string; next?: string; body?: string; http_status?: number; raw?: unknown },
  defaultWhat: string,
  defaultNext: string,
): ResearchFailure {
  const what = res.what ?? defaultWhat;
  let next = res.next ?? "";
  if (!next) {
    if (typeof res.body === "string" && res.body.includes("is not set")) {
      next = "A Bright Data secret is missing. Set it in Supabase and re-run.";
    } else if (res.http_status === 401 || res.http_status === 403) {
      next = "Bright Data rejected the credentials or the zone. Check the dataset name and key.";
    } else if (res.http_status === 0 && typeof res.body === "string") {
      next = "The call did not complete. Re-run, and check the function logs if it repeats.";
    } else {
      next = defaultNext;
    }
  }
  return {
    status: "failed",
    kind,
    label: kind,
    what,
    next,
    detail: typeof res.body === "string" ? res.body : undefined,
    httpStatus: typeof res.http_status === "number" ? res.http_status : undefined,
    raw: res.raw,
  };
}

async function collectByUrl(
  fn: string,
  url: string,
  kind: ResearchKind,
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
    body?: string;
    http_status?: number;
    what?: string;
    next?: string;
  }>(fn, { url });

  if (first.status === "failed") {
    return {
      outcome: {
        status: "failed",
        payload: failedPayload(kind, first, "The scrape call failed.", "Re-run, and open the raw response below if it repeats."),
      },
      cached: false,
    };
  }

  if (first.status === "pending" && first.snapshot_id) {
    // Reuse the existing brightdata-status polling for any 202. Async
    // snapshots are the slow path, so poll every 5s up to 2 minutes
    // before reporting a genuine timeout.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(5000);
      const poll = await callEdge<{ status?: string; rows?: unknown[]; raw?: unknown; body?: string; http_status?: number; what?: string; next?: string }>("brightdata-status", {
        snapshot_id: first.snapshot_id,
      });
      if (poll.status === "ready") return { outcome: normalize(toRows(poll.rows, poll.raw), poll.raw), cached: false };
      if (poll.status === "failed") {
        return {
          outcome: {
            status: "failed",
            payload: failedPayload(kind, poll, "The snapshot scrape failed.", "Re-run, and open the raw response below if it repeats."),
          },
          cached: false,
        };
      }
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
  return collectByUrl("brightdata-jobs", url, "job", (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const title = pick(record, ALIASES.title);
    const company = pick(record, ALIASES.company);
    const location = pick(record, ALIASES.location);
    const jobUrl = pick(record, ALIASES.url) || url;
    // The job record carries the employer's LinkedIn company URL (e.g.
    // "https://www.linkedin.com/company/deltek?trk=public_jobs_topcard-org-name").
    // Surface it so the UI can follow it to the company dataset instead of
    // re-sending the job URL. The UI strips the ?trk=… query via cleanCompanyUrl.
    const companyUrl = pick(record, ["company_url", "companyUrl", "company_link"]);
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
    // The full cached job record carries a rich field set that was previously
    // dropped at normalization — the JD text (`job_summary`), employment type,
    // seniority, function, industries, posting dates, applicant count, the
    // employer logo, and the apply routing. Surface all of it: the job card
    // renders it, and the prep brief + questions are grounded in it.
    const summary = pick(record, ["job_summary", "summary", "job_description", "description_text"]);
    const numApplicantsRaw = record.job_num_applicants ?? record.num_applicants;
    const numApplicants =
      typeof numApplicantsRaw === "number" && Number.isFinite(numApplicantsRaw) ? numApplicantsRaw : undefined;
    const applyLink = httpUrl(pick(record, ["apply_link", "applyLink", "external_apply_link"]));
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
        companyUrl,
        summary,
        employmentType: pick(record, ["job_employment_type", "employment_type", "employmentType"]),
        seniorityLevel: pick(record, ["job_seniority_level", "seniority_level", "seniorityLevel"]),
        jobFunction: pick(record, ["job_function", "jobFunction", "function"]),
        industries: pick(record, ["job_industries", "jobIndustries", "company_industries"]),
        postedDate: pick(record, ["job_posted_date", "posted_date", "postedDate"]),
        postedTime: pick(record, ["job_posted_time", "posted_time", "postedTime"]),
        numApplicants,
        logo: httpUrl(pick(record, LOGO_ALIASES)),
        applyLink,
        easyApply: typeof record.is_easy_apply === "boolean" ? record.is_easy_apply : undefined,
        raw,
      },
    };
  });
}

/** Step 2 — the company profile (dataset gd_l1vikfnt1wgvvqz95w, collect by URL). */
export async function researchCompany(companyUrl: string): Promise<RawCollectResult> {
  return collectByUrl("brightdata-company", companyUrl, "company", (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const name = pick(record, ALIASES.company) || pick(record, ["company_name", "name", "organization"]);
    const industry = pick(record, ALIASES.industry);
    const size = pick(record, ALIASES.size);
    const headquarters = pick(record, ALIASES.headquarters);
    const description = pick(record, ALIASES.description);
    const logo = httpUrl(pick(record, LOGO_ALIASES));
    const image = httpUrl(pick(record, IMAGE_ALIASES));
    const slogan = pick(record, SLOGAN_ALIASES);
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
        logo,
        image,
        slogan,
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
      body?: string;
      http_status?: number;
      what?: string;
      next?: string;
    }>("brightdata-news", { companyName });
    if (res.status === "failed") {
      return {
        outcome: {
          status: "failed",
          payload: failedPayload("news", res, "The news search call failed.", "Check the SERP zone secret and try again."),
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