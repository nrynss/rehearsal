import { callEdgeAudio, callEdgeForm } from "./config";

/**
 * iOS Safari's MediaRecorder emits audio/mp4, not webm — never hardcode
 * a single container. Pick the first type the browser actually supports.
 */
const CANDIDATE_TYPES = ["audio/webm", "audio/mp4", "audio/aac", "audio/webm;codecs=opus"];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of CANDIDATE_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      // Some browsers throw on unknown strings — try the next one.
    }
  }
  return null;
}

export function extFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("aac")) return "aac";
  return "webm";
}

/**
 * Upload one recorded answer to the Speechmatics batch edge function.
 * The actual mime type passes through so mp4/aac from iOS transcribe
 * correctly.
 */
export async function transcribeBlob(blob: Blob, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, fileName);
  const res = await callEdgeForm<{ transcript?: string; error?: string }>("speechmatics-batch", form);
  const t = (res.transcript ?? "").trim();
  if (!t) throw new Error(res.error ?? "The transcript came back empty — try again.");
  return t;
}

/** Speechmatics TTS voice id per persona display name (types.ts PERSONAS). */
const TTS_VOICES: Record<string, string> = {
  Sarah: "sarah",
  Theo: "theo",
  Megan: "megan",
};

let activeQuestionAudio: HTMLAudioElement | null = null;

/** Stop any question audio still playing (replay replaces, never stacks). */
export function stopQuestionAudio() {
  if (activeQuestionAudio) {
    activeQuestionAudio.pause();
    activeQuestionAudio = null;
  }
}

/**
 * Speak a question aloud via the `speechmatics-tts` edge function. The WAV
 * comes back as a blob and plays from memory — no file, no consent, no
 * server round-trip after the first fetch. Repeated playback never counts
 * against the answer.
 */
export async function speakQuestion(text: string, voiceName: string): Promise<void> {
  stopQuestionAudio();
  const voice = TTS_VOICES[voiceName] ?? "sarah";
  const blob = await callEdgeAudio("speechmatics-tts", { text, voice });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeQuestionAudio = audio;
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  audio.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
  try {
    await audio.play();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Couldn't play the question audio — try again.");
  }
}
