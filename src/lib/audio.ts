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
 * Speechmatics' batch input accepts wav, mp3, aac, ogg, mpeg, amr, m4a, mp4
 * and flac — WebM is NOT one of them, and WebM is exactly the container
 * Chrome/Firefox/Edge record into. So the upload is always converted to a
 * 16 kHz mono 16-bit PCM WAV first (the format Speechmatics names as needing
 * no preprocessing). The original recording blob is untouched — conversion is
 * for the upload only; `blobUrl`/`fileName` keep describing the playable
 * original for Relive playback.
 */
export const WAV_SAMPLE_RATE = 16000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;

/** Recordings smaller than this are noise, not answers — reject locally,
 *  far clearer than a vendor 400. */
const MIN_RECORDING_BYTES = 200;

/** A recording that carried no usable audio. The UI recognises it by `code`
 *  (EMPTY_RECORDING) and offers retry / type-instead / record-again instead
 *  of surfacing a generic failure. */
export class EmptyRecordingError extends Error {
  readonly code = "EMPTY_RECORDING";
  constructor() {
    super("The recording captured no audio.");
    this.name = "EmptyRecordingError";
  }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** The canonical 44-byte WAV header: RIFF/WAVE, 16-bit PCM, mono, 16 kHz,
 *  data chunk with the correct byte length. Pure — unit-testable without a
 *  browser. */
export function wavHeader(
  dataByteLength: number,
  sampleRate = WAV_SAMPLE_RATE,
  numChannels = WAV_CHANNELS,
  bitsPerSample = WAV_BITS_PER_SAMPLE,
): ArrayBuffer {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataByteLength, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataByteLength, true);
  return buf;
}

/** Decode any MediaRecorder container (webm, mp4, …) and render it down to
 *  mono at 16 kHz with an OfflineAudioContext — the Web Audio graph does the
 *  downmix and the resample in one pass, no hand-rolled interpolation. An
 *  OfflineAudioContext decodes without a live audio output or a user gesture. */
async function renderMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const OfflineCtor =
    typeof OfflineAudioContext !== "undefined"
      ? OfflineAudioContext
      : (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext;
  if (!OfflineCtor) {
    throw new Error("This browser can't convert the recording — answer in text mode instead.");
  }
  const decodeCtx = new OfflineCtor(1, 1, WAV_SAMPLE_RATE);
  const source = await decodeCtx.decodeAudioData(arrayBuffer);
  if (!source || source.length === 0) throw new EmptyRecordingError();
  const length = Math.max(1, Math.ceil((source.length * WAV_SAMPLE_RATE) / source.sampleRate));
  const renderCtx = new OfflineCtor(1, length, WAV_SAMPLE_RATE);
  const src = renderCtx.createBufferSource();
  src.buffer = source;
  src.connect(renderCtx.destination);
  src.start();
  const rendered = await renderCtx.startRendering();
  return rendered.getChannelData(0);
}

/** Float32 [-1, 1] → little-endian 16-bit PCM samples. */
function pcm16(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const v = new DataView(buf);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buf;
}

/** Convert a recorded answer blob (any MediaRecorder container) to a
 *  16 kHz mono 16-bit PCM WAV blob, ready for Speechmatics. Throws
 *  `EmptyRecordingError` (code EMPTY_RECORDING) when the recording carried
 *  no audio, so the UI never uploads silence. */
export async function encodeWav(blob: Blob): Promise<Blob> {
  if (blob.size < MIN_RECORDING_BYTES) throw new EmptyRecordingError();
  const samples = await renderMono16k(blob);
  if (samples.length === 0) throw new EmptyRecordingError();
  const pcm = pcm16(samples);
  const header = wavHeader(pcm.byteLength);
  return new Blob([header, pcm], { type: "audio/wav" });
}

/**
 * Upload one recorded answer to the Speechmatics batch edge function, always
 * as a WAV — the browser's recording container is converted client-side so
 * the vendor never sees a WebM. The original blob is left untouched for
 * playback; the upload name becomes `answer-N.wav`.
 */
export async function transcribeBlob(blob: Blob, fileName: string): Promise<string> {
  const wav = await encodeWav(blob);
  const uploadName = `${fileName.replace(/\.[a-z0-9]+$/i, "")}.wav`;
  const form = new FormData();
  form.append("audio", wav, uploadName);
  try {
    const res = await callEdgeForm<{ transcript?: string; error?: string }>("speechmatics-batch", form);
    const t = (res.transcript ?? "").trim();
    if (!t) throw new Error(res.error ?? "The transcript came back empty — try again.");
    return t;
  } catch (err) {
    // Diagnostics: blob size, source mime and encoded WAV size alongside the
    // failure, so the next incident is diagnosable from the console.
    console.warn(
      "[speechmatics] transcription failed",
      { sourceSize: blob.size, sourceType: blob.type, encodedWavSize: wav.size, uploadName },
      err,
    );
    throw err;
  }
}

/** Speechmatics TTS voice ids — the catalogue's four voices (sarah, theo,
 *  megan, jack). These are raw TTS ids passed straight through from the
 *  interviewer pools in types.ts; there is no persona-display-name indirection
 *  anymore, so an unknown id falls back to the catalogue default. */
const TTS_VOICES: Record<string, string> = {
  sarah: "sarah",
  theo: "theo",
  megan: "megan",
  jack: "jack",
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
