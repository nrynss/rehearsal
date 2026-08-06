import { callEdge, sleep } from "./config";

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

/** Root-level aliases (snake_case + camelCase) for a dataset record. */
const ALIASES: Record<string, string[]> = {
  title: ["job_title", "title", "job_position", "position", "headline"],
  company: ["company_name", "company", "employer", "organization"],
  location: ["job_location", "location", "job_base_pay_location", "city"],
  url: ["url", "job_url", "link", "job_posting_url", "job_link"],
  industry: ["company_industry", "industry", "industries"],
  size: ["company_size", "company_size_range", "size", "employees", "employees_on_linkedin"],
  headquarters: ["company_headquarters", "headquarters", "hq", "location_city"],
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
const cache = new Map<string, { payload: ResearchPayload; at: number }>();

export function cacheGet(key: string) {
  return cache.get(key) ?? null;
}
export function cacheSet(key: string, payload: ResearchPayload) {
  cache.set(key, { payload, at: Date.now() });
}
export function cacheHas(key: string) {
  return cache.has(key);
}

/**
 * Reused by every dataset call: 202 → poll bright-data-status until ready;
 * non-ok → failed; rows → normalized record.
 */
async function collectByUrl(
  fn: string,
  url: string,
  normalize: (rows: unknown[], raw: unknown) => ResearchOutcome,
): Promise<ResearchOutcome> {
  const first = await callEdge<{
    status?: string;
    snapshot_id?: string;
    rows?: unknown[];
    raw?: unknown;
    snapshotId?: unknown;
  }>(fn, { url });

  if (first.status === "failed") return { status: "failed" };

  if (first.status === "pending" && first.snapshot_id) {
    // Reuse the existing bright-data-status polling for any 202. Async
    // snapshots are the slow path, so poll every 5s up to 2 minutes
    // before reporting a genuine timeout.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(5000);
      const poll = await callEdge<{ status?: string; rows?: unknown[]; raw?: unknown }>("brightdata-status", {
        snapshot_id: first.snapshot_id,
      });
      if (poll.status === "ready") return normalize(poll.rows ?? [], poll.raw);
      if (poll.status === "failed") return { status: "failed" };
    }
    return { status: "pending" };
  }

  return normalize(first.rows ?? [], first.raw);
}

function pendingFailure(kind: ResearchKind, label: string): ResearchOutcome {
  return {
    status: "failed",
    payload: {
      status: "failed",
      kind,
      label,
      what: "Bright Data did not finish processing in time.",
      next: "Wait a few minutes, then re-run — nothing was cached, so it will try again.",
    },
  };
}

/** Step 1 — the job posting (dataset gd_lpfll7v5hcqtkxl6l, collect by URL). */
export async function researchJob(url: string): Promise<ResearchOutcome> {
  const result = await collectByUrl("brightdata-jobs", url, (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const title = pick(record, ALIASES.title);
    const company = pick(record, ALIASES.company);
    const location = pick(record, ALIASES.location);
    const jobUrl = pick(record, ALIASES.url) || url;
    if (!title && !company) {
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "job",
          label: "job",
          what: "Bright Data returned no readable job data for this URL.",
          next: "Confirm the job posting still exists, then re-run.",
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
  return result.status === "pending" ? pendingFailure("job", "job") : result;
}

/** Step 2 — the company profile (dataset gd_l1vikfnt1wgvvqz95w, collect by URL). */
export async function researchCompany(companyUrl: string): Promise<ResearchOutcome> {
  const result = await collectByUrl("brightdata-company", companyUrl, (rows, raw): ResearchOutcome => {
    const record = (rows[0] ?? {}) as Record<string, unknown>;
    const name = pick(record, ALIASES.company) || pick(record, ["company_name", "name", "organization"]);
    const industry = pick(record, ALIASES.industry);
    const size = pick(record, ALIASES.size);
    const headquarters = pick(record, ALIASES.headquarters);
    const description = pick(record, ["company_description", "description", "about", "tagline"]);
    if (!name && !industry && !size) {
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "company",
          label: "company",
          what: "Bright Data returned no readable company profile for this URL.",
          next: "Check the company page still resolves, then re-run.",
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
  return result.status === "pending" ? pendingFailure("company", "company") : result;
}

/** Step 3 — one SERP news query for the company, headlines + source domains + dates only. */
export async function researchNews(companyName: string): Promise<ResearchOutcome> {
  try {
    const res = await callEdge<{
      status?: string;
      query?: string;
      headlines?: NewsHeadline[];
      raw?: unknown;
    }>("brightdata-news", { companyName });
    if (res.status === "failed") {
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "news",
          label: "news",
          what: "The news search call failed.",
          next: "Check the SERP zone secret and try again.",
          raw: res.raw,
        },
      };
    }
    const headlines = (res.headlines ?? []).slice(0, 5);
    if (headlines.length === 0) {
      return {
        status: "failed",
        payload: {
          status: "failed",
          kind: "news",
          label: "news",
          what: "The news search returned no headlines.",
          next: "Try a different company or re-run later.",
          raw: res.raw,
        },
      };
    }
    return {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      payload: {
        status: "failed",
        kind: "news",
        label: "news",
        what: `The news search call failed: ${msg}`,
        next: "Check the network and try again.",
      },
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
