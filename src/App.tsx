import { useCallback, useEffect, useState } from "react";
import { Tabs } from "./components/Tabs";
import type { TabDef } from "./components/Tabs";
import ResearchScreen from "./components/ResearchScreen";
import RehearseScreen from "./components/RehearseScreen";
import ReliveScreen from "./components/ReliveScreen";
import { ensureAnonSession } from "./lib/config";
import { pickMimeType } from "./lib/audio";
import type { AnswerMode, Dossier, Session, TabId } from "./lib/types";

export default function App() {
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("research");
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [interviewRunning, setInterviewRunning] = useState(false);
  const [mode, setMode] = useState<AnswerMode>(() => (typeof MediaRecorder !== "undefined" && pickMimeType() ? "voice" : "text"));
  const [voiceUnsupported] = useState<boolean>(() => typeof MediaRecorder === "undefined" || !pickMimeType());

  useEffect(() => {
    let active = true;
    void ensureAnonSession().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const goResearch = useCallback(() => setActiveTab("research"), []);

  const handleDossiers = useCallback((next: Dossier[]) => setDossiers(next), []);
  const handleSession = useCallback((s: Session) => setSessions((prev) => [s, ...prev]), []);

  if (!ready) return null;

  const tabs: TabDef[] = [
    {
      id: "research",
      label: "Research",
      panel: (
        <ResearchScreen
          dossiers={dossiers}
          onDossiersChange={handleDossiers}
          headingId="main-heading-research"
          mode={mode}
          onModeChange={setMode}
          voiceUnsupported={voiceUnsupported}
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
          voiceUnsupported={voiceUnsupported}
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
