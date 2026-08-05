import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import type { LogEntry } from "../types";
import { callEdge } from "../lib/config";
import { startPcmCapture } from "../lib/audio";
import type { PcmCapture } from "../lib/audio";
import Panel from "./Panel";
import Console from "./Console";
import StatusBadge from "./StatusBadge";
import type { RunStatus } from "../types";

const SM_REGION = "eu";

interface TranscriptResult {
  alternatives?: { content?: string }[];
}

interface RealtimePanelProps {
  liveText: string;
  onLiveText: (text: string) => void;
}

export default function RealtimePanel({ liveText, onLiveText }: RealtimePanelProps) {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [recording, setRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const finalTextRef = useRef("");

  const add = useCallback((level: LogEntry["level"], message: string) => {
    setLogs((prev) => [
      ...prev.slice(-199),
      { id: Date.now() + Math.random(), t: new Date().toLocaleTimeString([], { hour12: false }), level, message },
    ]);
  }, []);

  /**
   * Tear down the active PCM capture. Nulls the ref FIRST so a throwing or
   * malformed handle can never be stopped twice (which previously surfaced
   * as "captureRef.current?.stop is not a function").
   */
  const stopCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture && typeof (capture as { stop?: unknown }).stop === "function") {
      capture.stop();
    }
  }, []);

  const clear = () => {
    setLogs([]);
    onLiveText("");
    finalTextRef.current = "";
    setStatus("idle");
  };

  const stop = useCallback(() => {
    setRecording(false);
    stopCapture();
    wsRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    add("info", "Session ended");
    setStatus("idle");
  }, [add, stopCapture]);

  const start = async () => {
    try {
      setStatus("busy");
      finalTextRef.current = "";
      onLiveText("");
      add("info", "Requesting microphone…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      add("ok", "Microphone acquired");

      add("info", "Fetching realtime token from Edge Function…");
      const { token } = await callEdge<{ token: string }>("speechmatics-token");
      add("ok", "Token received");

      const ws = new WebSocket(`wss://${SM_REGION}.rt.speechmatics.com/v2?jwt=${token}`);
      wsRef.current = ws;

      ws.onopen = async () => {
        add("ok", "WebSocket connected");
        const startMsg = {
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
          transcription_config: {
            language: "en",
            max_delay: 2,
            enable_partials: true,
          },
        };
        ws.send(JSON.stringify(startMsg));

        try {
          const capture = await startPcmCapture(stream, (pcm) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(pcm);
            }
          });
          // The socket may have closed (or the user hit Stop) while capture
          // was still starting — if so, tear it down instead of adopting it.
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
            if (capture && typeof (capture as { stop?: unknown }).stop === "function") {
              capture.stop();
            }
            return;
          }
          captureRef.current = capture;
          setRecording(true);
          setStatus("busy");
          add("ok", "Streaming audio → Speechmatics (PCM 16k)");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          add("error", `PCM capture failed: ${msg}`);
          ws.close();
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as {
            message?: string;
            results?: TranscriptResult[];
            error?: string;
          };
          if (msg.message === "AddPartialTranscript") {
            const text = (msg.results ?? [])
              .map((r) => r.alternatives?.[0]?.content ?? "")
              .join(" ")
              .trim();
            if (text) onLiveText(finalTextRef.current ? finalTextRef.current + " " + text : text);
          } else if (msg.message === "AddTranscript") {
            const text = (msg.results ?? [])
              .map((r) => r.alternatives?.[0]?.content ?? "")
              .join(" ")
              .trim();
            if (text) {
              finalTextRef.current = finalTextRef.current
                ? finalTextRef.current + " " + text
                : text;
              onLiveText(finalTextRef.current);
              add("info", `Final: ${text}`);
            }
          } else if (msg.message === "Error") {
            add("error", `Server error: ${msg.error ?? "unknown"}`);
          }
        } catch {
          /* ignore non-JSON */
        }
      };

      ws.onclose = (ev) => {
        add("warn", `Socket closed (${ev.code})`);
        setRecording(false);
        stopCapture();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setStatus("idle");
      };

      ws.onerror = () => {
        add("error", "WebSocket error");
        setStatus("error");
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      add("error", `Start failed: ${msg}`);
      setStatus("error");
    }
  };

  useEffect(() => () => {
    stopCapture();
    wsRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, [stopCapture]);

  return (
    <Panel
      icon={<Mic className="h-5 w-5" />}
      iconClass="bg-rose-500/15 text-rose-400"
      title="Speechmatics · Realtime STT"
      subtitle="Live microphone → websocket streaming transcription"
      status={<StatusBadge status={recording ? "busy" : status} />}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!recording ? (
          <button className="btn btn-primary" onClick={start} disabled={status === "busy"}>
            <Mic className="h-4 w-4" />
            Start listening
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stop}>
            <Square className="h-4 w-4" />
            Stop
          </button>
        )}
        <button className="btn btn-ghost" onClick={clear} disabled={recording}>
          Clear
        </button>
      </div>

      <Console logs={logs} placeholder="// press Start listening and speak" />

      {(liveText || recording) && (
        <div className="overflow-hidden rounded-lg border border-border/60">
          <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live transcript</span>
            {recording && (
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-rose-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" aria-hidden="true" />
                LIVE
              </span>
            )}
          </div>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap bg-background/30 px-4 py-3 text-sm leading-relaxed text-foreground">
            {liveText || (recording ? "Listening…" : "")}
          </p>
        </div>
      )}
    </Panel>
  );
}
