import { describe, expect, it } from "vitest";
import {
  dossierIdFor,
  dossierTitle,
  fmtDuration,
  fmtStamp,
  getDossierKey,
  isJobViewUrl,
  jobKey,
  normalizeJobUrl,
} from "../../lib/prep";
import type { Dossier } from "../../lib/types";

describe("jobKey", () => {
  it("lowercases and trims the URL", () => {
    expect(jobKey("  HTTPS://Example.COM/Jobs/View/123  ")).toBe("https://example.com/jobs/view/123");
  });
});

describe("dossierIdFor", () => {
  it("is deterministic — the same URL always maps to the same id", () => {
    const a = dossierIdFor("https://www.linkedin.com/jobs/view/4440232349/");
    const b = dossierIdFor("https://www.linkedin.com/jobs/view/4440232349/");
    expect(a).toBe(b);
  });

  it("is stable across case and whitespace differences", () => {
    expect(dossierIdFor("  HTTPS://WWW.LINKEDIN.COM/Jobs/View/4440232349/  ")).toBe(
      dossierIdFor("https://www.linkedin.com/jobs/view/4440232349/"),
    );
  });

  it("produces a short, prefixed id", () => {
    const id = dossierIdFor("https://www.linkedin.com/jobs/view/4440232349/");
    expect(id.startsWith("d")).toBe(true);
    expect(id.length).toBeLessThan(12);
  });
});

describe("normalizeJobUrl", () => {
  it("strips tracking query params and normalises to www + trailing slash", () => {
    expect(
      normalizeJobUrl("https://www.linkedin.com/jobs/view/4440232349/?alternateChannel=shp&trk=public_jobs_topcard"),
    ).toBe("https://www.linkedin.com/jobs/view/4440232349/");
  });

  it("normalises a bare /jobs/view URL without www", () => {
    expect(normalizeJobUrl("https://linkedin.com/jobs/view/4440232349")).toBe(
      "https://www.linkedin.com/jobs/view/4440232349/",
    );
  });

  it("leaves non-LinkedIn URLs trimmed but unchanged", () => {
    expect(normalizeJobUrl("  https://example.com/foo?x=1  ")).toBe("https://example.com/foo?x=1");
  });

  it("keeps the job id when the path has extra segments", () => {
    expect(normalizeJobUrl("https://www.linkedin.com/jobs/view/4440232349/extra/segments")).toBe(
      "https://www.linkedin.com/jobs/view/4440232349/",
    );
  });
});

describe("isJobViewUrl", () => {
  it("accepts a canonical job view URL", () => {
    expect(isJobViewUrl("https://www.linkedin.com/jobs/view/4440232349/")).toBe(true);
  });

  it("accepts query params after the path", () => {
    expect(isJobViewUrl("https://www.linkedin.com/jobs/view/4440232349?trk=public_jobs_topcard")).toBe(true);
  });

  it("rejects a search page, a bare domain, and a non-https URL", () => {
    expect(isJobViewUrl("https://www.linkedin.com/jobs/search?keywords=engineer")).toBe(false);
    expect(isJobViewUrl("https://www.linkedin.com/")).toBe(false);
    expect(isJobViewUrl("http://www.linkedin.com/jobs/view/4440232349/")).toBe(false);
  });
});

describe("getDossierKey / dossierTitle", () => {
  const dossier = {
    id: "d1",
    jobTitle: "Senior Engineer",
    company: "Acme",
    jobUrl: "https://www.linkedin.com/jobs/view/4440232349/",
    createdAt: 0,
    cards: [],
    brief: [],
  } satisfies Dossier;

  it("getDossierKey derives the same key as dossierIdFor", () => {
    expect(getDossierKey(dossier)).toBe(dossierIdFor(dossier.jobUrl));
  });

  it("dossierTitle joins title and company", () => {
    expect(dossierTitle(dossier)).toBe("Senior Engineer · Acme");
  });

  it("dossierTitle falls back when both are empty", () => {
    expect(dossierTitle({ ...dossier, jobTitle: "", company: "" })).toBe("Untitled posting");
  });
});

describe("fmtStamp / fmtDuration", () => {
  it("formats a timestamp without AM/PM (24h)", () => {
    const stamp = fmtStamp(new Date(2026, 0, 15, 14, 30).getTime());
    expect(stamp).toContain("14:30");
  });

  it("formats duration as m s", () => {
    expect(fmtDuration(125_000)).toBe("2m 5s");
  });
});
