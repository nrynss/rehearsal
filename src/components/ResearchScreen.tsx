import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileSearch, Mic } from "lucide-react";
import { Expander } from "./Expander";
import { cacheGet, cacheSet, cleanCompanyUrl, researchCompany, researchJob, researchNews } from "../lib/research";
import type { ResearchResult } from "../lib/research";
import { ensureAnonSession, getAccessToken } from "../lib/config";
import type { AnswerMode, Dossier, DossierCard } from "../lib/types";
import { dossierIdFor, isJobViewUrl } from "../lib/prep";

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
 *  card it came from. No LLM call — it is built from the evidence on screen. */
function buildBrief(cards: DossierCard[]) {
  const job = cards.find((c) => c.step === "job" && c.state === "ok" && c.payload?.status === "ok")?.payload;
  const company = cards.find((c) => c.step === "company" && c.state === "ok" && c.payload?.status === "ok")?.payload;
  const news = cards.find((c) => c.step === "news" && c.state === "ok" && c.payload?.status === "ok")?.payload;

  const role: { text: string; source: "job" | "company" | "news" }[] = [];
  const companyFacts: { text: string; source: "job" | "company" | "news" }[] = [];
  const newsFacts: { text: string; source: "job" | "company" | "news" }[] = [];

  if (job?.status === "ok") {
    if (job.title) role.push({ text: `The posting is for ${job.title}.`, source: "job" });
    if (job.location) role.push({ text: `Based in ${job.location}.`, source: "job" });
    if (job.description) role.push({ text: job.description.slice(0, 340), source: "job" });
  }
  if (company?.status === "ok") {
    if (company.title) companyFacts.push({ text: `Company: ${company.title}.`, source: "company" });
    if (company.industry) companyFacts.push({ text: `Industry: ${company.industry}.`, source: "company" });
    if (company.size) companyFacts.push({ text: `Size: ${company.size}.`, source: "company" });
    if (company.headquarters) companyFacts.push({ text: `Headquarters: ${company.headquarters}.`, source: "company" });
    if (company.description) companyFacts.push({ text: company.description.slice(0, 340), source: "company" });
  }
  if (news?.status === "ok") {
    for (const h of news.headlines ?? []) newsFacts.push({ text: h.title, source: "news" });
  }

  const brief = [];
  if (role.length) brief.push({ heading: "The role", claims: role });
  if (companyFacts.length) brief.push({ heading: "The company", claims: companyFacts });
  if (newsFacts.length) brief.push({ heading: "Recent news", claims: newsFacts });
  return brief;
}

interface ResearchScreenProps {
  dossiers: Dossier[];
  onDossiersChange: (dossiers: Dossier[]) => void;
  /** Heading id for the tabpanel's h1 so focus can land on it. */
  headingId?: string;
  /** Voice/Text answer mode — chosen here, used by Rehearse. */
  mode: AnswerMode;
  onModeChange: (m: AnswerMode) => void;
  /** True when no MediaRecorder or no supported mime type exists. */
  voiceUnsupported: boolean;
}

export default function ResearchScreen({
  dossiers,
  onDossiersChange,
  headingId,
  mode,
  onModeChange,
  voiceUnsupported,
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

  const patchDossiers = (next: Dossier[]) => {
    onDossiersChange(next);
  };

  const upsert = (d: Dossier) => {
    patchDossiers([d, ...dossiers.filter((x) => x.id !== d.id)]);
  };

  const runChain = async () => {
    if (!getAccessToken()) return;
    const u = url.trim();
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
    upsert({ ...d, jobTitle: t, company: c, brief });
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

      <div aria-live="polite" aria-atomic="true">
        {dossiers.length > 0 ? (
          <ul className="flex flex-col">
            {dossiers.map((d, i) => (
              <DossierEntry key={d.id} dossier={d} entry={String(i + 1).padStart(2, "0")} onReady={finishDossier} />
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

function DossierEntry({ dossier, entry, onReady }: { dossier: Dossier; entry: string; onReady: (d: Dossier) => void }) {
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
          {dossier.brief.length > 0 ? <BriefBlock brief={dossier.brief} /> : null}
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
    return (
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {payload.title ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">title</dt>
            <dd className="mt-0.5 font-medium text-ink">{payload.title}</dd>
          </div>
        ) : null}
        {payload.company ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">company</dt>
            <dd className="mt-0.5 font-medium text-ink">{payload.company}</dd>
          </div>
        ) : null}
        {payload.location ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">location</dt>
            <dd className="mt-0.5 text-ink">{payload.location}</dd>
          </div>
        ) : null}
        {payload.jobUrl ? (
          <div className="sm:col-span-2">
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">posting</dt>
            <dd className="mt-0.5">
              <a
                href={payload.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-[0.8125rem] text-slate underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
              >
                {payload.jobUrl}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    );
  }

  if (payload.kind === "company") {
    return (
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {payload.title ? (
          <div>
            <dt className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">company</dt>
            <dd className="mt-0.5 font-medium text-ink">{payload.title}</dd>
          </div>
        ) : null}
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
    );
  }

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

function BriefBlock({ brief }: { brief: Dossier["brief"] }) {
  return (
    <section className="mt-6 border-t border-ink/15 pt-4" aria-label="Prep brief">
      <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Prep brief</h2>
      <div className="mt-2 flex flex-col gap-4">
        {brief.map((section) => (
          <div key={section.heading}>
            <h3 className="font-heading text-display-sm font-semibold text-ink">{section.heading}</h3>
            <ul className="mt-1 flex flex-col gap-2">
              {section.claims.map((claim, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  <span className="text-sm leading-relaxed text-ink">{claim.text}</span>
                  <span className="font-mono text-[0.6875rem] text-slate">source · {claim.source}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
