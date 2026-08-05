import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileSearch } from "lucide-react";
import {
  cacheGet,
  cacheSet,
  cleanCompanyUrl,
  researchCompany,
  researchJob,
  researchNews,
  type ResearchFailure,
  type ResearchResult,
} from "../lib/research";

/** The one job-posting URL pattern this screen accepts. */
const JOB_VIEW_RE = /^https:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/[A-Za-z0-9][A-Za-z0-9_-]*(\?[A-Za-z0-9_=&%.-]*)?$/i;

const STEP_ORDER: { kind: "job" | "company" | "news"; label: string; source: string }[] = [
  { kind: "job", label: "Job", source: "linkedin.com" },
  { kind: "company", label: "Company", source: "linkedin.com" },
  { kind: "news", label: "News", source: "google.com" },
];

function stampTime(): string {
  return new Date().toLocaleTimeString([], { hour12: false });
}

interface CardState {
  step: (typeof STEP_ORDER)[number];
  state: "pending" | "ok" | "error";
  payload?: ResearchResult | ResearchFailure;
  /** Present only for a fresh fetch; cached cards show a quiet marker instead. */
  freshAt?: string;
  /** Which source URL this card's payload is cached under. */
  cacheKey: string;
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

  // news
  const headlines = payload.headlines ?? [];
  return (
    <ul className="flex flex-col gap-3">
      {headlines.map((h, i) => (
        <li key={i} className="flex flex-col gap-1">
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

/** The raw response stays on every card behind a collapsed <details>. */
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

function ResearchCard({ card }: { card: CardState }) {
  const failed = card.state === "error" && card.payload && card.payload.status === "failed" ? card.payload : null;
  const ok = card.state === "ok" && card.payload && card.payload.status === "ok" ? card.payload : null;

  return (
    <article
      className={["dossier-card flex flex-col p-4", failed ? "border-signal/50" : ""].join(" ")}
      aria-busy={card.state === "pending"}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-slate">{card.step.label}</span>
          <span className="font-mono text-[0.6875rem] text-slate/80">{card.step.source}</span>
        </div>
        {ok && card.freshAt ? (
          <span className="font-mono text-[0.6875rem] text-slate">{card.freshAt}</span>
        ) : ok ? (
          <span className="font-mono text-[0.6875rem] italic text-slate">cached</span>
        ) : null}
      </header>

      {card.state === "pending" ? (
        <div className="flex items-center gap-2 text-sm text-slate" role="status">
          <span className="h-3 w-3 flex-none animate-pulse rounded-full bg-slate/50" aria-hidden="true" />
          <span className="font-mono text-[0.75rem]">running — waiting on {card.step.source}…</span>
        </div>
      ) : failed ? (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-signal">Could not retrieve {card.step.label.toLowerCase()}</p>
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

const EMPTY_RUN = { cards: [] as CardState[] };

export default function ResearchScreen() {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [run, setRun] = useState(EMPTY_RUN);
  const [running, setRunning] = useState(false);
  const runSeq = useRef(0);

  useEffect(() => {
    return () => {
      runSeq.current += 1; // drop in-flight results if unmounted
    };
  }, []);

  const isCached = (u: string) => cacheGet(u) !== null;

  const addCard = (card: CardState) => {
    setRun((prev) => ({ ...prev, cards: [...prev.cards, card] }));
  };

  const runChain = async () => {
    const u = url.trim();
    if (!JOB_VIEW_RE.test(u)) {
      setUrlError("This needs a single LinkedIn job posting URL — not a search page.");
      return;
    }
    setUrlError(null);
    setRun(EMPTY_RUN);
    setRunning(true);
    const seq = ++runSeq.current;

    // ---- Step 1: job -------------------------------------------------------
    const jobKey = u;
    const jobCached = cacheGet(jobKey);
    addCard({
      step: STEP_ORDER[0],
      state: jobCached ? "ok" : "pending",
      payload: jobCached ? jobCached.payload : undefined,
      freshAt: jobCached ? undefined : stampTime(),
      cacheKey: jobKey,
    });

    const jobRes = jobCached
      ? { status: "ok" as const, payload: jobCached.payload }
      : await researchJob(u);

    if (seq !== runSeq.current) return;

    if (jobRes.status !== "ok" || !jobRes.payload || jobRes.payload.status !== "ok") {
      setRun((prev) => ({
        ...prev,
        cards: [{ ...prev.cards[0], state: "error" as const, payload: jobRes.payload }, ...prev.cards.slice(1)],
      }));
      setRunning(false);
      return;
    }
    const jobPayload = jobRes.payload;
    if (!jobCached) {
      cacheSet(jobKey, jobPayload);
      setRun((prev) => ({
        ...prev,
        cards: [{ ...prev.cards[0], state: "ok" as const, payload: jobPayload, freshAt: stampTime() }],
      }));
    }

    // ---- Step 2: company ----------------------------------------------------
    // Only a failed job scrape stops the run. If the company URL is missing,
    // the company card fails but the flow still continues to news.
    const companyUrl = jobPayload.companyUrl ?? jobPayload.jobUrl;
    const companyName = jobPayload.company;
    let companyPayload: ResearchResult | null = null;

    if (!companyUrl) {
      addCard({
        step: STEP_ORDER[1],
        state: "error",
        payload: {
          status: "failed",
          kind: "company",
          label: "company",
          what: "The job record had no company URL to follow.",
          next: "The job card stays; the news card can still run.",
        },
        cacheKey: `${jobKey}::company`,
      });
    } else {
      const cleanCompany = cleanCompanyUrl(companyUrl);
      const companyKey = `company:${cleanCompany}`;
      const companyCached = cacheGet(companyKey);
      addCard({
        step: STEP_ORDER[1],
        state: companyCached ? "ok" : "pending",
        payload: companyCached ? companyCached.payload : undefined,
        freshAt: companyCached ? undefined : stampTime(),
        cacheKey: companyKey,
      });

      const companyRes = companyCached
        ? { status: "ok" as const, payload: companyCached.payload }
        : await researchCompany(cleanCompany);

      if (seq !== runSeq.current) return;

      const cp =
        companyRes.status === "ok" && companyRes.payload && companyRes.payload.status === "ok"
          ? companyRes.payload
          : null;

      if (cp && !companyCached) {
        cacheSet(companyKey, cp);
        setRun((prev) => ({
          ...prev,
          cards: prev.cards.map((c) =>
            c.step.kind === "company" ? { ...c, state: "ok" as const, payload: cp, freshAt: stampTime() } : c,
          ),
        }));
      } else if (!cp) {
        setRun((prev) => ({
          ...prev,
          cards: prev.cards.map((c) =>
            c.step.kind === "company" ? { ...c, state: "error" as const, payload: companyRes.payload } : c,
          ),
        }));
      }
      companyPayload = cp;
    }

    // ---- Step 3: news -------------------------------------------------------
    const name = companyPayload?.company ?? companyPayload?.title ?? companyName;
    if (!name) {
      addCard({
        step: STEP_ORDER[2],
        state: "error",
        payload: {
          status: "failed",
          kind: "news",
          label: "news",
          what: "No company name was available for the news search.",
          next: "The job and company cards stay; the news card could not run.",
        },
        cacheKey: `${jobKey}::news`,
      });
      setRunning(false);
      return;
    }

    const newsKey = `news:${name.toLowerCase()}`;
    const newsCached = cacheGet(newsKey);
    addCard({
      step: STEP_ORDER[2],
      state: newsCached ? "ok" : "pending",
      payload: newsCached ? newsCached.payload : undefined,
      freshAt: newsCached ? undefined : stampTime(),
      cacheKey: newsKey,
    });

    const newsRes = newsCached
      ? { status: "ok" as const, payload: newsCached.payload }
      : await researchNews(name);

    if (seq !== runSeq.current) return;

    if (newsRes.status === "ok" && newsRes.payload && newsRes.payload.status === "ok") {
      const newsPayload = newsRes.payload;
      if (!newsCached) cacheSet(newsKey, newsPayload);
      setRun((prev) => ({
        ...prev,
        cards: prev.cards.map((c) =>
          c.step.kind === "news" ? { ...c, state: "ok" as const, payload: newsPayload, freshAt: stampTime() } : c,
        ),
      }));
    } else {
      setRun((prev) => ({
        ...prev,
        cards: prev.cards.map((c) =>
          c.step.kind === "news" ? { ...c, state: "error" as const, payload: newsRes.payload } : c,
        ),
      }));
    }
    setRunning(false);
  };

  const cachedJob = isCached(url.trim());

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-ink">Research Dossier</h1>
        <p className="mt-2 text-sm text-slate">
          Paste a LinkedIn job posting. Three chained Bright Data calls — job, company, news — assemble an evidence file.
        </p>
      </header>

      <section className="mb-8 rounded-lg border border-ink/15 bg-flag/60 p-4" aria-label="Research input">
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
          <button className="btn btn-primary" onClick={runChain} disabled={running || !url.trim()}>
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
          <p id="research-url-error" role="alert" className="mt-2 text-sm font-medium text-signal">
            {urlError}
          </p>
        ) : null}
        {!running && cachedJob && (
          <p className="mt-2 font-mono text-[0.6875rem] italic text-slate">
            already cached — this URL will not spend a credit or refetch
          </p>
        )}
      </section>

      <div aria-live="polite" aria-atomic="true">
        {run.cards.length > 0 ? (
          <div className="flex flex-col gap-4">
            {run.cards.map((card, i) => (
              <ResearchCard key={`${card.step.kind}-${i}`} card={card} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-ink/25 px-6 py-10 text-center">
            <p className="font-heading text-lg text-slate">No dossier yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate">
              Paste a job posting above and run research. The file will assemble here, one card at a time.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
