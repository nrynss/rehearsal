import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Mic, SkipForward, Square, Volume2 } from "lucide-react";
import { scoreAnswer } from "../lib/score";
import { generateAiQuestions, scoreWithAi } from "../lib/ai";
import { pickMimeType, extFor, transcribeBlob, speakQuestion, stopQuestionAudio } from "../lib/audio";
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
  /** Voice/Text mode — chosen on the Research tab (or here on the setup screen). */
  mode: AnswerMode;
  /** Change the mode from the setup screen. */
  onModeChange: (m: AnswerMode) => void;
  voiceUnsupported: boolean;
  /** The saved resume, if any — lets questions target the gaps in it. */
  resumeText?: string | null;
}

/** Split the JD text into candidate grounding lines (responsibilities,
 *  qualifications, soft skills) for deterministic questions and key points. */
function jdLines(summary: string | undefined): string[] {
  if (!summary) return [];
  return summary
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 24 && l.length < 240 && !/^(business summary|position responsibilities|qualifications|show more|show less)$/i.test(l));
}

/** Deterministic, dossier-grounded questions — no network call, no credit.
 *  Each question cites the card it came from. When AI is configured these are
 *  upgraded by generateAiQuestions; this is the always-available fallback. */
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

    // Mine the actual JD for responsibilities/qualifications and turn each
    // into a targeted question — the posting's own words, not a template.
    const lines = jdLines(job.summary);
    const targeted = lines
      .map((line, i) => {
        const words = line.split(/\s+/).slice(0, 10).join(" ");
        const facts = line
          .split(/[\s,;:]+/)
          .filter((w) => w.length > 3 && !/^(the|and|with|that|this|from|your|will|have|into|across|using|their|they)$/i.test(w))
          .slice(0, 4)
          .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""));
        return {
          id: `qj${i + 2}`,
          text: `The posting calls out "${words}…" — how does your experience line up with that?`,
          keyPoints: [{ label: "Reference the JD line", facts: facts.filter((f) => f.length > 2) }],
          modelAnswer: `Anchor on the posting's exact ask: ${line.slice(0, 140)}. Give one concrete example from your past work that maps onto it, and say the outcome.`,
          sourceCard: "job" as const,
          sourceLabel: "job · linkedin.com",
        };
      })
      .slice(0, 3);
    qs.push(...targeted);
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

/** Live input level meter — the only signal that audio is reaching the
 *  recorder. Ink bar on a Flag track, moving with input level. */
function LevelMeter({ stream }: { stream: MediaStream | null }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    const start = async () => {
      try {
        ctx = new AudioContext();
        await ctx.resume();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          const next = Math.min(1, rms * 3.5);
          setLevel((prev) => (Math.abs(prev - next) > 0.01 ? next : prev));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // The meter is a nicety — recording still works without it.
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      void ctx?.close();
    };
  }, [stream]);

  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      className="h-2 w-56 max-w-full bg-flag"
    >
      <span
        className="block h-full bg-ink transition-[width] duration-75 ease-out"
        style={{ width: `${level * 100}%` }}
      />
    </div>
  );
}

export default function Rehearse({
  dossiers,
  onSessionComplete,
  goResearch,
  onRunningChange,
  headingId,
  mode,
  onModeChange,
  voiceUnsupported,
  resumeText,
}: RehearseProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(ANSWER_SECONDS);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [, setAnswers] = useState<Session["answers"]>([]);
  const answersRef = useRef<Session["answers"]>([]);
  const startedAt = useRef(0);
  const recordStart = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const questionRef = useRef<HTMLParagraphElement | null>(null);

  const mime = useMemo(() => (typeof MediaRecorder === "undefined" ? null : pickMimeType()), []);

  const selected = useMemo(
    () => dossiers.find((d) => d.id === selectedId) ?? null,
    [dossiers, selectedId],
  );

  // Deterministic questions render immediately; AI questions replace them
  // when they land (or leave the deterministic set if AI is unavailable).
  const questionsLoadingRef = useRef(false);

  const loadQuestions = (d: Dossier) => {
    setQuestions(buildQuestions(d));
    if (questionsLoadingRef.current) return;
    questionsLoadingRef.current = true;
    setQuestionsLoading(true);
    void (async () => {
      try {
        const ai = await generateAiQuestions(d, resumeText);
        if (ai && ai.length > 0) setQuestions(ai);
      } finally {
        questionsLoadingRef.current = false;
        setQuestionsLoading(false);
      }
    })();
  };

  useEffect(() => {
    if (selected) loadQuestions(selected);
    else setQuestions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /** The panel rotates one persona per question — a different voice each time. */
  const persona = PERSONAS[questionIndex % PERSONAS.length];

  const current = questions[questionIndex];

  const begin = () => {
    setStarted(true);
    setQuestionIndex(0);
    setAnswers([]);
    answersRef.current = [];
    setTranscript("");
    setErrorMsg(null);
    startedAt.current = Date.now();
    onRunningChange(true);
  };

  const pushAnswer = (rec: Session["answers"][number]) => {
    answersRef.current = [...answersRef.current, rec];
    setAnswers(answersRef.current);
  };

  const skippedRecord = (q: InterviewQuestion): Session["answers"][number] => ({
    questionId: q.id,
    questionText: q.text,
    sourceCard: q.sourceCard,
    skipped: true,
    transcript: "",
    durationMs: 0,
    content: [],
    delivery: [],
    missed: [],
    modelAnswer: q.modelAnswer,
    sourceLabel: q.sourceLabel,
  });

  const focusQuestion = () => {
    requestAnimationFrame(() => questionRef.current?.focus());
  };

  const finishSession = () => {
    const finalAnswers = answersRef.current;
    const answered = finalAnswers.filter((a) => !a.skipped);
    const avg = (list: { score: number }[]) =>
      list.length === 0 ? 0 : Math.round(list.reduce((s, a) => s + a.score, 0) / list.length);
    const session: Session = {
      id: `s-${Date.now()}`,
      dossierId: selected?.id ?? "",
      jobTitle: selected?.jobTitle ?? "",
      company: selected?.company ?? "",
      persona,
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
    answersRef.current = [];
    onRunningChange(false);
  };

  const advance = () => {
    if (!current) return;
    setTranscript("");
    setErrorMsg(null);
    if (questionIndex + 1 >= questions.length) {
      finishSession();
    } else {
      setQuestionIndex((i) => i + 1);
    }
    focusQuestion();
  };

  const skipQuestion = () => {
    if (!current) return;
    pushAnswer(skippedRecord(current));
    advance();
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopRecording = async () => {
    const rec = recorderRef.current;
    stopTimer();
    setRecording(false);
    streamRef.current = null;
    if (!rec || rec.state === "inactive") return;
    const stopPromise = new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
    });
    rec.stop();
    await stopPromise;
    const blob = new Blob(chunksRef.current, { type: mime ?? undefined });
    const fileName = `answer-${questionIndex + 1}.${extFor(mime ?? "audio/webm")}`;
    setTranscribing(true);
    setErrorMsg(null);
    try {
      const text = await transcribeBlob(blob, fileName);
      setTranscript(text);
      const durationMs = Date.now() - recordStart.current;
      // AI rubric scoring (Featherless) when available; deterministic rubric otherwise.
      const aiScore = await scoreWithAi(current, text, durationMs);
      const score = aiScore ?? scoreAnswer(text, durationMs, current);
      pushAnswer({
        questionId: current.id,
        questionText: current.text,
        sourceCard: current.sourceCard,
        skipped: false,
        transcript: text,
        blobUrl: URL.createObjectURL(blob),
        fileName,
        durationMs,
        content: score.content,
        delivery: score.delivery,
        missed: score.missed,
        modelAnswer: current.modelAnswer,
        sourceLabel: current.sourceLabel,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!mime) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
      };
      recorderRef.current = rec;
      streamRef.current = stream;
      recordStart.current = Date.now();
      setCountdown(ANSWER_SECONDS);
      setTranscript("");
      setErrorMsg(null);
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
      setErrorMsg(
        err instanceof Error ? `Couldn't open the microphone — ${err.message}` : "Couldn't open the microphone.",
      );
    }
  };

  const toggleRecording = () => {
    if (recording) void stopRecording();
    else void startRecording();
  };

  const handleReplay = async () => {
    if (!current || replayBusy) return;
    setReplayBusy(true);
    setErrorMsg(null);
    try {
      await speakQuestion(current.speechText || current.text, persona.voice);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReplayBusy(false);
    }
  };

  const commitText = async () => {
    if (!current) return;
    const text = transcript.trim();
    if (!text) return;
    // AI rubric scoring (Featherless) when available; deterministic rubric otherwise.
    const aiScore = await scoreWithAi(current, text, 0);
    const score = aiScore ?? scoreAnswer(text, 0, current);
    pushAnswer({
      questionId: current.id,
      questionText: current.text,
      sourceCard: current.sourceCard,
      skipped: false,
      transcript: text,
      durationMs: 0,
      content: score.content,
      delivery: score.delivery,
      missed: score.missed,
      modelAnswer: current.modelAnswer,
      sourceLabel: current.sourceLabel,
    });
    advance();
  };

  // Stop any in-flight recording + question audio if the user leaves mid-run.
  useEffect(() => {
    return () => {
      stopQuestionAudio();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  // Land focus on the question when an interview begins.
  useEffect(() => {
    if (started) focusQuestion();
  }, [started]);

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
              <div className="mt-2 flex flex-col">
                {dossiers.map((d, i) => (
                  <div key={d.id} className="entry-grid border-b border-ink/15">
                    <div className="entry-margin" aria-hidden="true">
                      <span>{String(i + 1).padStart(2, "0")}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedId(d.id)}
                      aria-pressed={selectedId === d.id}
                      className={`flex min-h-[44px] items-center justify-between gap-4 py-3 text-left transition-colors duration-150 ${
                        selectedId === d.id ? "bg-flag/60" : "hover:bg-flag/30"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block font-heading text-display-sm font-semibold leading-tight text-ink">
                          {d.jobTitle || "Untitled posting"}
                        </span>
                        <span className="mt-0.5 block font-mono text-[0.6875rem] text-slate">{d.company || "Unknown company"}</span>
                      </span>
                      <ArrowRight aria-hidden="true" className="h-4 w-4 flex-none text-slate" />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="mb-8" aria-label="How you'll answer">
              <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">How you'll answer</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onModeChange("voice")}
                  disabled={voiceUnsupported}
                  aria-pressed={mode === "voice"}
                  className={`btn btn-sm ${mode === "voice" && !voiceUnsupported ? "btn-primary" : "btn-secondary"}`}
                >
                  <Mic aria-hidden="true" className="h-4 w-4" />
                  Voice
                </button>
                <button
                  type="button"
                  onClick={() => onModeChange("text")}
                  aria-pressed={mode === "text"}
                  className={`btn btn-sm ${mode === "text" ? "btn-primary" : "btn-secondary"}`}
                >
                  Text
                </button>
              </div>
              {voiceUnsupported && (
                <p className="mt-2 text-sm text-slate">Voice isn't available in this browser — text mode still works.</p>
              )}
            </section>

            <button className="btn btn-primary w-full sm:w-auto" disabled={!selectedId || questionsLoading} onClick={begin}>
              {questionsLoading ? "Preparing questions…" : "Begin interview"}
            </button>
            {questionsLoading ? (
              <p className="mt-2 font-mono text-[0.6875rem] italic text-slate">
                ai questions are being prepared — the dossier questions are ready the moment you begin
              </p>
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    /* Running: question scrolls independently above; the controls hold still
       in the lower third, within thumb reach on mobile. */
    <div className="mx-auto flex h-[calc(100dvh-10.5rem)] min-h-[26rem] max-w-3xl flex-col gap-6 overflow-hidden px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex shrink-0 items-baseline justify-between gap-4">
        <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
          Rehearse
        </h1>
        <span className="font-mono text-[0.6875rem] text-slate">
          {questionIndex + 1} / {questions.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
          {persona.label} · {persona.voice}
        </p>
        <p
          ref={questionRef}
          tabIndex={-1}
          className="mt-2 font-heading text-display-md font-semibold leading-snug text-ink focus:outline-none"
        >
          {current?.text}
        </p>
        <p className="mt-2 font-mono text-[0.6875rem] text-slate">
          {selected?.company ? `${selected.company} · ` : ""}
          {current?.sourceLabel}
        </p>
      </div>

      <div className="shrink-0">
        {mode === "voice" ? (
          <div className="flex flex-col items-center gap-4">
            {/* 90-second countdown ring — Flag track, Ink progress, mono numeral. */}
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
                  stroke="var(--color-ink)"
                  strokeWidth="4"
                  strokeLinecap="square"
                  strokeDasharray={2 * Math.PI * 58}
                  strokeDashoffset={2 * Math.PI * 58 * (1 - countdown / ANSWER_SECONDS)}
                  className="transition-[stroke-dashoffset] duration-1000 ease-linear"
                />
              </svg>
              <span className="font-mono text-2xl tabular-nums text-ink">{recording ? countdown : ANSWER_SECONDS}</span>
            </div>

            {/* Large record button — the biggest touch target on screen, ≥64px.
                Signal only while the mic is live. */}
            <button
              type="button"
              onClick={toggleRecording}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording" : "Start recording"}
              disabled={transcribing || (!recording && transcript !== "")}
              className={`grid h-20 w-20 place-items-center rounded-full border transition-transform duration-150 active:scale-95 ${
                recording
                  ? "border-signal bg-signal text-paper"
                  : "border-ink bg-ink text-paper hover:bg-ink/90"
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {recording ? (
                <Square aria-hidden="true" className="h-7 w-7 fill-current" />
              ) : (
                <Mic aria-hidden="true" className="h-8 w-8" />
              )}
            </button>

            <LevelMeter stream={recording ? streamRef.current : null} />

            <p role="status" className="font-mono text-[0.6875rem] text-slate">
              {recording
                ? "recording — tap to stop"
                : transcribing
                  ? "transcribing…"
                  : transcript
                    ? "answer recorded — next question"
                    : "tap to record"}
            </p>

            {errorMsg ? (
              <p role="alert" className="max-w-xs text-center text-sm text-ink">
                {errorMsg}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleReplay}
                disabled={recording || transcribing || replayBusy}
              >
                <Volume2 aria-hidden="true" className="h-4 w-4" />
                Replay question
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={skipQuestion}
                disabled={recording || transcribing || transcript !== ""}
              >
                <SkipForward aria-hidden="true" className="h-4 w-4" />
                Skip
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={advance}
                disabled={recording || transcribing || !transcript}
              >
                {questionIndex + 1 >= questions.length ? "Finish" : "Next question"}
              </button>
            </div>
          </div>
        ) : (
          /* Text mode: every voice control is absent — no ring, no meter,
             no record button, no replay. A complete surface, not a degraded one. */
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
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
            {errorMsg ? (
              <p role="alert" className="text-sm text-ink">
                {errorMsg}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-sm" onClick={skipQuestion}>
                <SkipForward aria-hidden="true" className="h-4 w-4" />
                Skip
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={commitText}
                disabled={!transcript.trim()}
              >
                {questionIndex + 1 >= questions.length ? "Finish" : "Next question"}
              </button>
            </div>
          </div>
        )}
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
