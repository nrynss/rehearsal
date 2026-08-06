import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Mic, Play, SkipForward, Square } from "lucide-react";
import { scoreAnswer } from "../lib/score";
import { pickMimeType, extFor, transcribeBlob } from "../lib/audio";
import type { AnswerMode, Dossier, InterviewQuestion, Session } from "../lib/types";
import { PERSONAS } from "../lib/types";

interface RehearseProps {
  dossiers: Dossier[];
  onSessionComplete: (s: Session) => void;
  /** Jump back to the Research tab from an empty state. */
  goResearch: () => void;
  /** Notify the shell when an interview starts/stops so the header can shrink. */
  onRunningChange: (running: boolean) => void;
  headingId?: string;
  /** Voice/Text mode — chosen on the Research tab. */
  mode: AnswerMode;
  voiceUnsupported: boolean;
}

/** Deterministic, dossier-grounded questions — no network call, no credit.
 *  Each question cites the card it came from. */
function buildQuestions(d: Dossier): InterviewQuestion[] {
  const job = d.cards.find((c) => c.step === "job" && c.payload?.status === "ok")?.payload;
  const company = d.cards.find((c) => c.step === "company" && c.payload?.status === "ok")?.payload;
  const news = d.cards.find((c) => c.step === "news" && c.payload?.status === "ok")?.payload;
  const qs: InterviewQuestion[] = [];

  if (job?.status === "ok") {
    qs.push({
      id: "q1",
      text: `Walk me through why you're a strong fit for ${job.title ?? "this role"}.`,
      keyPoints: [
        { label: "Name the company", facts: [job.company?.toLowerCase() ?? "company"] },
        { label: "Name the role", facts: [job.title?.toLowerCase() ?? "role"] },
        { label: "Reference the location", facts: job.location ? [job.location.toLowerCase()] : [] },
      ],
      modelAnswer:
        `The posting for ${job.title ?? "this role"} at ${job.company ?? "the company"} needs someone who can own the remit end to end. ` +
        `My strongest evidence is that I have done exactly this before, so I would start by walking the team through a concrete example, then connect it to what this posting specifically asks for.`,
      sourceCard: "job",
      sourceLabel: "job · linkedin.com",
    });
  }

  if (company?.status === "ok") {
    qs.push({
      id: "q2",
      text: `What do you understand about ${company.title ?? "the company"} and its business?`,
      keyPoints: [
        { label: "Name the industry", facts: company.industry ? [company.industry.toLowerCase()] : [] },
        { label: "Reference the size", facts: company.size ? [company.size.toLowerCase()] : [] },
        { label: "Reference headquarters", facts: company.headquarters ? [company.headquarters.toLowerCase()] : [] },
      ],
      modelAnswer:
        `${company.title ?? "The company"} operates in ${company.industry ?? "its industry"}, sits at roughly ${company.size ?? "its scale"}, ` +
        `and is headquartered in ${company.headquarters ?? "its HQ"}. I would anchor my answer in those facts and then show how my background maps onto them.`,
      sourceCard: "company",
      sourceLabel: "company · linkedin.com",
    });
  }

  if (news?.status === "ok") {
    const headlines = news.headlines ?? [];
    if (headlines.length > 0) {
      qs.push({
        id: "q3",
        text: `What recent developments at ${d.company || "the company"} interest you, and why?`,
        keyPoints: [
          { label: "Name a headline", facts: headlines.slice(0, 3).map((h) => h.title.toLowerCase()) },
        ],
        modelAnswer:
          headlines[0]?.title
            ? `The development I keep coming back to is: ${headlines[0].title}. I would tie it back to the role and to what the company is trying to do next.`
            : "I would name one concrete headline from the news card and connect it to the role.",
        sourceCard: "news",
        sourceLabel: "news · google.com",
      });
    }
  }

  if (qs.length === 0) {
    qs.push({
      id: "q1",
      text: "Tell me about a time you solved a hard problem in a previous role.",
      keyPoints: [{ label: "Describe the situation", facts: [] }],
      modelAnswer: "Use STAR: situation, task, action, result — and end with what you learned.",
      sourceCard: "job",
      sourceLabel: "job · linkedin.com",
    });
  }

  return qs;
}

const ANSWER_SECONDS = 90;

export default function Rehearse({
  dossiers,
  onSessionComplete,
  goResearch,
  onRunningChange,
  headingId,
  mode,
  voiceUnsupported,
}: RehearseProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState<string>(PERSONAS[0].id);
  const [started, setStarted] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(ANSWER_SECONDS);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Session["answers"]>([]);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const startedAt = useRef(0);
  const recordStart = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const levelRaf = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const questionRef = useRef<HTMLParagraphElement | null>(null);

  const mime = useMemo(() => (typeof MediaRecorder === "undefined" ? null : pickMimeType()), []);

  const selected = useMemo(
    () => dossiers.find((d) => d.id === selectedId) ?? null,
    [dossiers, selectedId],
  );

  const questions = useMemo(() => (selected ? buildQuestions(selected) : []), [selected]);

  const begin = () => {
    setStarted(true);
    setQuestionIndex(0);
    setAnswers([]);
    setTranscript("");
    startedAt.current = Date.now();
    onRunningChange(true);
  };

  const current = questions[questionIndex];

  const skippedRecord = (q: InterviewQuestion): Session["answers"][number] => ({
    questionId: q.id,
    questionText: q.text,
    skipped: true,
    transcript: "",
    durationMs: 0,
    content: [],
    delivery: [],
    missed: [],
    modelAnswer: q.modelAnswer,
    sourceLabel: q.sourceLabel,
  });

  const nextQuestion = (skipped: boolean) => {
    const q = current;
    if (!q) return;

    if (questionIndex + 1 >= questions.length) {
      finishSession(skipped, q);
      return;
    }

    if (skipped) {
      setAnswers((prev) => [...prev, skippedRecord(q)]);
    }
    setTranscript("");
    setTranscriptError(null);
    setQuestionIndex((i) => i + 1);
    questionRef.current?.focus();
  };

  const finishSession = (skipped: boolean, q: InterviewQuestion) => {
    const finalAnswers = [...answers];
    if (skipped) {
      finalAnswers.push(skippedRecord(q));
    }
    const answered = finalAnswers.filter((a) => !a.skipped);
    const avg = (list: { score: number }[]) =>
      list.length === 0 ? 0 : Math.round(list.reduce((s, a) => s + a.score, 0) / list.length);
    const session: Session = {
      id: `s-${Date.now()}`,
      dossierId: selected?.id ?? "",
      jobTitle: selected?.jobTitle ?? "",
      company: selected?.company ?? "",
      persona: PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0],
      startedAt: startedAt.current,
      completedAt: Date.now(),
      answers: finalAnswers,
      summary: {
        total: finalAnswers.length,
        answered: answered.length,
        skipped: finalAnswers.length - answered.length,
        totalMs: finalAnswers.reduce((s, a) => s + a.durationMs, 0),
        avgContent: avg(answered.flatMap((a) => a.content)),
        avgDelivery: avg(answered.flatMap((a) => a.delivery)),
      },
    };
    onSessionComplete(session);
    setStarted(false);
    setSelectedId(null);
    setAnswers([]);
    onRunningChange(false);
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopLevelMeter = () => {
    if (levelRaf.current !== null) {
      cancelAnimationFrame(levelRaf.current);
      levelRaf.current = null;
    }
    setLevel(0);
  };

  const stopRecording = async () => {
    const rec = recorderRef.current;
    stopTimer();
    stopLevelMeter();
    setRecording(false);
    if (!rec || rec.state === "inactive") return;
    const stopPromise = new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
    });
    rec.stop();
    await stopPromise;
    const blob = new Blob(chunksRef.current, { type: mime ?? undefined });
    const fileName = `answer-${questionIndex + 1}.${extFor(mime ?? "audio/webm")}`;
    setReplayUrl(URL.createObjectURL(blob));
    setTranscribing(true);
    setTranscriptError(null);
    try {
      const text = await transcribeBlob(blob, fileName);
      setTranscript(text);
      const score = scoreAnswer(text, Date.now() - recordStart.current, current);
      setAnswers((prev) => [
        ...prev,
        {
          questionId: current.id,
          questionText: current.text,
          skipped: false,
          transcript: text,
          blobUrl: URL.createObjectURL(blob),
          fileName,
          durationMs: Date.now() - recordStart.current,
          content: score.content,
          delivery: score.delivery,
          missed: score.missed,
          modelAnswer: current.modelAnswer,
          sourceLabel: current.sourceLabel,
        },
      ]);
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!mime) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i];
        const avg = sum / data.length;
        setLevel(Math.min(1, avg / 90));
        levelRaf.current = requestAnimationFrame(tick);
      };
      tick();

      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      recorderRef.current = rec;
      recordStart.current = Date.now();
      setCountdown(ANSWER_SECONDS);
      setReplayUrl(null);
      setTranscript("");
      setRecording(true);
      rec.start();
      timerRef.current = window.setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            void stopRecording();
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch (err) {
      setTranscriptError(
        err instanceof Error ? `Couldn't open the microphone — ${err.message}` : "Couldn't open the microphone.",
      );
    }
  };

  // Stop any in-flight recording + meter if the user leaves the tab mid-run.
  useEffect(() => {
    return () => {
      if (levelRaf.current !== null) cancelAnimationFrame(levelRaf.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  const toggleRecording = () => {
    if (recording) void stopRecording();
    else void startRecording();
  };

  if (!started) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
            Rehearse
          </h1>
          <p className="mt-2 max-w-[68ch] text-sm text-slate">
            Pick a researched job. One question at a time, answered aloud — then scored against what the research found.
          </p>
        </header>

        {dossiers.length === 0 ? (
          <EmptyState goResearch={goResearch} />
        ) : (
          <>
            <section className="mb-8" aria-label="Choose a job">
              <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Job</h2>
              <div className="mt-2 flex flex-col border-b border-ink/15">
                {dossiers.map((d, i) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    aria-pressed={selectedId === d.id}
                    className={`flex min-h-[44px] items-center justify-between gap-4 border-t border-ink/15 py-3 text-left transition-colors duration-150 ${
                      selectedId === d.id ? "bg-flag/60" : "hover:bg-flag/30"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-heading text-display-sm font-semibold leading-tight text-ink">
                        {d.jobTitle || "Untitled posting"}
                      </span>
                      <span className="mt-0.5 block font-mono text-[0.6875rem] text-slate">
                        {String(i + 1).padStart(2, "0")} · {d.company || "Unknown company"}
                      </span>
                    </span>
                    <ArrowRight aria-hidden="true" className="h-4 w-4 flex-none text-slate" />
                  </button>
                ))}
              </div>
            </section>

            <section className="mb-8" aria-label="Interview settings">
              <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Persona</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {PERSONAS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPersonaId(p.id)}
                    aria-pressed={personaId === p.id}
                    className={`btn btn-sm ${personaId === p.id ? "btn-primary" : "btn-secondary"}`}
                  >
                    {p.label} · {p.voice}
                  </button>
                ))}
              </div>

              <h2 className="mt-8 font-mono text-[0.6875rem] uppercase tracking-wider text-slate">How you'll answer</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMode("voice")}
                  disabled={voiceUnsupported}
                  aria-pressed={mode === "voice"}
                  className={`btn btn-sm ${mode === "voice" && !voiceUnsupported ? "btn-primary" : "btn-secondary"}`}
                >
                  <Mic aria-hidden="true" className="h-4 w-4" />
                  Voice
                </button>
                <button
                  type="button"
                  onClick={() => setMode("text")}
                  aria-pressed={mode === "text"}
                  className={`btn btn-sm ${mode === "text" ? "btn-primary" : "btn-secondary"}`}
                >
                  Text
                </button>
              </div>
              {voiceUnsupported && (
                <p className="mt-2 text-sm text-slate">
                  Voice isn't available in this browser — text mode still works.
                </p>
              )}
            </section>

            <button
              className="btn btn-primary w-full sm:w-auto"
              disabled={!selectedId}
              onClick={begin}
            >
              Begin interview
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
          Rehearse
        </h1>
        <span className="font-mono text-[0.6875rem] text-slate">
          {questionIndex + 1} / {questions.length}
        </span>
      </header>

      <div ref={panelRef}>
        <p
          ref={questionRef}
          tabIndex={-1}
          className="font-heading text-display-md font-semibold leading-snug text-ink focus:outline-none"
        >
          {current?.text}
        </p>
        <p className="mt-2 font-mono text-[0.6875rem] text-slate">
          {selected?.company ? `${selected.company} · ` : ""}
          {current?.sourceLabel}
        </p>
      </div>

      {/* Recording controls sit in the lower third, within thumb reach. */}
      <div className="safe-bottom mt-16 flex flex-col items-center gap-4 sm:mt-24">
        {mode === "voice" ? (
          <>
            <div
              className="relative grid h-32 w-32 place-items-center rounded-full"
              role="timer"
              aria-label={`${recording ? countdown : ANSWER_SECONDS} seconds remaining`}
            >
              <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 128 128" aria-hidden="true">
                <circle cx="64" cy="64" r="58" fill="none" stroke="var(--color-flag)" strokeWidth="4" />
                <circle
                  cx="64"
                  cy="64"
                  r="58"
                  fill="none"
                  stroke={recording ? "var(--color-signal)" : "var(--color-ink)"}
                  strokeWidth="4"
                  strokeLinecap="square"
                  strokeDasharray={2 * Math.PI * 58}
                  strokeDashoffset={2 * Math.PI * 58 * (1 - countdown / ANSWER_SECONDS)}
                  className="transition-[stroke-dashoffset] duration-1000 ease-linear"
                />
              </svg>
              <span
                className={`font-mono text-2xl tabular-nums ${recording ? "text-signal" : "text-ink"}`}
              >
                {recording ? countdown : ANSWER_SECONDS}
              </span>
            </div>

            <button
              type="button"
              onClick={toggleRecording}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording" : "Start recording"}
              className={`grid h-20 w-20 place-items-center rounded-full border transition-transform duration-150 active:scale-95 ${
                recording
                  ? "border-signal bg-signal text-paper"
                  : "border-ink bg-ink text-paper hover:bg-ink/90"
              }`}
            >
              {recording ? (
                <Square aria-hidden="true" className="h-7 w-7 fill-current" />
              ) : (
                <Mic aria-hidden="true" className="h-8 w-8" />
              )}
            </button>
            <p className="font-mono text-[0.6875rem] text-slate">
              {recording ? "recording — tap to stop" : transcribing ? "transcribing…" : "tap to record"}
            </p>
          </>
        ) : (
          <div className="flex w-full max-w-md flex-col gap-3">
            <label htmlFor="answer-text" className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
              your answer
            </label>
            <textarea
              id="answer-text"
              rows={5}
              className="input resize-y"
              placeholder="Type your answer here…"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          {transcriptError ? (
            <p role="alert" className="max-w-xs text-sm text-ink">
              {transcriptError}
            </p>
          ) : null}
          {mode === "voice" && transcribing ? (
            <span role="status" className="font-mono text-[0.6875rem] italic text-slate">
              transcribing…
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => nextQuestion(true)}
            disabled={transcribing || recording}
          >
            <SkipForward aria-hidden="true" className="h-4 w-4" />
            Skip
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (mode === "text") {
                if (transcript.trim()) {
                  const score = scoreAnswer(transcript, 0, current);
                  setAnswers((prev) => [
                    ...prev,
                    {
                      questionId: current.id,
                      questionText: current.text,
                      skipped: false,
                      transcript: transcript.trim(),
                      durationMs: 0,
                      content: score.content,
                      delivery: score.delivery,
                      missed: score.missed,
                      modelAnswer: current.modelAnswer,
                      sourceLabel: current.sourceLabel,
                    },
                  ]);
                  if (questionIndex + 1 >= questions.length) {
                    finishSession(false, current);
                  } else {
                    setTranscript("");
                    setQuestionIndex((i) => i + 1);
                  }
                }
              } else if (!recording && transcript) {
                if (questionIndex + 1 >= questions.length) {
                  finishSession(false, current);
                } else {
                  setTranscript("");
                  setQuestionIndex((i) => i + 1);
                }
              }
            }}
            disabled={mode === "text" ? !transcript.trim() : transcribing || recording}
          >
            {questionIndex + 1 >= questions.length ? "Finish" : "Next question"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ goResearch }: { goResearch: () => void }) {
  return (
    <div className="border border-dashed border-ink/25 px-6 py-12 text-center">
      <p className="font-heading text-display-sm font-semibold text-slate">Nothing to rehearse yet</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate">
        Research a job first, then come back here and practise it aloud.
      </p>
      <button type="button" className="btn btn-primary mt-6" onClick={goResearch}>
        Go to Research
      </button>
    </div>
  );
}
