import { useState } from "react";
import { Activity, Terminal } from "lucide-react";
import ScraperPanel from "./components/ScraperPanel";
import BatchPanel from "./components/BatchPanel";
import RealtimePanel from "./components/RealtimePanel";

export default function App() {
  const [liveText, setLiveText] = useState("");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Terminal className="h-6 w-6" />
            </div>
            <div>
              <h1 className="font-heading text-xl font-bold tracking-tight">Connectivity Spike</h1>
              <p className="text-sm text-slate-400">
                End-to-end validation harness for third-party API integrations
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/40 px-3 py-1.5 text-xs text-slate-400">
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            Supabase Edge Functions · native-builder
          </div>
        </header>

        {/* Panels */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ScraperPanel />
          <BatchPanel />
          <div className="lg:col-span-2">
            <RealtimePanel liveText={liveText} onLiveText={setLiveText} />
          </div>
        </div>

        {/* Footer note */}
        <footer className="mt-8 border-t border-border/60 pt-4 text-center text-xs text-slate-500">
          API keys are held in Supabase Edge Function secrets — never in the browser. Bright Data + Speechmatics.
        </footer>
      </div>
    </div>
  );
}
