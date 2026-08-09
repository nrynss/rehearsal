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
/** The element most recently stopped by stopQuestionAudio. Its pending play()
 *  rejects with AbortError — that rejection is expected control flow (a newer
 *  play or an explicit stop superseded it), never a user-facing failure.
 *  Marking it lets us recognise exactly that case. */
let stoppedQuestionAudio: HTMLAudioElement | null = null;

/** Stop any question audio still playing (replay replaces, never stacks). */
export function stopQuestionAudio() {
  if (activeQuestionAudio) {
    stoppedQuestionAudio = activeQuestionAudio;
    activeQuestionAudio.pause();
    activeQuestionAudio = null;
  }
}

/** A real playback failure, with the underlying cause kept instead of
 *  flattened into a generic sentence. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const named = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return err.message ? `${named}${err.message}` : err.name || "unknown error";
  }
  return String(err);
}

/**
 * Speak a question aloud via the `speechmatics-tts` edge function. The WAV
 * comes back as a blob and plays from memory — no file, no consent, no
 * server round-trip after the first fetch. Repeated playback never counts
 * against the answer.
 *
 * Resolves with the playing element only once playback has actually started
 * (the `playing` event — or play() settling, which is the same moment).
 * Returns `null` when the attempt was superseded by an explicit stop before
 * playback began (AbortError, or the element we ourselves marked as stopped)
 * — expected control flow, never an error. Real failures throw with the
 * underlying cause attached.
 */
export async function speakQuestion(text: string, voiceName: string): Promise<HTMLAudioElement | null> {
  stopQuestionAudio();
  const voice = TTS_VOICES[voiceName] ?? "sarah";
  const blob = await callEdgeAudio("speechmatics-tts", { text, voice });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeQuestionAudio = audio;
  const cleanup = () => {
    if (activeQuestionAudio === audio) activeQuestionAudio = null;
    URL.revokeObjectURL(url);
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("error", onError);
        fn();
      };
      const onPlaying = () => finish(resolve);
      const onError = () =>
        finish(() => reject(new Error(audio.error?.message || "The audio clip failed to load.")));
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("error", onError);
      // play() rejects with AbortError when the element is paused (by us)
      // before playback begins — surface that through the promise rather
      // than hanging on an event that will never fire.
      void audio.play().then(() => finish(resolve), (err: unknown) => finish(() => reject(err)));
    });
  } catch (err) {
    cleanup();
    const superseded =
      (err instanceof DOMException && err.name === "AbortError") || audio === stoppedQuestionAudio;
    if (superseded) return null;
    throw new Error(`Couldn't play the question audio — ${describeError(err)}`);
  }
  return audio;
}
