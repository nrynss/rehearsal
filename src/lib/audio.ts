import { callEdgeForm } from "./config";

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
