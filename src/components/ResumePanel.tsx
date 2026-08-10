import { useEffect, useRef, useState } from "react";
import { FileText, LogOut, Trash2, Upload } from "lucide-react";
import { MAX_RESUME_CHARS, deleteResume, forgetDevice, loadResume, readResumeFile, saveResume } from "../lib/resume";
import { accountIdentityFor, isAccountUser, signOutSession } from "../lib/accounts";
import { clearSplashDismissal, requestShowIntro } from "../lib/splash";
import type { Resume } from "../lib/types";
import { supabase } from "../lib/config";
import { Expander } from "./Expander";
import AccountPanel from "./AccountPanel";

/**
 * The resume panel — optional, collapsed by default, and the only place the
 * product asks for anything about the user.
 *
 * With a resume saved, every dossier gains a fit match and the interview
 * targets the gaps. Without one, the app works exactly as before.
 *
 * The account region lives here too — the one place accounts can be created
 * or signed into after the splash is gone. Anonymous visitors get the quiet
 * "Sign in / Create an account" surface; signed-in visitors get their
 * identity and Sign out. Signing out always settles back into a fresh
 * anonymous session — never a stranded app.
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
  const [isAccount, setIsAccount] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  // Which account view is open inline (null = the quiet account region).
  const [accountView, setAccountView] = useState<"signin" | "signup" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  // Account state is reactive, never a one-shot mount check: subscribe to the
  // auth session and derive state synchronously from the callback's user, so a
  // GitHub/Discord redirect return, an email sign-in or a sign-out re-renders
  // the panel in place — no reload, no awaited probe. onAuthStateChange fires
  // INITIAL_SESSION immediately on subscribe with the current session, which
  // covers the initial render. The panel never blocks on the network here.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAccount(isAccountUser(session?.user));
      setIdentity(accountIdentityFor(session?.user));
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

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

  /** Sign out of a real account — quiet, in the account region. The resume
   *  stays with the account (it is not a device wipe), and the session
   *  settles back to a fresh anonymous one so the app keeps working. The
   *  auth subscription flips the panel back to anonymous on its own. */
  const signOut = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const ok = await signOutSession();
    setBusy(false);
    setNote(ok ? "Signed out. This device is back to a private session." : "Couldn't sign out. Try again.");
    focusStatus();
  };

  /** Forget me on this device — anonymous only. Deletes the resume and drops
   *  the persisted identity, the only way to leave nothing behind on a shared
   *  machine when there is no login. Never shown for a real account: signing
   *  out is the account's equivalent, and it must never delete the resume. */
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

  /** Open the shared account form inline — no modal, no navigation. */
  const openAccount = (view: "signin" | "signup") => {
    setError(null);
    setNote(null);
    setAccountView(view);
  };

  /** After email sign-in/sign-up: collapse the form and reload the account's
   *  resume in the background — the account may hold a resume the anonymous
   *  session didn't (App does the same). The auth subscription flips the
   *  panel to the signed-in state on its own. */
  const handleAccountReady = async () => {
    setAccountView(null);
    const saved = await loadResume();
    if (saved) onChange(saved);
  };

  /** The testing/returning-visitor escape hatch: clear the flag so the intro
   *  shows again on the next load too, then ask App to re-show it now. */
  const showIntroAgain = () => {
    clearSplashDismissal();
    requestShowIntro();
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
              {/* Forget me on this device is anonymous-only — a real account
                  signs out in the account region instead (which never deletes
                  the resume). */}
              {!isAccount && (
                <button className="btn btn-ghost" onClick={forget} disabled={busy}>
                  Forget me on this device
                </button>
              )}
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
                Upload .txt, .md or .pdf
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
                accept=".txt,.md,.markdown,.text,text/plain,text/markdown,application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="font-mono text-[0.6875rem] text-slate">
              PDFs are read here — extracted in your browser, never uploaded.
            </p>
            <p className="font-mono text-[0.6875rem] text-slate">
              Saving stores it in your account and deletes it after 30 days without activity — you can delete it
              yourself at any time.
            </p>
          </div>
        )}

        {/* The account region — the permanent way in and out, for everyone,
            with or without a saved resume. Quiet: this is a tool that works
            without an account and never nags for one. */}
        <div className="border-t border-ink/15 pt-4">
          <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">account</p>

          {accountView ? (
            <div className="mt-4">
              <AccountPanel
                initialView={accountView}
                onReady={() => void handleAccountReady()}
                onBack={() => setAccountView(null)}
                compact
              />
            </div>
          ) : isAccount ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="min-w-0 font-mono text-[0.6875rem] text-slate">
                Signed in{identity ? ` · ${identity}` : ""}
              </p>
              <button className="btn btn-ghost" onClick={signOut} disabled={busy}>
                <LogOut aria-hidden="true" className="h-4 w-4" />
                Sign out
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <p className="max-w-[68ch] text-sm text-slate">Your resume follows you to another browser.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-secondary" onClick={() => openAccount("signin")} disabled={busy}>
                  Sign in
                </button>
                <button className="btn btn-secondary" onClick={() => openAccount("signup")} disabled={busy}>
                  Create an account
                </button>
              </div>
            </div>
          )}
        </div>

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

        {/* The escape hatch — a testing/returning-visitor link, not a product
            surface. One line, mono, quiet. */}
        <div className="border-t border-ink/15 pt-4">
          <button
            type="button"
            onClick={showIntroAgain}
            className="font-mono text-[0.6875rem] text-slate underline decoration-ink/30 underline-offset-2 transition-colors duration-150 ease-out hover:text-ink"
          >
            Show intro again
          </button>
        </div>
      </div>
    </Expander>
  );
}
