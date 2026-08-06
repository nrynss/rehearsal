import type { Dossier } from "../lib/types";

/** A stable key for a job URL — used for dossier ids and session cache keys. */
export function jobKey(url: string): string {
  return url.trim().toLowerCase();
}

/** The dossier's UUID derives from the job URL: one job → one dossier. */
export function dossierIdFor(url: string): string {
  // Short, readable, deterministic — never shown to the user.
  let h = 2166136261;
  const s = jobKey(url);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `d${(h >>> 0).toString(36)}`;
}

/** Canonical form of a LinkedIn job posting URL — tracking params and hash
 *  stripped, www + https + trailing slash normalised. E.g.
 *  https://www.linkedin.com/jobs/view/4440232349/?alternateChannel=…&trk=…
 *  → https://www.linkedin.com/jobs/view/4440232349/
 *  Anything that isn't a LinkedIn jobs/view URL is returned trimmed, unchanged. */
export function normalizeJobUrl(rawUrl: string): string {
  const t = rawUrl.trim();
  try {
    const u = new URL(t);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const m = u.pathname.match(/^\/jobs\/view\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
      if (m) return `https://www.linkedin.com/jobs/view/${m[1]}/`;
    }
    return t;
  } catch {
    return t;
  }
}

export function isJobViewUrl(value: string): boolean {
  return /^https:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/[A-Za-z0-9][A-Za-z0-9_-]*\/?(\?[A-Za-z0-9_=&%.-]*)?$/i.test(
    value.trim(),
  );
}

/** One deterministic dossier per job URL — re-expanding it never re-runs a
 *  network call or spends a credit. */
export function getDossierKey(d: Dossier): string {
  return dossierIdFor(d.jobUrl);
}

export function dossierTitle(d: Dossier): string {
  const parts = [d.jobTitle, d.company].filter(Boolean);
  return parts.join(" · ") || "Untitled posting";
}

export function fmtStamp(ms: number): string {
  return new Date(ms).toLocaleString([], { hour12: false });
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}
