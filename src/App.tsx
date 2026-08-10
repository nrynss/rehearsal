import { useCallback, useEffect, useState } from "react";
import { Tabs } from "./components/Tabs";
import type { TabDef } from "./components/Tabs";
import ResearchScreen from "./components/ResearchScreen";
import RehearseScreen from "./components/RehearseScreen";
import ReliveScreen from "./components/ReliveScreen";
import SplashScreen from "./components/SplashScreen";
import { setNewPassword } from "./lib/accounts";
import { ensureAnonSession, supabase } from "./lib/config";
import { pickMimeType } from "./lib/audio";
import { loadResume } from "./lib/resume";
import { dismissSplash, hasDismissedSplash, onShowIntroRequested } from "./lib/splash";
import type { AnswerMode, Dossier, Resume, Session, TabId } from "./lib/types";

export default function App() {
  // The splash decision is synchronous (localStorage) — it never waits on the
  // network, so a slow or failing session can never be the reason someone
  // cannot get in.
  const [showSplash, setShowSplash] = useState<boolean>(() => !hasDismissedSplash());
  // Set when a saved resume turns up: the visitor has clearly been here, so
  // the splash leaves on its own (see SplashScreen's returningUser prop).
  const [returningUser, setReturningUser] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("research");
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [interviewRunning, setInterviewRunning] = useState(false);
  const [resume, setResume] = useState<Resume | null>(null);
  const [mode, setMode] = useState<AnswerMode>(() => (typeof MediaRecorder !== "undefined" && pickMimeType() ? "voice" : "text"));
  const [voiceUnsupported] = useState<boolean>(() => typeof MediaRecorder === "undefined" || !pickMimeType());
  // A password-recovery landing: the reset link arrives with PASSWORD_RECOVERY,
  // and this forces the set-new-password view even when the splash would
  // normally skip itself (dismissal flag set). The recovery session is already
  // a valid session, so the app keeps working either way.
  const [recovery, setRecovery] = useState(false);
  const [newPassword, setNewPasswordField] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void ensureAnonSession().then((ok) => {
      // The resume load runs alongside everything and is never awaited — a
      // slow or hung query against `resumes` must not be able to hold the app
      // on a blank screen. The app itself renders regardless of auth state.
      if (!ok) return;
      // StrictMode remounts effects in dev: the first mount is torn down before
      // its session promise resolves, so this guard is what keeps the touch at
      // "once per page load" there too.
      if (!active) return;
      // One activity touch per page load, fire-and-forget: it never blocks the
      // UI and its failure is never surfaced. The RPC updates zero rows when
      // there is no saved resume, so no further guard is needed. (The async
      // wrapper exists because supabase-js types rpc() as a thenable builder,
      // not a Promise — no .catch on the type.)
      void (async () => {
        try {
          await supabase.rpc("touch_resume_activity");
        } catch {
          // Intentional silence — a failed touch must never surface.
        }
      })();
      void loadResume().then((saved) => {
        if (!active || !saved) return;
        setResume(saved);
        // A saved resume means they've been here before — skip the splash for
        // them too, as soon as we know, without ever blocking on the network.
        setReturningUser(true);
      });
    });
    return () => {
      active = false;
    };
  }, []);

  // The password-recovery callback. detectSessionInUrl processes the fragment
  // at boot and fires PASSWORD_RECOVERY once; force the set-new-password view.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecovery(true);
      }
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  // "Show intro again" (the quiet link at the bottom of the resume panel):
  // re-show the splash without touching the visitor's work. Active tab,
  // dossiers, sessions and the resume all survive — the splash is an intro
  // overlay, not a logout — and enterApp/enterFromAccount re-dismiss it (and
  // re-set the flag) the next time any way in is used.
  useEffect(() => {
    return onShowIntroRequested(() => {
      setReturningUser(false);
      setShowSplash(true);
    });
  }, []);

  const goResearch = useCallback(() => setActiveTab("research"), []);

  /** Any way in — Start, Sign in or Create an account — dismisses for good. */
  const enterApp = useCallback(() => {
    dismissSplash();
    setShowSplash(false);
  }, []);

  /** Set the new password from the recovery landing, then enter the app. */
  const submitNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recoveryBusy || !newPassword) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    const result = await setNewPassword(newPassword);
    setRecoveryBusy(false);
    if (!result.ok) {
      setRecoveryError(result.message);
      return;
    }
    setRecovery(false);
    enterApp();
  };

  /** Skip for now — the recovery session is already valid; the app works. */
  const skipRecovery = () => {
    setRecovery(false);
    enterApp();
  };

  const enterFromAccount = useCallback(async () => {
    dismissSplash();
    setShowSplash(false);
    // The account we just created or signed into may hold a resume the
    // anonymous session didn't. Loaded in the background — never awaited
    // before the app shows.
    const saved = await loadResume();
    if (saved) setResume(saved);
  }, []);

  // Functional updater, not a plain array: dossier updates land after long
  // awaits (brief, fit match), and a captured array would silently drop any
  // dossier researched while those were in flight.
  const handleDossiers = useCallback(
    (update: (prev: Dossier[]) => Dossier[]) => setDossiers((prev) => update(prev)),
    [],
  );
  const handleSession = useCallback((s: Session) => setSessions((prev) => [s, ...prev]), []);

  // The recovery landing replaces the whole surface — it must always surface,
  // even when the splash would skip itself. The session is already valid, so
  // skipping just enters the app.
  if (recovery) {
    return (
      <main className="min-h-dvh bg-paper text-ink">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
          <h1 className="font-heading text-display-lg font-semibold tracking-tight">Set a new password</h1>
          <p className="mt-3 max-w-[68ch] text-sm text-slate">
            Pick a password you'll remember. Your saved resume stays with your account.
          </p>

          <form onSubmit={(e) => void submitNewPassword(e)} className="mt-8 flex max-w-md flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="recovery-password" className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
                new password
              </label>
              <input
                id="recovery-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                disabled={recoveryBusy}
                value={newPassword}
                onChange={(e) => {
                  setNewPasswordField(e.target.value);
                  setRecoveryError(null);
                }}
              />
            </div>

            {recoveryError && (
              <p role="alert" className="text-sm font-medium text-ink">
                {recoveryError}
              </p>
            )}

            <button type="submit" className="btn btn-primary" disabled={recoveryBusy || !newPassword}>
              {recoveryBusy ? "Saving…" : "Set new password"}
            </button>
            <button type="button" className="btn btn-ghost justify-start" onClick={skipRecovery} disabled={recoveryBusy}>
              Skip for now
            </button>
          </form>
        </div>
      </main>
    );
  }

  // The splash replaces the tab surface entirely while it is up — the app
  // does not render behind it. It leaves for good once dismissed.
  if (showSplash) {
    return <SplashScreen returningUser={returningUser} onStart={enterApp} onAccountReady={enterFromAccount} />;
  }

  const tabs: TabDef[] = [
    {
      id: "research",
      label: "Research",
      panel: (
        <ResearchScreen
          dossiers={dossiers}
          onDossiersChange={handleDossiers}
          headingId="main-heading-research"
          resume={resume}
          onResumeChange={setResume}
        />
      ),
    },
    {
      id: "rehearse",
      label: "Rehearse",
      panel: (
        <RehearseScreen
          dossiers={dossiers}
          onSessionComplete={handleSession}
          goResearch={goResearch}
          onRunningChange={setInterviewRunning}
          headingId="main-heading-rehearse"
          mode={mode}
          onModeChange={setMode}
          voiceUnsupported={voiceUnsupported}
          resumeText={resume?.content ?? null}
        />
      ),
    },
    {
      id: "relive",
      label: "Relive",
      panel: <ReliveScreen sessions={sessions} headingId="main-heading-relive" />,
    },
  ];

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <Header collapsed={interviewRunning} />

      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {activeTab} tab
        </div>
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} idPrefix="main" labelledBy="Rehearsal tabs" />
      </div>
    </div>
  );
}

function Header({ collapsed }: { collapsed: boolean }) {
  return (
    <header className="border-b border-ink/15">
      <div className={`mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 ${collapsed ? "py-3" : "py-6"}`}>
        <p className="font-heading text-xl font-semibold tracking-tight text-ink sm:text-2xl">Rehearsal</p>

        {/* Collapse as a height change, never a remount. */}
        <div className={`collapse-row ${collapsed ? "rows-closed" : "rows-open"}`}>
          <div className="collapse-inner">
            <p className="pt-1 text-sm text-slate">Research. Practice. Get hired.</p>
          </div>
        </div>
      </div>
    </header>
  );
}
