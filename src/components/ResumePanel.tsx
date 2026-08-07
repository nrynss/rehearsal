import { useRef, useState } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { MAX_RESUME_CHARS, deleteResume, forgetDevice, readResumeFile, saveResume } from "../lib/resume";
import type { Resume } from "../lib/types";
import { Expander } from "./Expander";

/**
 * The resume panel — optional, collapsed by default, and the only place the
 * product asks for anything about the user.
 *
 * With a resume saved, every dossier gains a fit match and the interview
 * targets the gaps. Without one, the app works exactly as before.
 */

interface ResumePanelProps {
  resume: Resume | null;
  onChange: (r: Resume | null) => void;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString([], { hour12: false });
}

export default function ResumePanel({ resume, onChange }: ResumePanelProps) {
  const [draft, setDraft] = useState("");
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  /** Saving and deleting both unmount the button that was focused, which would
   *  otherwise drop focus to <body> and strand a keyboard user at the top of
   *  the page inside a collapsed panel. */
  const focusStatus = () => {
    window.requestAnimationFrame(() => statusRef.current?.focus());
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setNote(null);
    try {
      const text = await readResumeFile(file);
      setDraft(text);
      setFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file. Paste the text instead.");
    }
  };

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const saved = await saveResume(text, fileName);
    setBusy(false);
    if (!saved) {
      setError("Couldn't save your resume. It's still being used for this session — try saving again.");
      // Keep it usable in memory even though the row didn't land, so the fit
      // match and question targeting still work for this visit.
      onChange({ content: text, fileName, updatedAt: Date.now() });
      return;
    }
    onChange(saved);
    setDraft("");
    setFileName(undefined);
    setNote(
      saved.content.length < text.length
        ? `Saved — only the first ${MAX_RESUME_CHARS.toLocaleString()} characters were kept.`
        : "Saved.",
    );
    focusStatus();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const ok = await deleteResume();
    setBusy(false);
    if (!ok) {
      setError("Couldn't delete your resume. Try again.");
      return;
    }
    onChange(null);
    setNote("Deleted. Fit matches built from it have been removed too.");
    focusStatus();
  };

  /** Delete the resume and drop the persisted anonymous identity — the only
   *  way to leave nothing behind on a shared machine, since there is no login. */
  const forget = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const ok = await forgetDevice();
    setBusy(false);
    onChange(null);
    setNote(
      ok
        ? "Deleted, and this device has been forgotten. Reload to start fresh."
        : "This device has been forgotten, but the saved resume may not have been deleted. Try Delete again.",
    );
    focusStatus();
  };

  const summary = resume
    ? `${resume.fileName ?? "Pasted text"} · saved ${fmtWhen(resume.updatedAt)}`
    : "Optional — adds a fit match to every dossier";

  return (
    <Expander title="Your resume" meta={summary} entry="00" defaultOpen={false} idPrefix="resume">
      <div className="flex flex-col gap-4">
        <p className="max-w-[68ch] text-sm text-slate">
          Save your resume once and every posting you research gets a fit match — what you already have, what
          you're missing, and what to study first. The interview then asks about the gaps.
        </p>

        {resume ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <FileText aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-slate" />
              <div className="min-w-0">
                <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">saved</p>
                <p className="mt-1 text-sm text-ink">{resume.fileName ?? "Pasted text"}</p>
                <p className="font-mono text-[0.6875rem] text-slate">
                  {resume.content.length.toLocaleString()} characters · {fmtWhen(resume.updatedAt)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-secondary" onClick={() => setDraft(resume.content)} disabled={busy}>
                Replace
              </button>
              <button className="btn btn-ghost" onClick={remove} disabled={busy}>
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                Delete
              </button>
              <button className="btn btn-ghost" onClick={forget} disabled={busy}>
                Forget me on this device
              </button>
            </div>
          </div>
        ) : null}

        {(!resume || draft) && (
          <div className="flex flex-col gap-2">
            <label htmlFor="resume-text" className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
              paste your resume
            </label>
            <textarea
              id="resume-text"
              className="input min-h-48 font-sans"
              value={draft}
              maxLength={MAX_RESUME_CHARS}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
                setNote(null);
              }}
              placeholder="Paste the text of your resume here."
              disabled={busy}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={save} disabled={busy || !draft.trim()}>
                {busy ? "Saving…" : "Save resume"}
              </button>
              <button className="btn btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Upload aria-hidden="true" className="h-4 w-4" />
                Upload .txt or .md
              </button>
              {draft ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setDraft("");
                    setFileName(undefined);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Clear
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.markdown,.text,text/plain,text/markdown"
                className="sr-only"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="font-mono text-[0.6875rem] text-slate">
              PDFs aren't read here — open yours and paste the text.
            </p>
          </div>
        )}

        {/* Both regions are mounted unconditionally. A live region added to the
            tree in the same commit as its text is usually announced by nothing,
            which is exactly when the confirmation matters. */}
        <p role="alert" className="empty:hidden text-sm font-medium text-ink">
          {error ?? ""}
        </p>
        <p
          ref={statusRef}
          tabIndex={-1}
          aria-live="polite"
          className="empty:hidden font-mono text-[0.6875rem] text-slate"
        >
          {note ?? ""}
        </p>
      </div>
    </Expander>
  );
}
