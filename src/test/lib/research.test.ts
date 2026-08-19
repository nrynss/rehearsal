import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheGet, cacheHas, cacheSet, cleanCompanyUrl, researchCompany, researchJob, researchNews } from "../../lib/research";

// vi.hoisted: vi.mock factories are hoisted above const declarations, so the
// mock fn must be created with vi.hoisted to avoid a temporal-dead-zone error.
const callEdgeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config", () => ({ callEdge: (...args: unknown[]) => callEdgeMock(...args) }));

const JOB_URL = "https://www.linkedin.com/jobs/view/4440232349/";

beforeEach(() => {
  callEdgeMock.mockReset();
});

describe("cleanCompanyUrl", () => {
  it("strips the query string and hash", () => {
    // Note: the URL API does not add a trailing slash to a bare pathname, so
    // the cleaned href keeps "/company/acme" as-is.
    expect(cleanCompanyUrl("https://www.linkedin.com/company/acme?trk=public_jobs_topcard#frag")).toBe(
      "https://www.linkedin.com/company/acme",
    );
  });

  it("returns invalid URLs unchanged", () => {
    expect(cleanCompanyUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("cache helpers", () => {
  it("round-trips a payload through the in-memory cache", () => {
    cacheSet("k", { status: "ok", kind: "job", label: "job", raw: {} }, "2026-01-15T10:00:00Z");
    expect(cacheHas("k")).toBe(true);
    expect(cacheGet("k")?.payload.status).toBe("ok");
    expect(cacheGet("k")?.fetchedAt).toBe("2026-01-15T10:00:00Z");
  });

  it("returns null for a missing key", () => {
    expect(cacheGet("missing")).toBeNull();
    expect(cacheHas("missing")).toBe(false);
  });
});

describe("researchJob", () => {
  it("normalizes a job record from a lone object (not array)", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      rows: [],
      raw: { job_title: "Senior Engineer", company_name: "Acme", job_location: "Berlin", job_summary: "Build things." },
    });
    const { outcome, cached } = await researchJob(JOB_URL);
    expect(outcome.status).toBe("ok");
    expect(cached).toBe(false);
    if (outcome.status === "ok" && outcome.payload?.status === "ok") {
      expect(outcome.payload.title).toBe("Senior Engineer");
      expect(outcome.payload.company).toBe("Acme");
      expect(outcome.payload.summary).toBe("Build things.");
    }
  });

  it("flags a dead page with a human reason", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", rows: [], raw: { error_code: "dead_page" } });
    const { outcome } = await researchJob(JOB_URL);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.payload?.status === "failed") {
      expect(outcome.payload.what).toMatch(/no longer live/i);
    }
  });

  it("marks the outcome as cached when the edge says so", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      cached: true,
      fetched_at: "2026-01-15T10:00:00Z",
      rows: [{ job_title: "Engineer", company_name: "Acme" }],
    });
    const { outcome, cached, fetchedAt } = await researchJob(JOB_URL);
    expect(cached).toBe(true);
    expect(fetchedAt).toBe("2026-01-15T10:00:00Z");
    expect(outcome.status).toBe("ok");
  });
});

describe("researchCompany", () => {
  it("picks aliased fields from a company record", async () => {
    callEdgeMock.mockResolvedValue({
      status: "ok",
      rows: [{ name: "Acme", company_industry: "Software", company_size: "1000", headquarters: "Berlin", logo: "https://example.com/logo.png" }],
    });
    const { outcome } = await researchCompany("https://www.linkedin.com/company/acme");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok" && outcome.payload?.status === "ok") {
      expect(outcome.payload.title).toBe("Acme");
      expect(outcome.payload.industry).toBe("Software");
      expect(outcome.payload.size).toBe("1000");
      expect(outcome.payload.logo).toBe("https://example.com/logo.png");
    }
  });
});

describe("researchNews", () => {
  it("slices headlines to 5 and reports ok", async () => {
    const headlines = Array.from({ length: 8 }, (_, i) => ({
      title: `Headline ${i}`,
      url: `https://example.com/${i}`,
      domain: "example.com",
      date: "2026-01-15",
    }));
    callEdgeMock.mockResolvedValue({ status: "ok", headlines });
    const { outcome, cached } = await researchNews("Acme");
    expect(outcome.status).toBe("ok");
    expect(cached).toBe(false);
    if (outcome.status === "ok" && outcome.payload?.status === "ok") {
      expect(outcome.payload.headlines).toHaveLength(5);
    }
  });

  it("reports failed when there are no headlines", async () => {
    callEdgeMock.mockResolvedValue({ status: "ok", headlines: [] });
    const { outcome } = await researchNews("Acme");
    expect(outcome.status).toBe("failed");
  });

  it("handles a thrown call with a friendly failure", async () => {
    callEdgeMock.mockRejectedValue(new Error("boom"));
    const { outcome } = await researchNews("Acme");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.payload?.status === "failed") {
      expect(outcome.payload.what).toContain("failed");
    }
  });

  it("passes body detail and a missing-secret next from a failed SERP response", async () => {
    callEdgeMock.mockResolvedValue({ status: "failed", body: "BRIGHTDATA_SERP_ZONE is not set — check the Supabase secrets." });
    const { outcome } = await researchNews("Acme");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.payload?.status === "failed") {
      expect(outcome.payload.next).toMatch(/secret is missing/i);
      expect(outcome.payload.detail).toMatch(/BRIGHTDATA_SERP_ZONE/i);
    }
  });

  it("passes what and next through unchanged when the function supplies them", async () => {
    callEdgeMock.mockResolvedValue({
      status: "failed",
      what: "You've run a lot of research in the last hour.",
      next: "Wait a few minutes, or use one of the example postings.",
    });
    const { outcome } = await researchNews("Acme");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.payload?.status === "failed") {
      expect(outcome.payload.what).toBe("You've run a lot of research in the last hour.");
      expect(outcome.payload.next).toBe("Wait a few minutes, or use one of the example postings.");
    }
  });

  it("maps a 401 http_status to a credentials next and carries httpStatus", async () => {
    callEdgeMock.mockResolvedValue({
      status: "failed",
      http_status: 401,
      body: "Unauthorized — check your Bright Data credentials.",
    });
    const { outcome } = await researchNews("Acme");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.payload?.status === "failed") {
      expect(outcome.payload.next).toMatch(/rejected the credentials|Check the SERP zone/i);
      expect(outcome.payload.httpStatus).toBe(401);
    }
  });
});
