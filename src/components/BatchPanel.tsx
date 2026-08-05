import { useRef, useState } from "react";
import { FileAudio } from "lucide-react";
import type { LogEntry } from "../types";
import { callEdgeForm } from "../lib/config";
import Panel from "./Panel";
import Console from "./Console";
import StatusBadge from "./StatusBadge";
import type { RunStatus } from "../types";

export default function BatchPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [transcript, setTranscript] = useState("");

  const add = (level: LogEntry["level"], message: string) =>
    setLogs((prev) => [
      ...prev.slice(-199),
      { id: Date.now() + Math.random(), t: new Date().toLocaleTimeString([], { hour12: false }), level, message },
    ]);

  const clear = () => {
    setLogs([]);
    setTranscript("");
    setStatus("idle");
  };

  const run = async () => {
    if (!file) {
      add("warn", "Select an audio file first");
      return;
    }
    setRunning(true);
    setStatus("busy");
    setTranscript("");
    add("info", `Uploading "${file.name}" (${(file.size / 1024).toFixed(1)} KB) → batch transcription`);
    try {
      const form = new FormData();
      form.append("audio", file);
      const res = await callEdgeForm<{ transcript: string; jobId: string }>("speechmatics-batch", form);
      setTranscript(res.transcript ?? "");
      add("ok", `Transcription complete · job ${res.jobId} · ${(res.transcript ?? "").split(/\s+/).filter(Boolean).length} words`);
      setStatus("ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      add("error", `Transcription failed: ${msg}`);
      setStatus("error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      icon={<FileAudio className="h-5 w-5" />}
      iconClass="bg-violet-500/15 text-violet-400"
      title="Speechmatics · Batch STT"
      subtitle="Upload an audio file — async job transcribed on Speechmatics"
      status={<StatusBadge status={status} />}
    >
      <div className="flex flex-col gap-3">
        <button
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
        >
          <FileAudio className="h-4 w-4" />
          {file ? file.name : "Choose audio file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac,.aac,.opus"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) add("info", `Selected: ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={run} disabled={running || !file}>
            {running ? "Transcribing…" : "Transcribe file"}
          </button>
          <button className="btn btn-ghost" onClick={clear} disabled={running}>
            Clear
          </button>
        </div>
      </div>

      <Console logs={logs} placeholder="// pick a file and transcribe it" />

      {transcript && (
        <div className="overflow-hidden rounded-lg border border-border/60">
          <div className="border-b border-border/60 bg-background/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Transcript
          </div>
          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap bg-background/30 px-4 py-3 text-sm leading-relaxed text-foreground">
            {transcript}
          </p>
        </div>
      )}
    </Panel>
  );
}
