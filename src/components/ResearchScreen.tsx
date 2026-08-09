import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, FileSearch, Mic } from "lucide-react";
import { Expander } from "./Expander";
import { cacheGet, cacheSet, cleanCompanyUrl, researchCompany, researchJob, researchNews } from "../lib/research";
import type { ResearchFailure, ResearchResult } from "../lib/research";
import { ensureAnonSession, getAccessToken } from "../lib/config";
import { clearAiCache, fingerprint, generateAiBrief, generateFitMatch } from "../lib/ai";
import ResumePanel from "./ResumePanel";
import type { AnswerMode, Dossier, DossierCard, FitMatch, Resume } from "../lib/types";
import { dossierIdFor, isJobViewUrl, normalizeJobUrl } from "../lib/prep";

const STEP_ORDER: { kind: "job" | "company" | "news"; label: string; source: string }[] = [
  { kind: "job", label: "Job", source: "linkedin.com" },
  { kind: "company", label: "Company", source: "linkedin.com" },
  { kind: "news", label: "News", source: "google.com" },
];

function formatFetchedAt(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString([], { hour12: false });
}

/** The prep brief is derived from the researched cards, each claim citing the
 *  card it came from. The role section now includes the full job-description
 *  text (`summary`), not just title/location — the richest field in the cache.
 *  When AI is configured the brief is upgraded by generateAiBrief; this
 *  evidence brief is the always-available fallback. */
function buildBrief(cards: DossierCard[]) {
  const job = cards.find((c) => c.step === "job" && c.state === "ok" && c.payload?.status === "ok")?.payload;
  const company = cards.find((c) => c.step === "company" && c.state === "ok" && c.payload?.status === "ok")?.payload;

  const role: { text: string; source: "job" | "company" | "news"; long?: boolean }[] = [];
  const companyFacts: { text: string; source: "job" | "company" | "news"; long?: boolean }[] = [];

  if (job?.status === "ok") {
    if (job.title) role.push({ text: `The posting is for ${job.title}.`, source: "job" });
    if (job.location) role.push({ text: `Based in ${job.location}.`, source: "job" });
    if (job.employmentType) role.push({ text: `Employment type: ${job.employmentType}.`, source: "job" });
    if (job.seniorityLevel) role.push({ text: `Seniority: ${job.seniorityLevel}.`, source: "job" });
    if (job.jobFunction) role.push({ text: `Function: ${job.jobFunction}.`, source: "job" });
    if (job.industries) role.push({ text: `Industry: ${job.industries}.`, source: "job" });
    // The full job description is the core of the prep — no longer truncated
    // to a 340-char stub. Rendered collapsed so the brief stays scannable.
    if (job.summary) {
      role.push({ text: job.summary, source: "job", long: true });
    } else if (job.description) {
      role.push({ text: job.description, source: "job", long: true });
    }
  }
  if (company?.status === "ok") {
    if (company.title) companyFacts.push({ text: `Company: ${company.title}.`, source: "company" });
    if (company.industry) companyFacts.push({ text: `Industry: ${company.industry}.`, source: "company" });
    if (company.size) companyFacts.push({ text: `Size: ${company.size}.`, source: "company" });
    if (company.headquarters) companyFacts.push({ text: `Headquarters: ${company.headquarters}.`, source: "company" });
    if (company.description) companyFacts.push({ text: company.description.slice(0, 340), source: "company" });
  }

  const brief = [];
  if (role.length) brief.push({ heading: "The role", claims: role });
  if (companyFacts.length) brief.push({ heading: "The company", claims: companyFacts });
  return brief;
}

interface ResearchScreenProps {
  dossiers: Dossier[];
  /** Functional updater — see `upsert`. Never pass a captured array. */
  onDossiersChange: (update: (prev: Dossier[]) => Dossier[]) => void;
  /** Heading id for the tabpanel's h1 so focus can land on it. */
  headingId?: string;
  /** Voice/Text answer mode — chosen here, used by Rehearse. */
  mode: AnswerMode;
  onModeChange: (m: AnswerMode) => void;
  /** True when no MediaRecorder or no supported mime type exists. */
  voiceUnsupported: boolean;
  /** The saved resume, if any — drives the fit match on every dossier. */
  resume: Resume | null;
  onResumeChange: (r: Resume | null) => void;
}

export default function ResearchScreen({
  dossiers,
  onDossiersChange,
  headingId,
  mode,
  onModeChange,
  voiceUnsupported,
  resume,
  onResumeChange,
}: ResearchScreenProps) {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionFailed, setSessionFailed] = useState(false);
  const runSeq = useRef(0);

  useEffect(() => {
    let active = true;
    ensureAnonSession().then((ok) => {
      if (!active) return;
      setSessionReady(ok);
      setSessionFailed(!ok);
    });
    return () => {
      active = false;
    };
  }, []);

  const isCached = (u: string) => cacheGet(u.trim()) !== null;

  /**
   * Always update from the previous state, never from a captured array.
   * `upsert` is called after awaits that can run for a minute (the AI brief,
   * then the fit match); reading `dossiers` from the enclosing closure would
   * resurrect a stale list and delete every dossier researched meanwhile.
   *
   * Existing entries are updated in place so a dossier does not jump to the
   * top of the list when its brief or fit match lands.
   */
  const upsert = (d: Dossier) => {
    onDossiersChange((prev) => {
      const i = prev.findIndex((x) => x.id === d.id);
      if (i === -1) return [d, ...prev];
      const next = prev.slice();
      next[i] = d;
      return next;
    });
  };

  /** Merge a partial update into one dossier without touching the others.
   *  Unlike `upsert({ ...capturedDossier, ... })`, this spreads the CURRENT
   *  dossier, so a field claimed concurrently — e.g. the fit match's
   *  `fitStatus`/`fitKey` landing while the prep brief is in flight — is
   *  preserved instead of silently dropped by a stale captured object. */
  const patchDossier = (id: string, patch: Partial<Dossier>) => {
    onDossiersChange((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  const runChain = async () => {
    if (!getAccessToken()) return;
    const u = normalizeJobUrl(url);
    if (!isJobViewUrl(u)) {
      setUrlError("This needs a single LinkedIn job posting URL — not a search page.");
      return;
    }
    setUrlError(null);
    setRunning(true);
    const seq = ++runSeq.current;

    // A dossier already exists for this URL — just re-open it, spend nothing.
    const existing = dossiers.find((d) => d.id === dossierIdFor(u));
    if (existing) {
      setRunning(false);
      return;
    }

    const base: Dossier = {
      id: dossierIdFor(u),
      jobTitle: "",
      company: "",
      jobUrl: u,
      createdAt: Date.now(),
      cards: [],
      brief: [],
    };
    const cards: DossierCard[] = [];

    // ---- Step 1: job -------------------------------------------------------
    const jobKey = u;
    const jobCached = cacheGet(jobKey);
    cards.push({
      step: "job",
      state: jobCached ? "ok" : "pending",
      payload: jobCached?.payload,
      freshAt: jobCached?.fetchedAt,
      cached: !!jobCached,
    });
    upsert({ ...base, cards: [...cards] });

    const jobRes = jobCached
      ? { outcome: { status: "ok" as const, payload: jobCached.payload }, cached: true, fetchedAt: jobCached.fetchedAt }
      : await researchJob(u);

    if (seq !== runSeq.current) return;

    if (jobRes.outcome.status !== "ok" || !jobRes.outcome.payload || jobRes.outcome.payload.status !== "ok") {
      cards[0] = { ...cards[0], state: "error", payload: jobRes.outcome.payload };
      upsert({ ...base, cards: [...cards] });
      setRunning(false);
      return;
    }
    const jobPayload = jobRes.outcome.payload;
    if (!jobCached) {
      const fetchedAt = jobRes.fetchedAt ?? new Date().toISOString();
      cacheSet(jobKey, jobPayload, fetchedAt);
    }
    cards[0] = {
      ...cards[0],
      state: "ok",
      payload: jobPayload,
      freshAt: jobRes.fetchedAt ?? jobCached?.fetchedAt,
      cached: jobRes.cached || !!jobCached,
    };
    upsert({ ...base, cards: [...cards] });

    // ---- Step 2: company ----------------------------------------------------
    const companyUrl = jobPayload.companyUrl ?? jobPayload.jobUrl;
    const companyName = jobPayload.company;
    let companyPayload: ResearchResult | null = null;

    if (!companyUrl) {
      cards.push({
        step: "company",
        state: "error",
        payload: {
          status: "failed",
          kind: "company",
          label: "company",
          what: "The job record had no company URL to follow.",
          next: "The job card stays; the news card can still run.",
        },
      });
    } else {
      const cleanCompany = cleanCompanyUrl(companyUrl);
      const companyKey = `company:${cleanCompany}`;
      const companyCached = cacheGet(companyKey);
      cards.push({
        step: "company",
        state: companyCached ? "ok" : "pending",
        payload: companyCached?.payload,
        freshAt: companyCached?.fetchedAt,
        cached: !!companyCached,
      });
      upsert({ ...base, cards: [...cards] });

      const companyRes = companyCached
        ? { outcome: { status: "ok" as const, payload: companyCached.payload }, cached: true, fetchedAt: companyCached.fetchedAt }
        : await researchCompany(cleanCompany);

      if (seq !== runSeq.current) return;

      const cp =
        companyRes.outcome.status === "ok" && companyRes.outcome.payload && companyRes.outcome.payload.status === "ok"
          ? companyRes.outcome.payload
          : null;

      if (cp && !companyCached) {
        const fetchedAt = companyRes.fetchedAt ?? new Date().toISOString();
        cacheSet(companyKey, cp, fetchedAt);
      }
      const companyCard = cards.find((c) => c.step === "company");
      if (companyCard) {
        if (cp) {
          companyCard.state = "ok";
          companyCard.payload = cp;
          companyCard.freshAt = companyRes.fetchedAt ?? companyCached?.fetchedAt;
          companyCard.cached = companyRes.cached || !!companyCached;
        } else {
          companyCard.state = "error";
          companyCard.payload = companyRes.outcome.payload;
        }
      }
      upsert({ ...base, cards: [...cards] });
      companyPayload = cp;
    }

    // ---- Step 3: news -------------------------------------------------------
    const name = companyPayload?.company ?? companyPayload?.title ?? companyName;
    if (!name) {
      cards.push({
        step: "news",
        state: "error",
        payload: {
          status: "failed",
          kind: "news",
          label: "news",
          what: "No company name was available for the news search.",
          next: "The job and company cards stay; the news card could not run.",
        },
      });
      upsert({ ...base, cards: [...cards] });
      setRunning(false);
      return;
    }

    const newsKey = `news:${name.toLowerCase()}`;
    const newsCached = cacheGet(newsKey);
    cards.push({
      step: "news",
      state: newsCached ? "ok" : "pending",
      payload: newsCached?.payload,
      freshAt: newsCached?.fetchedAt,
      cached: !!newsCached,
    });
    upsert({ ...base, cards: [...cards] });

    const newsRes = newsCached
      ? { outcome: { status: "ok" as const, payload: newsCached.payload }, cached: true, fetchedAt: newsCached.fetchedAt }
      : await researchNews(name);

    if (seq !== runSeq.current) return;

    const newsCard = cards.find((c) => c.step === "news");
    if (newsCard) {
      if (newsRes.outcome.status === "ok" && newsRes.outcome.payload && newsRes.outcome.payload.status === "ok") {
        const newsPayload = newsRes.outcome.payload;
        if (!newsCached) {
          const fetchedAt = newsRes.fetchedAt ?? new Date().toISOString();
          cacheSet(newsKey, newsPayload, fetchedAt);
        }
        newsCard.state = "ok";
        newsCard.payload = newsPayload;
        newsCard.freshAt = newsRes.fetchedAt ?? newsCached?.fetchedAt;
        newsCard.cached = newsRes.cached || !!newsCached;
      } else {
        newsCard.state = "error";
        newsCard.payload = newsRes.outcome.payload;
      }
    }
    upsert({ ...base, cards: [...cards] });
    setRunning(false);
  };

  const finishDossier = (d: Dossier) => {
    const job = d.cards.find((c) => c.step === "job" && c.payload?.status === "ok")?.payload;
    const t = job?.status === "ok" ? job.title ?? "" : "";
    const c = job?.status === "ok" ? job.company ?? "" : "";
    const brief = buildBrief(d.cards);
    // The evidence brief is a placeholder, not the product — it restates the
    // cards above it. Mark it "generating" so the user knows the analysis is
    // still coming rather than mistaking the fact list for the brief.
    patchDossier(d.id, { jobTitle: t, company: c, brief, briefStatus: "generating", briefFromAi: false });

    // Fire the AI prep brief in the background — the evidence brief renders
    // immediately; the AI study guide replaces it when it lands (or leaves the
    // evidence brief in place if AI is unavailable). Cache hits return fast.
    //
    // The fit match is NOT run here: it is driven by an effect keyed on the
    // resume, so saving or replacing a resume backfills dossiers that were
    // already on screen.
    void (async () => {
      const ai = await generateAiBrief(d);
      if (ai && ai.length > 0) {
        patchDossier(d.id, { jobTitle: t, company: c, brief: ai, briefStatus: "ready", briefFromAi: true });
      } else {
        patchDossier(d.id, { jobTitle: t, company: c, brief, briefStatus: "failed", briefFromAi: false });
      }
    })();
  };

  const resumeText = resume?.content.trim() ?? "";
  const resumeKey = fingerprint(resumeText || null);

  /**
   * Drive the fit match from the resume, not from the research run.
   *
   * Keyed on `(dossier, resume fingerprint)` so that saving, replacing or
   * deleting a resume updates every dossier already on screen. Running it from
   * `finishDossier` meant a resume saved after researching a job produced
   * nothing, forever — the panel promises a fit match on "every posting you
   * research", and this is what makes that true.
   */
  useEffect(() => {
    // No resume: strip any fit left over from a resume that has been deleted.
    if (!resumeText) {
      clearAiCache("ai_fit:");
      onDossiersChange((prev) =>
        prev.some((d) => d.fit || d.fitStatus)
          ? prev.map((d) =>
              d.fit || d.fitStatus ? { ...d, fit: undefined, fitStatus: undefined, fitKey: undefined } : d,
            )
          : prev,
      );
      return;
    }

    const target = dossiers.find(
      (d) => d.cards.length > 0 && !d.cards.some((c) => c.state === "pending") && d.fitKey !== resumeKey,
    );
    if (!target) return;

    // Claim it synchronously so this effect does not pick the same dossier
    // again on the next render while the call is in flight.
    onDossiersChange((prev) =>
      prev.map((d) => (d.id === target.id ? { ...d, fitStatus: "generating", fitKey: resumeKey } : d)),
    );

    // Deliberately NO cleanup/`active` flag around the write: the claim above
    // re-renders this effect and tears the first run down before the AI call
    // resolves, so a cleanup guard would discard every result and leave the
    // dossier stuck on "generating" forever. The updater's `fitKey ===
    // resumeKey` re-check is the correct guard — it skips any write
    // superseded by a newer claim or a resume change — and `onDossiersChange`
    // is App's stable setter, so a late write after a tab switch is harmless.
    void (async () => {
      const fit = await generateFitMatch(target, resumeText);
      onDossiersChange((prev) =>
        prev.map((d) =>
          d.id === target.id && d.fitKey === resumeKey
            ? { ...d, fit: fit ?? undefined, fitStatus: fit ? "ready" : "failed" }
            : d,
        ),
      );
    })();
  }, [dossiers, resumeKey, resumeText, onDossiersChange]);

  /** Clear the fit key so the effect above picks this dossier up again. The
   *  cached failure is evicted too, or the retry would replay it. */
  const retryFit = (id: string) => {
    clearAiCache("ai_fit:");
    onDossiersChange((prev) =>
      prev.map((d) => (d.id === id ? { ...d, fit: undefined, fitStatus: undefined, fitKey: undefined } : d)),
    );
  };

  /** Regenerate a failed prep brief. The in-memory AI cache is cleared first
   *  or the retry would replay the cached failure; the evidence brief stays on
   *  screen while the analysis is in flight and is replaced only if it lands. */
  const retryBrief = (id: string) => {
    const d = dossiers.find((x) => x.id === id);
    if (!d) return;
    clearAiCache("ai_brief:");
    const job = d.cards.find((c) => c.step === "job" && c.payload?.status === "ok")?.payload;
    const t = job?.status === "ok" ? job.title ?? "" : "";
    const c = job?.status === "ok" ? job.company ?? "" : "";
    const brief = buildBrief(d.cards);
    patchDossier(d.id, { jobTitle: t, company: c, brief, briefStatus: "generating", briefFromAi: false });
    void (async () => {
      const ai = await generateAiBrief(d);
      if (ai && ai.length > 0) {
        patchDossier(d.id, { jobTitle: t, company: c, brief: ai, briefStatus: "ready", briefFromAi: true });
      } else {
        patchDossier(d.id, { jobTitle: t, company: c, brief, briefStatus: "failed", briefFromAi: false });
      }
    })();
  };

  const cachedJob = isCached(url.trim());

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
          Research
        </h1>
        <p className="mt-2 max-w-[68ch] text-sm text-slate">
          Paste a LinkedIn job posting. Three chained calls — job, company, news — assemble an evidence file you can
          rehearse against.
        </p>
      </header>

      {sessionFailed && (
        <div role="alert" className="mb-6 border border-ink/15 bg-flag/60 p-4">
          <p className="text-sm font-medium text-ink">Couldn't start a session. Reload the page to try again.</p>
        </div>
      )}

      <section className="mb-8 border-b border-ink/15 pb-8" aria-label="Research input">
        <label htmlFor="research-url" className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
          linkedin job posting url
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="research-url"
            type="url"
            className="input flex-1"
            placeholder="https://www.linkedin.com/jobs/view/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError(null);
            }}
            onBlur={(e) => {
              const cleaned = normalizeJobUrl(e.target.value);
              if (cleaned !== e.target.value) setUrl(cleaned);
            }}
            disabled={running}
            aria-invalid={!!urlError}
            aria-describedby={urlError ? "research-url-error" : undefined}
          />
          <button className="btn btn-primary" onClick={runChain} disabled={running || !url.trim() || !sessionReady}>
            {running ? (
              <>
                <FileSearch aria-hidden="true" className="h-4 w-4" />
                Assembling…
              </>
            ) : (
              "Run research"
            )}
          </button>
        </div>
        {urlError ? (
          <p id="research-url-error" role="alert" className="mt-2 text-sm font-medium text-ink">
            {urlError}
          </p>
        ) : null}
        {!running && cachedJob && (
          <p className="mt-2 font-mono text-[0.6875rem] italic text-slate">
            already cached — this URL will not spend a credit or refetch
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">answer with</span>
          <button
            type="button"
            onClick={() => onModeChange("voice")}
            disabled={voiceUnsupported}
            aria-pressed={mode === "voice"}
            className={`btn btn-sm ${mode === "voice" && !voiceUnsupported ? "btn-primary" : "btn-secondary"}`}
          >
            <Mic aria-hidden="true" className="h-4 w-4" />
            Voice
          </button>
          <button
            type="button"
            onClick={() => onModeChange("text")}
            aria-pressed={mode === "text"}
            className={`btn btn-sm ${mode === "text" ? "btn-primary" : "btn-secondary"}`}
          >
            Text
          </button>
          {voiceUnsupported ? (
            <span className="font-mono text-[0.6875rem] italic text-slate">
              voice isn't supported here — text mode only
            </span>
          ) : null}
        </div>

      </section>

      {/* Not a list item — Expander renders an <article>, so it sits on its own. */}
      <ResumePanel resume={resume} onChange={onResumeChange} />

      {/* No aria-live here. `aria-atomic` on a container this large made screen
          readers re-read every dossier — cards, brief and fit match — on every
          state change. Announcements belong in a small dedicated status region. */}
      <div>
        {dossiers.length > 0 ? (
          <ul className="flex flex-col">
            {dossiers.map((d, i) => (
              <DossierEntry
                key={d.id}
                dossier={d}
                entry={String(i + 1).padStart(2, "0")}
                onReady={finishDossier}
                onRetryFit={retryFit}
                onRetryBrief={retryBrief}
              />
            ))}
          </ul>
        ) : (
          <div className="border border-dashed border-ink/25 px-6 py-10 text-center">
            <p className="font-heading text-lg text-slate">No dossiers yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate">
              Paste a job posting above and run research. The file will assemble here, one card at a time.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DossierEntry({
  dossier,
  entry,
  onReady,
  onRetryFit,
  onRetryBrief,
}: {
  dossier: Dossier;
  entry: string;
  onReady: (d: Dossier) => void;
  onRetryFit: (id: string) => void;
  onRetryBrief: (id: string) => void;
}) {
  const [didFinish, setDidFinish] = useState(false);

  useEffect(() => {
    if (didFinish) return;
    const anyPending = dossier.cards.some((c) => c.state === "pending");
    if (!anyPending && dossier.cards.length > 0) {
      setDidFinish(true);
      onReady(dossier);
    }
  }, [dossier, didFinish, onReady]);

  return (
    <li>
      <Expander
        entry={entry}
        title={dossier.jobTitle || "Researching…"}
        meta={
          dossier.cards.some((c) => c.state === "pending")
            ? "assembling dossier…"
            : `${dossier.company || "Unknown company"} · ${dossier.jobUrl.replace(/^https?:\/\//, "")}`
        }
      >
        <div className="flex flex-col gap-4">
          {dossier.cards.map((card) => (
            <ResearchCard key={card.step} card={card} />
          ))}
          {dossier.brief.length > 0 ? (
            <BriefBlock
              brief={dossier.brief}
              ai={dossier.briefFromAi}
              status={dossier.briefStatus}
              onRetry={() => onRetryBrief(dossier.id)}
            />
          ) : null}
          <FitBlock fit={dossier.fit} status={dossier.fitStatus} onRetry={() => onRetryFit(dossier.id)} />
        </div>
      </Expander>
    </li>
  );
}

function ResearchCard({ card }: { card: DossierCard }) {
  const failed = card.state === "error" && card.payload?.status === "failed" ? card.payload : null;
  const ok = card.state === "ok" && card.payload?.status === "ok" ? card.payload : null;

  return (
    <article className="flex flex-col gap-2" aria-busy={card.state === "pending"}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-slate">
            {STEP_ORDER.find((s) => s.kind === card.step)?.label}
          </span>
          <span className="font-mono text-[0.6875rem] text-slate/80">
            {STEP_ORDER.find((s) => s.kind === card.step)?.source}
          </span>
        </div>
        {ok && card.freshAt ? (
          <span className="font-mono text-[0.6875rem] text-slate">
            {formatFetchedAt(card.freshAt) ?? card.freshAt}
            {card.cached ? <span className="italic"> · cached</span> : null}
          </span>
        ) : ok ? (
          <span className="font-mono text-[0.6875rem] italic text-slate">cached</span>
        ) : null}
      </header>

      {card.state === "pending" ? (
        <div className="flex items-center gap-2 text-sm text-slate" role="status">
          <span className="h-3 w-3 flex-none animate-pulse rounded-full bg-slate/50" aria-hidden="true" />
          <span className="font-mono text-[0.75rem]">
            running — waiting on {STEP_ORDER.find((s) => s.kind === card.step)?.source}…
          </span>
        </div>
      ) : failed ? (
        <div role="alert" className="failure-box flex flex-col gap-1">
          <p className="text-sm font-semibold text-ink">Could not retrieve {failed.label.toLowerCase()}</p>
          <p className="text-sm text-slate">{failed.what}</p>
          <p className="text-sm text-slate">{failed.next}</p>
        </div>
      ) : ok ? (
        <>
          <CardBody payload={ok} />
          <RawBlock raw={ok.raw} />
        </>
      ) : null}
    </article>
  );
}

function CardBody({ payload }: { payload: ResearchResult }) {
  if (payload.kind === "job") {
    return <JobBody payload={payload} />;
  }

  if (payload.kind === "company") {
    return <CompanyBody payload={payload} />;
  }

  return <NewsBody payload={payload} />;
}

/** The job card now renders the full cached field set — the JD text
 *  (`summary`), employment type, seniority, function, industries, posting
 *  dates, applicant count, the employer logo and the apply routing. These were
 *  all present in the cache but previously dropped at normalization. */
function JobBody({ payload }: { payload: ResearchResult }) {
  const [logoOk, setLogoOk] = useState(true);
  const posted = payload.postedDate
    ? (() => {
        const d = new Date(payload.postedDate);
        return Number.isNaN(d.getTime()) ? payload.postedDate : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
      })()
    : "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        {payload.logo && logoOk ? (
          <img
            src={payload.logo}
            alt={`${payload.company || "Company"} logo`}
            loading="lazy"
            onError={() => setLogoOk(false)}
            className="h-12 w-12 flex-none rounded-sm border border-ink/15 bg-paper object-contain p-1"
          />
        ) : null}
        <div className="min-w-0">
          {payload.title ? <p className="font-heading text-display-sm font-semibold leading-tight text-ink">{payload.title}</p> : null}
          {payload.company ? <p className="mt-0.5 text-sm text-slate">{payload.company}</p> : null}
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {payload.location ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">location</dt>
            <dd className="mt-0.5 text-ink">{payload.location}</dd>
          </div>
        ) : null}
        {payload.employmentType ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">employment</dt>
            <dd className="mt-0.5 text-ink">{payload.employmentType}</dd>
          </div>
        ) : null}
        {payload.seniorityLevel ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">seniority</dt>
            <dd className="mt-0.5 text-ink">{payload.seniorityLevel}</dd>
          </div>
        ) : null}
        {payload.jobFunction ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">function</dt>
            <dd className="mt-0.5 text-ink">{payload.jobFunction}</dd>
          </div>
        ) : null}
        {payload.industries ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">industry</dt>
            <dd className="mt-0.5 text-ink">{payload.industries}</dd>
          </div>
        ) : null}
        {posted ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">posted</dt>
            <dd className="mt-0.5 text-ink">
              {posted}
              {payload.postedTime ? <span className="text-slate"> · {payload.postedTime}</span> : null}
            </dd>
          </div>
        ) : null}
        {typeof payload.numApplicants === "number" && payload.numApplicants > 0 ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">applicants</dt>
            <dd className="mt-0.5 text-ink">{payload.numApplicants.toLocaleString()}</dd>
          </div>
        ) : null}
        {payload.easyApply ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">apply</dt>
            <dd className="mt-0.5 text-ink">Easy Apply on LinkedIn</dd>
          </div>
        ) : null}
        {payload.jobUrl ? (
          <div className={payload.applyLink ? "" : "sm:col-span-2"}>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">posting</dt>
            <dd className="mt-0.5">
              <a
                href={normalizeJobUrl(payload.jobUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-[0.8125rem] text-slate underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                {normalizeJobUrl(payload.jobUrl)}
              </a>
            </dd>
          </div>
        ) : null}
        {payload.applyLink ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">apply</dt>
            <dd className="mt-0.5">
              <a
                href={payload.applyLink}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-[0.8125rem] text-slate underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                {payload.applyLink}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {/* The full job description — the core of the dossier. Collapsed by
          default so the card stays scannable; open to read the actual
          responsibilities and qualifications. */}
      {payload.summary ? (
        <details className="raw-block group mt-1">
          <summary className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
            <span>full description</span>
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <pre className="text-sm leading-relaxed">{payload.summary}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** The company card gets the visual treatment: the LinkedIn cover image as a
 *  banner, the square logo overlapping its bottom edge, then the facts grid.
 *  Images are content, not chrome — hairline separators, no boxes or shadows. */
function CompanyBody({ payload }: { payload: ResearchResult }) {
  const [coverOk, setCoverOk] = useState(true);
  const [logoOk, setLogoOk] = useState(true);
  const cover = payload.image && coverOk ? payload.image : null;

  return (
    <div className="flex flex-col">
      {cover ? (
        <div className="h-28 overflow-hidden border-b border-ink/15 sm:h-36">
          <img
            src={cover}
            alt=""
            loading="lazy"
            onError={() => setCoverOk(false)}
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}

      <div className={`flex items-start gap-3 ${cover ? "-mt-8" : ""}`}>
        {payload.logo && logoOk ? (
          <img
            src={payload.logo}
            alt={`${payload.title || "Company"} logo`}
            loading="lazy"
            onError={() => setLogoOk(false)}
            className="h-14 w-14 flex-none rounded-sm border border-ink/15 bg-paper object-contain p-1 sm:h-16 sm:w-16"
          />
        ) : null}
        {payload.title || payload.slogan ? (
          <div className="min-w-0">
            {payload.title ? (
              <p className="font-heading text-display-sm font-semibold leading-tight text-ink">{payload.title}</p>
            ) : null}
            {payload.slogan ? <p className="mt-1 text-sm italic text-slate">{payload.slogan}</p> : null}
          </div>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {payload.industry ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">industry</dt>
            <dd className="mt-0.5 text-ink">{payload.industry}</dd>
          </div>
        ) : null}
        {payload.size ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">size</dt>
            <dd className="mt-0.5 text-ink">{payload.size}</dd>
          </div>
        ) : null}
        {payload.headquarters ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">headquarters</dt>
            <dd className="mt-0.5 text-ink">{payload.headquarters}</dd>
          </div>
        ) : null}
        {payload.description ? (
          <div className="sm:col-span-2">
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">about</dt>
            <dd className="mt-0.5 leading-relaxed text-ink">{payload.description}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function NewsBody({ payload }: { payload: ResearchResult }) {
  const headlines = payload.headlines ?? [];
  return (
    <ul className="flex flex-col gap-3">
      {headlines.map((h, i) => (
        <li key={`${h.url}-${i}`} className="flex flex-col gap-1">
          <a
            href={h.url || undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium leading-snug text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink"
          >
            {h.title}
          </a>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] text-slate">
            <span>{h.domain}</span>
            {h.date ? <span>{h.date}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RawBlock({ raw }: { raw: unknown }) {
  return (
    <details className="raw-block group mt-3">
      <summary className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
        <span>raw response</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <pre>{typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}</pre>
    </details>
  );
}

/** Resume measured against this posting. Renders nothing without a resume —
 *  the section only exists when there is something to compare. */
function FitBlock({
  fit,
  status,
  onRetry,
}: {
  fit?: FitMatch;
  status?: Dossier["fitStatus"];
  onRetry?: () => void;
}) {
  if (!status || status === "idle") return null;

  if (status === "generating") {
    return (
      <section className="mt-6 border-t border-ink/15 pt-4" aria-label="Fit match">
        <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Fit match</h2>
        <p className="mt-3 font-mono text-[0.75rem] text-slate">measuring your resume against this posting…</p>
      </section>
    );
  }

  if (status === "failed" || !fit) {
    return (
      <section className="mt-6 border-t border-ink/15 pt-4" aria-label="Fit match">
        <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Fit match</h2>
        <p className="mt-2 max-w-[68ch] text-sm text-slate">
          Couldn't measure your resume against this posting. The dossier above is unaffected.
        </p>
        {onRetry ? (
          <button className="btn btn-secondary mt-3" onClick={onRetry}>
            Try the fit match again
          </button>
        ) : null}
      </section>
    );
  }

  const columns: { heading: string; items: FitMatch["strengths"] }[] = [
    { heading: "What you already have", items: fit.strengths },
    { heading: "What's missing", items: fit.gaps },
  ];

  return (
    <section className="mt-6 border-t border-ink/15 pt-4" aria-label="Fit match">
      <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Fit match</h2>
      {fit.verdict ? <p className="mt-2 max-w-[68ch] text-sm text-ink">{fit.verdict}</p> : null}

      {columns.map(({ heading, items }) =>
        items.length > 0 ? (
          <div key={heading} className="mt-4">
            <h3 className="text-sm font-semibold text-ink">{heading}</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((item, i) => (
                <li key={i} className="max-w-[68ch] text-sm text-ink">
                  {item.text}
                  {item.evidence ? (
                    <span className="ml-1 font-mono text-[0.6875rem] text-slate">— {item.evidence}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}

      {fit.studyPlan.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">Study first</h3>
          <ol className="mt-2 flex flex-col gap-2">
            {fit.studyPlan.map((step, i) => (
              <li key={i} className="flex max-w-[68ch] gap-3 text-sm text-ink">
                <span className="font-mono text-[0.6875rem] text-slate">{String(i + 1).padStart(2, "0")}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function BriefBlock({
  brief,
  ai,
  status,
  onRetry,
}: {
  brief: Dossier["brief"];
  ai?: boolean;
  status?: Dossier["briefStatus"];
  onRetry?: () => void;
}) {
  // Three honest states: the analysis is coming, it arrived, or it could not be
  // produced and what is on screen is only the evidence restated.
  const label =
    status === "generating"
      ? "reading the posting…"
      : ai
        ? "ai study guide"
        : "evidence only — analysis unavailable";

  return (
    <section className="mt-6 border-t border-ink/15 pt-4" aria-label="Prep brief">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Prep brief</h2>
        <span className="font-mono text-[0.6875rem] italic text-slate">{label}</span>
      </div>
      <div className="mt-2 flex flex-col gap-4">
        {brief.map((section) => (
          <div key={section.heading}>
            <h3 className="font-heading text-display-sm font-semibold text-ink">{section.heading}</h3>
            <ul className="mt-1 flex flex-col gap-2">
              {section.claims.map((claim, i) =>
                claim.long ? (
                  <li key={i}>
                    <details className="raw-block group mt-1">
                      <summary className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
                        <span>full description</span>
                        <ChevronDown
                          aria-hidden="true"
                          className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-180"
                        />
                      </summary>
                      <pre className="text-sm leading-relaxed">{claim.text}</pre>
                    </details>
                  </li>
                ) : (
                  <li key={i} className="text-sm leading-relaxed text-ink">
                    {claim.text}
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>
      {!ai && status === "failed" && onRetry ? (
        <button className="btn btn-secondary mt-4" onClick={onRetry}>
          Try the analysis again
        </button>
      ) : null}
    </section>
  );
}
