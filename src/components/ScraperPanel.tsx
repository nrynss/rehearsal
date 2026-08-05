import { useState } from "react";
import { Globe, Link2, Search } from "lucide-react";
import type { LogEntry, RunStatus } from "../types";
import { callEdge } from "../lib/config";
import Panel from "./Panel";
import Console from "./Console";
import StatusBadge from "./StatusBadge";

type Row = Record<string, unknown>;

interface ParsedJob {
  title: string;
  company: string;
  location: string;
  url: string;
}

interface ScraperResponse {
  status?: string;
  snapshot_id?: string;
  http_status?: number;
  body?: unknown;
  raw?: unknown;
  jobs?: unknown[];
}

// Bright Data returns snake_case names that differ between modes.
// Read each display field by trying the aliases in order.
const FIELD_ALIASES: Record<keyof ParsedJob, string[]> = {
  title: ["job_title", "title", "job_position", "position"],
  company: ["company_name", "company", "employer", "organization"],
  location: ["job_location", "location", "job_base_pay_location", "city"],
  url: ["url", "job_url", "link", "job_posting_url"],
};

const ERROR_FIELDS = ["error", "warning", "error_code"] as const;

function pick(row: Row, aliases: string[]): string {
  for (const key of aliases) {
    const v = row[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

function hasErrorField(row: Row): boolean {
  return ERROR_FIELDS.some((k) => {
    const v = row[k];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });
}

function firstError(rows: Row[]): string {
  for (const row of rows) {
    for (const k of ERROR_FIELDS) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== "") {
        return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
      }
    }
  }
  return "unknown";
}

export default function ScraperPanel() {
  const [mode, setMode] = useState<"url" | "keyword">("url");
  const [url, setUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const [location, setLocation] = useState("");
  const [maxJobs, setMaxJobs] = useState("10");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [raw, setRaw] = useState<unknown | null>(null);
  const [parsed, setParsed] = useState<ParsedJob[] | null>(null);

  const add = (level: LogEntry["level"], message: string) =>
    setLogs((prev) => [
      ...prev.slice(-199),
      { id: Date.now() + Math.random(), t: new Date().toLocaleTimeString([], { hour12: false }), level, message },
    ]);

  const clear = () => {
    setLogs([]);
    setRaw(null);
    setParsed(null);
    setStatus("idle");
  };

  const run = async () => {
    const body =
      mode === "url"
        ? { mode: "url" as const, url: url.trim() }
        : { mode: "keyword" as const, keyword: keyword.trim(), location: location.trim(), maxJobs: Math.max(1, Number(maxJobs) || 10) };

    setRunning(true);
    setStatus("busy");
    setRaw(null);
    setParsed(null);
    add(
      "info",
      mode === "url"
        ? `Collecting job by URL → brightdata-jobs`
        : `Discovering jobs for "${keyword.trim()}" → brightdata-jobs`,
    );

    try {
      const res = await callEdge<ScraperResponse>("brightdata-jobs", body);
      setRaw(res.raw != null ? res.raw : res);

      const records: Row[] = Array.isArray(res.jobs)
        ? (res.jobs as Row[])
        : Array.isArray(res.raw)
          ? (res.raw as Row[])
          : [];

      const rows: ParsedJob[] = records.map((r) => ({
        title: pick(r, FIELD_ALIASES.title),
        company: pick(r, FIELD_ALIASES.company),
        location: pick(r, FIELD_ALIASES.location),
        url: pick(r, FIELD_ALIASES.url),
      }));
      setParsed(rows);

      if (res.status === "failed") {
        const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "no detail from Bright Data");
        add("error", `Bright Data call failed (HTTP ${res.http_status ?? "?"}): ${detail}`);
        setStatus("error");
      } else if (res.status === "pending") {
        add(
          "warn",
          `Scrape submitted — still processing on Bright Data (snapshot ${res.snapshot_id ?? "?"}). No records yet; run again shortly.`,
        );
        setStatus("warn");
      } else if (records.length === 0) {
        add("warn", "0 records returned. The call succeeded but Bright Data matched nothing.");
        setStatus("warn");
      } else if (records.every(hasErrorField)) {
        add("error", `Every record carries an error field — first: ${firstError(records)}`);
        setStatus("error");
      } else if (rows.every((p) => !p.title && !p.url)) {
        const keys = Object.keys(records[0] ?? {}).join(", ");
        add("error", `No record has a readable title or url after alias mapping. Keys on first record: ${keys}`);
        setStatus("error");
      } else {
        const readable = rows.filter((p) => p.title || p.url).length;
        add("ok", `${readable}/${records.length} records had readable fields.`);
        setStatus("ok");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      add("error", `Request failed: ${msg}`);
      setStatus("error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      icon={<Globe className="h-5 w-5" />}
      iconClass="bg-amber-500/15 text-amber-400"
      title="Bright Data · LinkedIn Jobs"
      subtitle="Collect by URL or discover by keyword — dataset gd_lpfll7v5hcqtkxl6l"
      status={<StatusBadge status={status} />}
    >
      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Scraper mode" className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={mode === "url"}
            className={mode === "url" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setMode("url")}
            disabled={running}
          >
            <Link2 className="h-4 w-4" />
            Collect by URL
          </button>
          <button
            type="button"
            aria-pressed={mode === "keyword"}
            className={mode === "keyword" ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setMode("keyword")}
            disabled={running}
          >
            <Search className="h-4 w-4" />
            Discover by keyword
          </button>
        </div>

        {mode === "url" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="scraper-url" className="text-xs font-medium text-slate-400">
              LinkedIn job URL
            </label>
            <input
              id="scraper-url"
              className="input"
              type="url"
              placeholder="https://www.linkedin.com/jobs/view/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={running}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="scraper-keyword" className="text-xs font-medium text-slate-400">
                Keyword
              </label>
              <input
                id="scraper-keyword"
                className="input"
                type="text"
                placeholder="e.g. product manager"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                disabled={running}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scraper-location" className="text-xs font-medium text-slate-400">
                  Location
                </label>
                <input
                  id="scraper-location"
                  className="input"
                  type="text"
                  placeholder="e.g. Remote"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  disabled={running}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scraper-max" className="text-xs font-medium text-slate-400">
                  Max results
                </label>
                <input
                  id="scraper-max"
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={maxJobs}
                  onChange={(e) => setMaxJobs(e.target.value)}
                  disabled={running}
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-primary"
            onClick={run}
            disabled={running || (mode === "url" ? !url.trim() : !keyword.trim())}
          >
            {running
              ? mode === "url"
                ? "Collecting…"
                : "Discovering…"
              : mode === "url"
                ? "Collect job"
                : "Discover jobs"}
          </button>
          <button className="btn btn-ghost" onClick={clear} disabled={running}>
            Clear
          </button>
        </div>
      </div>

      <Console logs={logs} placeholder="// pick a mode, enter a query, and run" />

      {parsed && parsed.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Parsed · {parsed.length} job{parsed.length === 1 ? "" : "s"}
          </div>
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
            {parsed.map((job, i) => (
              <li key={i} className="rounded-lg border border-border/60 bg-background/30 px-3 py-2 text-sm">
                <p className="font-medium text-foreground">{job.title || "Untitled"}</p>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {[job.company, job.location].filter(Boolean).join(" · ") || "No company / location"}
                </p>
                {job.url && (
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block max-w-full truncate text-xs text-accent hover:underline"
                  >
                    {job.url}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {raw !== null && (
        <details open className="group rounded-lg border border-border/60">
          <summary className="cursor-pointer border-b border-border/60 bg-background/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 select-none">
            Raw response
          </summary>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words bg-background/30 px-4 py-3 font-mono text-xs leading-relaxed text-slate-300">
            {typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      )}
    </Panel>
  );
}
