import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Keyboard, Mic, RefreshCw, SkipForward, Square, Volume2 } from "lucide-react";
import { avgScore, missedTotal, scoreAnswer } from "../lib/score";
import type { AnswerScore } from "../lib/score";
import { generateAiQuestions, generateOpening, scoreWithAi } from "../lib/ai";
import { pickMimeType, extFor, transcribeBlob, speakQuestion, stopQuestionAudio } from "../lib/audio";
import type {
  AnswerMode,
  Dossier,
  Interviewer,
  InterviewQuestion,
  InterviewerGender,
  Session,
} from "../lib/types";
import { FEMALE_INTERVIEWERS, MALE_INTERVIEWERS } from "../lib/types";

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
  /** Jump to the Relive tab (the report) — used after the closing beat. */
  goRelive?: () => void;
}

/** Number of questions in an interview. The ai-questions edge function is the
 *  single source of truth for this (its prompt asks for q1..q8 and it caps at
 *  8); this constant drives the client's progress indicator, the closing beat
 *  and the setup copy. Do not change it in isolation. */
export const INTERVIEW_QUESTION_COUNT = 8;

/** The 90-second answer ceiling — a cost cap, not a UX choice. Keep it. */
const ANSWER_SECONDS = 90;

/** The last fifteen seconds: the only moment the ring signals the limit, by
 *  weight alone. No numeral colour, no pulsing, no sound. */
const WARN_AT_SECONDS = ANSWER_SECONDS - 15;

/** Split the JD text into candidate grounding lines (responsibilities,
 *  qualifications, soft skills) for deterministic questions and key points. */
function jdLines(summary: string | undefined): string[] {
  if (!summary) return [];
  return summary
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 24 && l.length < 240 && !/^(business summary|position responsibilities|qualifications|show more|show less)$/i.test(l));
}

/** Strip the posting's own parenthetical/bracket markers — "(new)", "(jobs)",
 *  "[edit]" — from ANY text quoted out of the JD, and collapse the whitespace
 *  they leave behind. The raw scrape annotates lines with UI markers; those
 *  must never leak into question text or model answers. */
function sanitizeJdText(text: string): string {
  return text
    .replace(/\([^()]*\)/g, " ")
    .replace(/\[[^[\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic, dossier-grounded questions — no network call, no credit.
 *  Question 1 is the background opener (grounded in the role, not the news —
 *  grading a "walk me through your background" answer against a scraped press
 *  release is how you get a relevance score of 1 on a good answer). Questions
 *  2–8 are grounded in the research, exactly as before. When AI is configured
 *  these are upgraded by generateAiQuestions; this is the always-available
 *  fallback. */
function buildQuestions(d: Dossier): InterviewQuestion[] {
  const job = d.cards.find((c) => c.step === "job" && c.payload?.status === "ok")?.payload;
  const company = d.cards.find((c) => c.step === "company" && c.payload?.status === "ok")?.payload;
  const news = d.cards.find((c) => c.step === "news" && c.payload?.status === "ok")?.payload;
  const qs: InterviewQuestion[] = [];

  // q1 — the background opener. Its key points come from the resume and the
  // role's seniority/function, never from news/company research.
  const seniority = job?.status === "ok" && job.seniorityLevel ? job.seniorityLevel.toLowerCase() : "";
  const fn = job?.status === "ok" && job.jobFunction ? job.jobFunction.toLowerCase() : "";
  const roleText = [
    job?.status === "ok" && job.title ? job.title : "",
    seniority,
    fn,
    job?.status === "ok" && job.industries ? job.industries.toLowerCase() : "",
  ]
    .filter(Boolean)
    .join(" ");
  const roleFacts = roleText
    .split(/[\s,;:]+/)
    .filter((w) => w.length > 3 && !/^(the|and|with|that|this|from|your|will|have|into|across|using|their|they)$/i.test(w))
    .slice(0, 4)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  qs.push({
    id: "q1",
    text: `Walk me through your background — the roles, the technologies and the results that got you here.`,
    keyPoints: [
      { label: "Cover the roles and timeline", facts: [] },
      { label: "Reference the role's seniority/function", facts: roleFacts.filter((f) => f.length > 2) },
    ],
    modelAnswer:
      "Give a chronological arc: your current role, the two or three roles before it, and for each — what you owned, what you shipped, and the result. Then connect it to the seniority and function this posting asks for.",
    sourceCard: "job",
    sourceLabel: "job · linkedin.com",
  });

  if (job?.status === "ok") {
    // Mine the actual JD for responsibilities/qualifications and turn each
    // into a targeted question — the posting's own words, not a template.
    const lines = jdLines(job.summary);
    const targeted = lines
      .map((line, i) => {
        // Quote the SANITISED line — the posting's own "(new)"/"[edit]"
        // markers must never leak into question text or model answers.
        const clean = sanitizeJdText(line);
        const words = clean.split(/\s+/).filter(Boolean).slice(0, 10).join(" ");
        const facts = line
          .split(/[\s,;:]+/)
          .filter((w) => w.length > 3 && !/^(the|and|with|that|this|from|your|will|have|into|across|using|their|they)$/i.test(w))
          .slice(0, 4)
          .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""));
        return {
          id: `qj${i + 2}`,
          text: `The posting calls out "${words}…" — how does your experience line up with that?`,
          keyPoints: [{ label: "Reference the JD line", facts: facts.filter((f) => f.length > 2) }],
          modelAnswer: `Anchor on the posting's exact ask: ${clean.slice(0, 140)}. Give one concrete example from your past work that maps onto it, and say the outcome.`,
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

  // Deterministic questions must always produce a full 8 — the fallback chain
  // pads the JD/company/news cards up to the count with role-grounded ones.
  while (qs.length < INTERVIEW_QUESTION_COUNT) {
    const n = qs.length + 1;
    qs.push({
      id: `q${n}`,
      text:
        n === 2
          ? "Tell me about a time you solved a hard problem in a previous role."
          : `What would you want to understand about this ${job?.status === "ok" && job.title ? job.title : "role"} before deciding it was right for you?`,
      keyPoints:
        n === 2
          ? [{ label: "Describe the situation", facts: [] }]
          : [{ label: "Show the research", facts: [] }],
      modelAnswer:
        n === 2
          ? "Use STAR: situation, task, action, result — and end with what you learned."
          : "Ask about the team, the remit, and how success is measured — the kind of questions a serious candidate asks.",
      sourceCard: "job",
      sourceLabel: "job · linkedin.com",
    });
  }

  return qs;
}

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

/** One shared AudioContext for all question playback — browsers cap the number
 *  of live contexts per page, so creating one per question would eventually
 *  fail mid-interview. Created lazily, reused across questions, never closed
 *  while the page lives. */
let sharedAudioCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new Ctor();
  return sharedAudioCtx;
}

/**
 * Interviewer speaking indicator — the playback twin of LevelMeter, so both
 * directions of the conversation read as the same kind of thing. Ink bar on a
 * Flag track, fed from the TTS element via createMediaElementSource. The
 * footgun: createMediaElementSource reroutes the element's output into the
 * context, so the source MUST also connect to ctx.destination or the question
 * plays silently. A nicety like LevelMeter — if the analyser fails to attach,
 * the audio still plays. Under prefers-reduced-motion the moving bar is
 * replaced by a static Speaking label.
 */
function SpeakingIndicator({
  audio,
  name,
  role,
  reducedMotion,
}: {
  audio: HTMLAudioElement | null;
  name: string;
  role: string;
  reducedMotion: boolean;
}) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!audio || reducedMotion) {
      setLevel(0);
      return;
    }
    let raf = 0;
    let cancelled = false;
    let src: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    const start = async () => {
      try {
        const ctx = getSharedAudioContext();
        if (!ctx) return;
        await ctx.resume();
        const srcNode = ctx.createMediaElementSource(audio);
        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 512;
        srcNode.connect(analyserNode);
        analyserNode.connect(ctx.destination);
        src = srcNode;
        analyser = analyserNode;
        const data = new Uint8Array(analyserNode.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyserNode.getByteTimeDomainData(data);
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
        // The indicator is a nicety — the audio still plays without it.
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      src?.disconnect();
      analyser?.disconnect();
    };
  }, [audio, reducedMotion]);

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-[0.6875rem] text-ink">
        {name} · {role}
      </span>
      {reducedMotion ? (
        <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Speaking</span>
      ) : (
        <div
          role="meter"
          aria-label="Interviewer speaking"
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
      )}
    </div>
  );
}

/** Format the elapsed time as M:SS (counts up, never down). */
function fmtElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Draw one interviewer for the whole session, honouring the gender control.
 *  Random draws from whichever pool the control selected. */
function drawInterviewer(gender: InterviewerGender): Interviewer {
  const pool = gender === "male" ? MALE_INTERVIEWERS : gender === "female" ? FEMALE_INTERVIEWERS : Math.random() < 0.5 ? MALE_INTERVIEWERS : FEMALE_INTERVIEWERS;
  return pool[Math.floor(Math.random() * pool.length)];
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
  goRelive,
}: RehearseProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  /** Elapsed seconds for the current answer — counts UP from 0:00. The 90s
   *  cap is a cost ceiling, not a countdown. */
  const [elapsed, setElapsed] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  /** A transcription failed and the three recovery actions are offered:
   *  retry / type-instead / record-again. Skip stays available throughout. */
  const [transcribeFailed, setTranscribeFailed] = useState(false);
  /** "Type instead" was chosen — the text box is revealed on the voice
   *  surface, and commitText routes it through the same path as text mode. */
  const [typeInstead, setTypeInstead] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [played, setPlayed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [questionAudio, setQuestionAudio] = useState<HTMLAudioElement | null>(null);
  const [micError, setMicError] = useState<"denied" | "notfound" | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
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
  /** The raw recording blob of the current answer, kept across a failed
   *  transcription so the candidate can retry the upload without re-recording.
   *  Cleared once the answer is committed (pushAnswer) or re-recorded. */
  const pendingBlobRef = useRef<Blob | null>(null);
  const questionRef = useRef<HTMLParagraphElement | null>(null);
  /** Bumped on every advance/begin. Guards a slow TTS fetch that resolves
   *  after the user has already moved on — its audio must not start, and its
   *  state must not land, on the wrong question. */
  const playTokenRef = useRef(0);
  /** Focus target for the opening's Get started control — focused when the
   *  interview begins so the first keyboard action is the transition. */
  const getStartedRef = useRef<HTMLButtonElement | null>(null);
  /** Always the LATEST startFirstQuestion — the opening audio's `ended`
   *  listener is attached once in begin() and must never call a stale closure. */
  const startFirstQuestionRef = useRef<() => void>(() => {});

  /** The question set the CURRENT interview started with — frozen at begin()
   *  and rendered for the whole run. A late-arriving AI set must never replace
   *  questions under a live session (that collapse is what made `current`
   *  undefined mid-interview). */
  const activeQuestionsRef = useRef<InterviewQuestion[]>([]);

  /** Synchronous mirror of `started` — loadQuestions() checks it so a late AI
   *  resolution can never touch state while an interview is running. Set in
   *  begin(), cleared in finishSession(). */
  const startedRef = useRef(false);

  /** One interviewer, drawn when the interview begins and held for the whole
   *  session. The voice always matches the pool's gender. */
  const interviewerRef = useRef<Interviewer | null>(null);

  /** The interviewer's greeting/valediction — spoken and displayed, never
   *  recorded, transcribed or scored. */
  const [openingText, setOpeningText] = useState<string | null>(null);
  const [closingText, setClosingText] = useState<string | null>(null);
  /** True once the opening beat is done and question 1 is on screen — set in
   *  startFirstQuestion, reset at every begin(). The fail-loud state (a
   *  missing `current` mid-run) is meaningful only past this point: during
   *  the opening there is no question to show yet, and that is expected,
   *  not a bug. */
  const [pastOpening, setPastOpening] = useState(false);
  const closingRef = useRef<string | null>(null);
  /** True once the closing beat is playing — the report is ready behind it. */
  const [closingReady, setClosingReady] = useState(false);

  /** The last 15 seconds are signalled by the ring's weight alone. */
  const inWarning = recording && elapsed >= WARN_AT_SECONDS;

  const mime = useMemo(() => (typeof MediaRecorder === "undefined" ? null : pickMimeType()), []);

  const selected = useMemo(
    () => dossiers.find((d) => d.id === selectedId) ?? null,
    [dossiers, selectedId],
  );

  // Deterministic questions render immediately; AI questions replace them
  // when they land (or leave the deterministic set if AI is unavailable).
  const questionsLoadingRef = useRef(false);

  const loadQuestions = (d: Dossier) => {
    // An interview is running — the set it started with is the set it
    // finishes with. Never replace questions under a live session.
    if (startedRef.current) return;
    if (questionsLoadingRef.current) return;
    questionsLoadingRef.current = true;
    setQuestionsLoading(true);
    void (async () => {
      try {
        const ai = await generateAiQuestions(d, resumeText);
        // A late-arriving AI set must never land on a session that began
        // while it was in flight.
        if (startedRef.current) return;
        if (ai && ai.length > 0) setQuestions(ai);
        // Genuine AI failure: the deterministic set is the fallback, never a
        // placeholder shown as "ready" while AI is still in flight.
        else setQuestions(buildQuestions(d));
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

  /** One interviewer, held for the whole session. Draw once per interview. */
  const persona = interviewerRef.current;

  /** The label the candidate sees — the role at the company, never a generic
   *  tag. */
  const personaLabel = selected ? `Hiring Manager · ${selected.company}` : "Hiring Manager";

  /** The running question set — before an interview it is the prepared (AI or
   *  deterministic) set; once started it is the snapshot taken at begin(),
   *  held for the whole run. */
  const runningQuestions = started ? activeQuestionsRef.current : questions;
  const current = runningQuestions[questionIndex];

  /** Speak only in Voice mode. Text mode is a complete surface, not a degraded
   *  one — no ring, no meter, no record button, no replay, and no audio at
   *  all: no opening, no closing, no per-question playback. */
  const speakIfVoice = (text: string, voice: string) => {
    if (mode === "voice") void speakQuestion(text, voice);
  };

  /** The opening plays first — Voice mode auto-speaks it and waits for
   *  `ended`; Text mode shows it and waits for the candidate's Get started.
   *  Either way question 1 appears ONLY once the opening is done. */
  const openingEnded = () => {
    if (playTokenRef.current !== 1) return;
    setSpeaking(false);
    setOpeningText(null);
    startFirstQuestionRef.current();
  };

  /** The transition out of the opening — question 1 appears and (Voice mode)
   *  auto-speaks. The audio that was playing is stopped first, always. */
  const startFirstQuestion = () => {
    stopQuestionAudio();
    playTokenRef.current += 1;
    setSpeaking(false);
    setQuestionAudio(null);
    setOpeningText(null);
    setPastOpening(true);
    setPlayed(true);
    const q = activeQuestionsRef.current[0];
    if (mode === "voice" && q) {
      void playQuestionAuto(q);
    }
    focusQuestion();
  };
  // The opening's `ended` listener is attached once in begin() and must
  // always call the LATEST transition, never a stale render's closure.
  startFirstQuestionRef.current = startFirstQuestion;

  /** Auto-speak a question after the opening — same one-at-a-time rule as
   *  replay, same token guard. */
  const playQuestionAuto = async (q: InterviewQuestion) => {
    const token = playTokenRef.current;
    try {
      const el = await speakQuestion(q.speechText || q.text, persona?.voice || "sarah");
      if (token !== playTokenRef.current) {
        stopQuestionAudio();
        return;
      }
      if (el) {
        setQuestionAudio(el);
        setSpeaking(true);
        el.addEventListener("ended", () => setSpeaking(false), { once: true });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const begin = async () => {
    stopQuestionAudio();
    playTokenRef.current += 1;
    // Draw the interviewer up front — the voice and the name are fixed for
    // the whole session.
    interviewerRef.current = drawInterviewer(genderRef.current);
    const interviewer = interviewerRef.current;
    // Freeze the question set for the whole run BEFORE anything can re-run
    // loadQuestions or re-render an effect. `startedRef` is synchronous —
    // a late AI resolution or a dossier identity change can never swap the
    // list under a live session.
    activeQuestionsRef.current = questions;
    startedRef.current = true;
    setStarted(true);
    setQuestionIndex(0);
    setAnswers([]);
    answersRef.current = [];
    setTranscript("");
    setErrorMsg(null);
    setTranscribeFailed(false);
    setTypeInstead(false);
    setPlayed(false);
    setSpeaking(false);
    setQuestionAudio(null);
    setMicError(null);
    setElapsed(0);
    pendingBlobRef.current = null;
    closingRef.current = null;
    setClosingText(null);
    setPastOpening(false);
    setClosingReady(false);
    startedAt.current = Date.now();
    onRunningChange(true);
    if (!selected) return;

    // The opening greeting — displayed always, spoken only in Voice mode,
    // never recorded/scored. The SCRIPTED opening shows immediately: while
    // the AI opening is in flight, no question may render (or speak) — the
    // scripted line is instant and always available. The AI line upgrades it
    // when it lands, only if the candidate hasn't already started.
    const scripted = scriptedOpening(interviewer?.name ?? "the hiring manager", selected);
    setOpeningText(scripted);

    const resume = resumeText?.trim() || null;
    let displayText = scripted;
    let speechText = scripted;
    if (resume && interviewer) {
      const opening = await generateOpening(selected, resume, interviewer.name);
      // A slow AI opening that lands after the candidate already got started
      // must never overwrite question 1 (the token has moved past 1).
      if (playTokenRef.current === 1 && opening) {
        displayText = opening.text;
        speechText = opening.speechText || opening.text;
        setOpeningText(displayText);
      }
    }
    if (playTokenRef.current === 1 && mode === "voice" && interviewer) {
      const el = await speakQuestion(speechText, interviewer.voice);
      if (el && playTokenRef.current === 1) {
        setSpeaking(true);
        el.addEventListener("ended", openingEnded, { once: true });
      }
    }
    requestAnimationFrame(() => getStartedRef.current?.focus());
  };

  /** The scripted opening — used when no resume is saved, or the AI call
   *  fails or returns nothing. A missing pleasantry is never an error state. */
  function scriptedOpening(name: string, d: Dossier): string {
    return `Hello, I'm ${name}, the hiring manager for the ${d.jobTitle || "role"} position at ${d.company || "this company"}. Thanks for making the time. We'll spend up to twelve minutes together — up to eight questions, roughly ninety seconds each. Whenever you're ready, we'll get started.`;
  }

  /** Stage 3 — commit a finished answer. Runs whenever there is a transcript,
   *  with whatever score is available: a scoring failure must never cost the
   *  answer the candidate actually gave. */
  const pushAnswer = (rec: Session["answers"][number]) => {
    answersRef.current = [...answersRef.current, rec];
    setAnswers(answersRef.current);
  };

  /** Stage 2 — score a transcript. AI first, deterministic fallback; a
   *  throwing scorer (malformed payload, network edge, anything) falls back to
   *  the rubric exactly as a null return already does. */
  const scoreFor = async (q: InterviewQuestion, text: string, durationMs: number): Promise<AnswerScore> => {
    try {
      const ai = await scoreWithAi(q, text, durationMs);
      if (ai) return ai;
    } catch {
      // A scoring failure degrades to the deterministic rubric — never the
      // death of an answer.
    }
    return scoreAnswer(text, durationMs, q);
  };

  /** The shared stop path — reached from the Stop button AND the 90-second
   *  auto-stop. Stages are separated so one failure cannot destroy the others:
   *  transcription failure offers retry / type-instead / record-again, scoring
   *  failure falls back to the rubric, and the answer is pushed whenever a
   *  transcript exists, with whatever score is available. The question is
   *  captured NOW — a skip during transcription must not push the answer onto
   *  a different question. */
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
    pendingBlobRef.current = blob;
    const q = runningQuestions[questionIndex];
    const qIndex = questionIndex;
    if (!q) {
      setErrorMsg("The question disappeared — skip to continue, or end the session.");
      return;
    }
    const durationMs = Date.now() - recordStart.current;
    setTranscribing(true);
    setErrorMsg(null);

    // Stage 1 — transcription. Failure offers the three recovery actions.
    let text = "";
    try {
      text = (await transcribeBlob(blob, `answer-${qIndex + 1}.${extFor(mime ?? "audio/webm")}`)).trim();
    } catch (err) {
      setTranscribing(false);
      // The candidate moved on (skip/next) while the transcription was in
      // flight — the failure belongs to a question they've left. Never
      // surface it on the question they moved to.
      if (pendingBlobRef.current !== blob) return;
      // Keep the blob — Retry transcription re-uploads it. It is cleared
      // only when the answer is committed, re-recorded, or skipped past.
      setTranscribeFailed(true);
      const isEmpty = err instanceof Error && "code" in err && (err as { code?: string }).code === "EMPTY_RECORDING";
      setErrorMsg(
        isEmpty
          ? "The recording captured no audio. Retry the transcription, type your answer instead, or record again."
          : `${err instanceof Error ? err.message : String(err)} — retry the transcription, type your answer instead, or record again.`,
      );
      return;
    }
    // Stage 2 — scoring. A throwing scorer falls back to the rubric; the
    // answer below is committed with whatever score is available.
    const score = await scoreFor(q, text, durationMs);
    // Stage 3 — the answer is pushed whenever a transcript exists AND the
    // candidate is still on the question it was recorded for. A skip while
    // the transcription was in flight clears the pending blob — that is the
    // "moved on" signal, and the result belongs to a question the candidate
    // chose to leave: it is discarded, never pushed, never shown (the skip
    // already recorded a skipped answer for that question).
    const stillPending = pendingBlobRef.current === blob;
    pendingBlobRef.current = null;
    if (!stillPending) {
      setTranscribing(false);
      return;
    }
    if (questionIndex === qIndex) setTranscript(text);
    pushAnswer({
      questionId: q.id,
      questionText: q.text,
      sourceCard: q.sourceCard,
      skipped: false,
      transcript: text,
      blobUrl: URL.createObjectURL(blob),
      fileName: `answer-${qIndex + 1}.${extFor(mime ?? "audio/webm")}`,
      durationMs,
      content: score.content,
      delivery: score.delivery,
      missed: score.missed,
      modelAnswer: q.modelAnswer,
      sourceLabel: q.sourceLabel,
    });
    setTranscribing(false);
  };

  /** Retry — the recording is already in hand; re-uploading it costs nothing
   *  and often clears a transient 400/5xx. Same stage separation: the answer
   *  is pushed whenever a transcript exists. */
  const retryTranscription = async () => {
    const blob = pendingBlobRef.current;
    if (!blob || transcribing) return;
    const q = runningQuestions[questionIndex];
    const qIndex = questionIndex;
    if (!q) return;
    setErrorMsg(null);
    setTranscribing(true);
    try {
      const text = (await transcribeBlob(blob, `answer-${qIndex + 1}.${extFor(mime ?? "audio/webm")}`)).trim();
      const recDurationMs = Date.now() - recordStart.current;
      const score = await scoreFor(q, text, recDurationMs);
      // Same "moved on" guard as stopRecording — a skip during the retry
      // discards the result; it never pushes onto a different question.
      const stillPending = pendingBlobRef.current === blob;
      pendingBlobRef.current = null;
      if (!stillPending) return;
      setTranscribeFailed(false);
      if (questionIndex === qIndex) setTranscript(text);
      pushAnswer({
        questionId: q.id,
        questionText: q.text,
        sourceCard: q.sourceCard,
        skipped: false,
        transcript: text,
        blobUrl: URL.createObjectURL(blob),
        fileName: `answer-${qIndex + 1}.${extFor(mime ?? "audio/webm")}`,
        durationMs: recDurationMs,
        content: score.content,
        delivery: score.delivery,
        missed: score.missed,
        modelAnswer: q.modelAnswer,
        sourceLabel: q.sourceLabel,
      });
    } catch (err) {
      // A skip during the retry discards the failure along with the result —
      // it never surfaces on the question the candidate moved to.
      if (pendingBlobRef.current !== blob) return;
      // The blob stays — the candidate can retry again, type instead, or
      // record again. A failed retry is a failure, not a dead end.
      setTranscribeFailed(true);
      setErrorMsg(
        err instanceof Error && "code" in err && (err as { code?: string }).code === "EMPTY_RECORDING"
          ? "The recording captured no audio. Type your answer instead, or record again."
          : `${err instanceof Error ? err.message : String(err)} — retry, type instead, or record again.`,
      );
    } finally {
      setTranscribing(false);
    }
  };

  /** Record again — discard the failed blob and re-arm the recorder for the
   *  same question. */
  const reRecord = () => {
    pendingBlobRef.current = null;
    setTranscribeFailed(false);
    setTypeInstead(false);
    setErrorMsg(null);
    setTranscript("");
    void startRecording();
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

  /** Build the completed session. The closing beat plays while this runs in
   *  the background — it never delays the report. */
  const buildSession = (): Session => {
    const finalAnswers = answersRef.current;
    const answered = finalAnswers.filter((a) => !a.skipped);
    return {
      id: `s-${Date.now()}`,
      dossierId: selected?.id ?? "",
      jobTitle: selected?.jobTitle ?? "",
      company: selected?.company ?? "",
      persona: interviewerRef.current
        ? {
            id: interviewerRef.current.id,
            label: `Hiring Manager · ${selected?.company ?? ""}`,
            name: interviewerRef.current.name,
            voice: interviewerRef.current.voice,
          }
        : { id: "hm", label: "Hiring Manager", name: "Hiring Manager", voice: "sarah" },
      startedAt: startedAt.current,
      completedAt: Date.now(),
      answers: finalAnswers,
      summary: {
        total: finalAnswers.length,
        answered: answered.length,
        skipped: finalAnswers.length - answered.length,
        totalMs: finalAnswers.reduce((s, a) => s + a.durationMs, 0),
        avgContent: avgScore(answered.flatMap((a) => a.content)),
        avgDelivery: avgScore(answered.flatMap((a) => a.delivery)),
        missedTotal: missedTotal(finalAnswers),
      },
    };
  };

  /** The closing beat — a thank-you and a "what happens next", spoken and
   *  displayed, never recorded/scored. It plays while the session is already
   *  built, so it never delays the report. */
  function scriptedClosing(_name: string, _d: Dossier): string {
    return `Thank you — that's the last question. I appreciate you taking the time to walk me through all of that. In a real process, the next step would be a conversation with the team and a more detailed look at how you'd work with them. I'll be in touch either way. Take care.`;
  }

  const finishSession = () => {
    const session = buildSession();
    // The report is ready the moment the closing beat starts playing — the
    // user can dismiss it and go straight there.
    onSessionComplete(session);
    setStarted(false);
    startedRef.current = false;
    activeQuestionsRef.current = [];
    setSelectedId(null);
    setAnswers([]);
    answersRef.current = [];
    interviewerRef.current = null;
    onRunningChange(false);
  };

  /** The single end-of-interview path: closing beat + build + hand off.
   *  Reached from advance() on the last answer AND from skipQuestion() when
   *  the last question is skipped — both produce a session in Relive exactly
   *  the same way, and neither can be lost to advance()'s early return. */
  const completeInterview = () => {
    stopQuestionAudio();
    playTokenRef.current += 1;
    setSpeaking(false);
    setQuestionAudio(null);
    setPlayed(false);
    setTranscript("");
    setErrorMsg(null);
    setTranscribeFailed(false);
    setTypeInstead(false);
    setElapsed(0);
    const interviewer = interviewerRef.current;
    const scripted = interviewer
      ? scriptedClosing(interviewer.name, selected ?? ({ jobTitle: "", company: "" } as Dossier))
      : scriptedClosing("the hiring manager", selected ?? ({ jobTitle: "", company: "" } as Dossier));
    closingRef.current = scripted;
    setClosingText(scripted);
    setClosingReady(true);
    // Speak the closing only in Voice mode — Text mode never plays audio.
    speakIfVoice(scripted, interviewer?.voice ?? "sarah");
    // Score synthesis continues in the background — the closing beat never
    // delays the report. Build + hand off the session now.
    finishSession();
    focusQuestion();
  };

  const advance = () => {
    if (!current) return;
    // A previous question's audio must never overlap the next one.
    stopQuestionAudio();
    playTokenRef.current += 1;
    pendingBlobRef.current = null;
    setSpeaking(false);
    setQuestionAudio(null);
    setPlayed(false);
    setTranscript("");
    setErrorMsg(null);
    setTranscribeFailed(false);
    setTypeInstead(false);
    // A skip during transcription lands here with transcribing still true —
    // the in-flight result belongs to the question the candidate left, and
    // the new question must never inherit its "transcribing…" state.
    setTranscribing(false);
    setElapsed(0);
    if (questionIndex + 1 >= runningQuestions.length) {
      // Last answer committed — closing beat + report.
      completeInterview();
    } else {
      setQuestionIndex((i) => i + 1);
      focusQuestion();
    }
  };

  const skipQuestion = () => {
    if (!current) return;
    // A recording in flight is discarded — skipping moves on, it never
    // transcribes or scores what was being recorded.
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      stopTimer();
      setRecording(false);
      streamRef.current = null;
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    pendingBlobRef.current = null;
    pushAnswer(skippedRecord(current));
    // Skipping the LAST question must complete the session exactly as
    // answering it does — route straight to the end path, never through
    // advance()'s `if (!current) return` guard.
    if (questionIndex + 1 >= runningQuestions.length) {
      completeInterview();
    } else {
      advance();
    }
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!mime) return;
    setMicError(null);
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
      setElapsed(0);
      setTranscript("");
      setErrorMsg(null);
      setRecording(true);
      rec.start();
      timerRef.current = window.setInterval(() => {
        setElapsed((e) => {
          if (e >= ANSWER_SECONDS) {
            void stopRecording();
            return ANSWER_SECONDS;
          }
          return e + 1;
        });
      }, 1000);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : (err as { name?: string } | null)?.name;
      // A permission denial is not a device failure — different cause, different advice.
      if (name === "NotAllowedError") {
        setMicError("denied");
        return;
      }
      if (name === "NotFoundError") {
        setMicError("notfound");
        return;
      }
      setErrorMsg(
        err instanceof Error ? `Couldn't open the microphone — ${err.message}` : "Couldn't open the microphone.",
      );
    }
  };

  const toggleRecording = () => {
    if (recording) void stopRecording();
    else void startRecording();
  };

  const playQuestion = async () => {
    if (mode !== "voice" || !current || replayBusy) return;
    const token = playTokenRef.current;
    setReplayBusy(true);
    try {
      // Resolves only once playback has actually started (audio.ts waits for
      // `playing`); `null` means this press was superseded by a stop — a newer
      // play or advancing — which is expected control flow, not an error.
      const el = await speakQuestion(current.speechText || current.text, persona?.voice || "sarah");
      if (token !== playTokenRef.current) {
        // The user moved on while the TTS fetch was in flight — the audio
        // that just started belongs to a question we've left. Kill it.
        stopQuestionAudio();
        return;
      }
      if (el) {
        setPlayed(true);
        setQuestionAudio(el);
        setSpeaking(true);
        // The audio error clears only when playback actually begins — a press
        // that never produced sound leaves the previous message standing.
        setErrorMsg(null);
        el.addEventListener("ended", () => setSpeaking(false), { once: true });
      }
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
    // Scoring failure falls back to the rubric — it never costs a typed answer.
    const score = await scoreFor(current, text, 0);
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

  // Track the OS motion preference so the speaking indicator can swap its
  // moving bar for a static label — the information survives, the motion does not.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    return () => {};
  }, []);

  /** The interviewer-gender control on the setup screen. */
  const [gender, setGender] = useState<InterviewerGender>("random");
  const genderRef = useRef<InterviewerGender>("random");
  genderRef.current = gender;

  if (!started) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 id={headingId} tabIndex={-1} className="font-heading text-display-lg font-semibold tracking-tight text-ink">
            Rehearse
          </h1>
          <p className="mt-2 max-w-[68ch] text-sm text-slate">
            Pick a researched job. One interviewer, eight questions, answered aloud — then scored against what the
            research found.
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

            <section className="mb-8" aria-label="Interviewer">
              <h2 className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">Interviewer</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["random", "female", "male"] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGender(g)}
                    aria-pressed={gender === g}
                    className={`btn btn-sm capitalize ${gender === g ? "btn-primary" : "btn-secondary"}`}
                  >
                    {g}
                  </button>
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
              {mode === "voice" && !voiceUnsupported && (
                <p className="mt-4 max-w-[58ch] text-sm text-slate">
                  When you begin, the browser will ask for microphone access. Your answers are recorded so they can
                  be transcribed and scored, and nothing is stored on a server unless recording storage is switched
                  on.
                </p>
              )}
            </section>

            <button className="btn btn-primary w-full sm:w-auto" disabled={!selectedId || questionsLoading} onClick={begin}>
              {questionsLoading ? "Preparing questions…" : "Begin interview"}
            </button>
            {questionsLoading ? (
              <p className="mt-2 font-mono text-[0.6875rem] italic text-slate">
                ai questions are being prepared — begin interview unlocks the moment they're ready
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
          {questionIndex + 1} / {runningQuestions.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {started && pastOpening && !current && !closingText ? (
          /* `current` undefined mid-run (past the opening) is a bug, not a
             state to sit in silently. `pastOpening` is the current-question
             state, independent of opening/closing text — the old
             `!openingText && !closingText` gating masked a missing `current`
             because openingText stays set until question 1 lands. End the
             session cleanly — the answers so far are saved — and say so out
             loud. */
          <div role="alert" className="failure-box flex flex-col gap-3">
            <p className="font-heading text-display-sm font-semibold text-ink">The interview couldn't continue</p>
            <p className="max-w-[58ch] text-sm text-ink">Your answers so far were saved.</p>
            <div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  stopQuestionAudio();
                  finishSession();
                }}
              >
                End session
              </button>
            </div>
          </div>
        ) : null}

        {openingText ? (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
              {persona?.name ? `${persona.name} · ` : ""}
              {personaLabel}
            </p>
            <p className="font-heading text-display-md font-semibold leading-snug text-ink">{openingText}</p>
            <p className="mt-2 font-mono text-[0.6875rem] text-slate">
              {selected?.company ? `${selected.company} · ` : ""}
              opening
            </p>
            {/* The skip-intro control — question 1 appears only after the
                opening finishes (Voice) or the candidate gets started here
                (either mode). The screen never sits with no enabled action. */}
            <div className="mt-4">
              <button
                ref={getStartedRef}
                type="button"
                className="btn btn-primary btn-sm"
                onClick={startFirstQuestion}
              >
                Get started
              </button>
            </div>
          </div>
        ) : current ? (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
              {persona?.name ? `${persona.name} · ` : ""}
              {personaLabel}
            </p>
            <p
              ref={questionRef}
              tabIndex={-1}
              className="font-heading text-display-md font-semibold leading-snug text-ink focus:outline-none"
            >
              {current.text}
            </p>
            <p className="mt-2 font-mono text-[0.6875rem] text-slate">
              {selected?.company ? `${selected.company} · ` : ""}
              {current.sourceLabel}
            </p>
          </div>
        ) : null}

        {closingText ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-ink/15 pt-4">
            <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
              {persona?.name ? `${persona.name} · ` : ""}
              {personaLabel} · closing
            </p>
            <p className="font-heading text-display-md font-semibold leading-snug text-ink">{closingText}</p>
            {closingReady ? (
              <button
                type="button"
                className="btn btn-primary btn-sm w-fit"
                onClick={() => {
                  stopQuestionAudio();
                  if (goRelive) goRelive();
                }}
              >
                Go to report
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="shrink-0">
        {started && !current ? null : openingText ? null : mode === "voice" ? (
          <div className="flex flex-col items-center gap-4">
            {/* Elapsed-time ring — Flag track, Ink progress, mono numeral.
                The numeral counts UP from 0:00; the ring fills rather than
                depletes. Only the last 15 seconds change the ring's weight —
                no colour, no pulsing, no sound. */}
            <div
              className="relative grid h-32 w-32 place-items-center rounded-full"
              role="timer"
              aria-label={`${recording ? fmtElapsed(elapsed) : "0:00"} elapsed`}
            >
              <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 128 128" aria-hidden="true">
                <circle cx="64" cy="64" r="58" fill="none" stroke="var(--color-flag)" strokeWidth="4" />
                <circle
                  cx="64"
                  cy="64"
                  r="58"
                  fill="none"
                  stroke="var(--color-ink)"
                  strokeWidth={inWarning ? 6 : 4}
                  strokeLinecap="square"
                  strokeDasharray={2 * Math.PI * 58}
                  strokeDashoffset={2 * Math.PI * 58 * (1 - elapsed / ANSWER_SECONDS)}
                  className="transition-[stroke-dashoffset,stroke-width] duration-1000 ease-linear"
                />
              </svg>
              <span className="font-mono text-2xl tabular-nums text-ink">{recording ? fmtElapsed(elapsed) : "0:00"}</span>
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

            {micError ? (
              <div role="alert" className="max-w-xs text-center text-sm text-ink">
                <p>
                  {micError === "denied"
                    ? "The browser blocked microphone access. You can re-enable it from the address bar — or answer in text mode instead."
                    : "No microphone was found on this device. Connect one and try again — or answer in text mode."}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-3"
                  onClick={() => {
                    setMicError(null);
                    onModeChange("text");
                  }}
                >
                  Use text mode
                </button>
              </div>
            ) : null}

            {errorMsg && !transcribeFailed ? (
              <p role="alert" className="max-w-xs text-center text-sm text-ink">
                {errorMsg}
              </p>
            ) : null}

            {transcribeFailed ? (
              /* The three recovery actions — a failed transcription is never
                 a dead end. Skip stays available below. */
              <div role="alert" className="flex max-w-xs flex-col items-center gap-2 text-center">
                <p className="text-sm text-ink">{errorMsg}</p>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void retryTranscription()}
                    disabled={transcribing}
                  >
                    <RefreshCw aria-hidden="true" className="h-4 w-4" />
                    Retry transcription
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setTypeInstead(true);
                      // The textarea replaces the failure panel — the three
                      // recovery actions yield to the answer box itself.
                      setTranscribeFailed(false);
                      setErrorMsg(null);
                    }}
                    disabled={transcribing}
                  >
                    <Keyboard aria-hidden="true" className="h-4 w-4" />
                    Type instead
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={reRecord}
                    disabled={transcribing}
                  >
                    Record again
                  </button>
                </div>
              </div>
            ) : null}

            {typeInstead ? (
              /* "Type instead" — the text box from text mode, revealed on the
                 voice surface. Same commit path as text mode (commitText). */
              <div className="flex w-full max-w-md flex-col gap-3">
                <label htmlFor="answer-text-voice" className="font-mono text-[0.6875rem] uppercase tracking-wider text-slate">
                  your answer
                </label>
                <textarea
                  id="answer-text-voice"
                  rows={4}
                  className="input resize-y"
                  placeholder="Type your answer instead…"
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />
                {errorMsg ? (
                  <p role="alert" className="text-sm text-ink">
                    {errorMsg}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setTypeInstead(false);
                      setTranscribeFailed(true);
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void commitText()}
                    disabled={!transcript.trim() || transcribing}
                  >
                    {questionIndex + 1 >= runningQuestions.length ? "Finish" : "Next question"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {speaking && (
                  <SpeakingIndicator
                    audio={questionAudio}
                    name={persona?.name || "Interviewer"}
                    role={personaLabel}
                    reducedMotion={reducedMotion}
                  />
                )}

                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={playQuestion}
                    disabled={recording || transcribing || replayBusy}
                  >
                    <Volume2 aria-hidden="true" className="h-4 w-4" />
                    {played ? "Replay question" : "Play question"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={skipQuestion}
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
                    {questionIndex + 1 >= runningQuestions.length ? "Finish" : "Next question"}
                  </button>
                </div>
              </>
            )}
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
                {questionIndex + 1 >= runningQuestions.length ? "Finish" : "Next question"}
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
