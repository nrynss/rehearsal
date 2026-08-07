import { supabase } from "./config";
import type { Resume } from "./types";

/**
 * The user's resume — one row per user in `resumes`, RLS-scoped to the owner.
 *
 * This is the only user-authored content the product stores. Everything else
 * cached server-side (postings, company records, news, briefs) is public data.
 * The resume is plain text: it goes to the model for fit matching and question
 * targeting, and nowhere else.
 *
 * Identity comes from the persisted anonymous session (see config.ts). When
 * real accounts land, linking the anonymous user carries the resume across.
 */

/** Guards the model prompt and the row: long enough for any real resume,
 *  short enough that a pasted book cannot blow up the request. */
export const MAX_RESUME_CHARS = 20000;

/** Text-bearing types we can read directly. PDFs are rejected with guidance
 *  rather than parsed — pdf.js is heavy and fails on design-led resumes, and a
 *  silently mangled resume is worse than asking the user to paste. */
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".text"];

export function isReadableResumeFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Read a text file into a resume string. Throws with a plain message the UI
 *  can render as-is — never a raw DOMException. */
export async function readResumeFile(file: File): Promise<string> {
  if (!isReadableResumeFile(file)) {
    throw new Error("That file type can't be read here. Paste the text instead, or upload a .txt or .md file.");
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new Error("Couldn't read that file. Paste the text instead.");
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("That file looks empty. Paste the text instead.");
  return trimmed.slice(0, MAX_RESUME_CHARS);
}

/** Validate rather than assert: there are no generated Supabase types here, so
 *  the row is effectively `any`. A malformed row must return null, not blow up
 *  in a render when `.trim()` is called on a missing field. */
function rowToResume(row: unknown): Resume | null {
  const r = (row ?? {}) as Record<string, unknown>;
  if (typeof r.content !== "string" || !r.content.trim()) return null;
  const parsed = typeof r.updated_at === "string" ? Date.parse(r.updated_at) : NaN;
  return {
    content: r.content,
    fileName: typeof r.file_name === "string" && r.file_name ? r.file_name : undefined,
    updatedAt: Number.isFinite(parsed) ? parsed : Date.now(),
  };
}

/** The signed-in user's resume, or null if none is saved. Never throws —
 *  a missing resume is an ordinary state, not an error. */
export async function loadResume(): Promise<Resume | null> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return null;
    // Scope the read explicitly. RLS is the real boundary, but it is applied by
    // hand to a table created by hand — the client should not be the only thing
    // standing between two people's resumes.
    const { data, error } = await supabase
      .from("resumes")
      .select("content, file_name, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return rowToResume(data);
  } catch {
    return null;
  }
}

/** Save (or replace) the resume. Returns null when it could not be stored, so
 *  the caller can keep using it for this session and say so. */
export async function saveResume(content: string, fileName?: string): Promise<Resume | null> {
  const trimmed = content.trim().slice(0, MAX_RESUME_CHARS);
  if (!trimmed) return null;
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from("resumes")
      // `updated_at` is owned by the database (DEFAULT now() + trigger), not by
      // the browser clock — client skew would render "saved" times in the future.
      .upsert({ user_id: userId, content: trimmed, file_name: fileName ?? null }, { onConflict: "user_id" })
      .select("content, file_name, updated_at")
      .single();
    if (error || !data) return null;
    return rowToResume(data);
  } catch {
    return null;
  }
}

/**
 * Delete the resume and sign out of the persisted anonymous session.
 *
 * `persistSession: true` gives the resume a stable owner, but it also leaves a
 * durable identity in localStorage on whatever machine this is — which may be
 * shared or borrowed. With no accounts and no login, this is the only way to
 * say "forget me here", so it belongs next to Delete rather than buried.
 */
export async function forgetDevice(): Promise<boolean> {
  const removed = await deleteResume();
  try {
    await supabase.auth.signOut();
  } catch {
    // The row is what matters; a failed sign-out still leaves nothing personal.
  }
  return removed;
}

/** Remove the stored resume. Returns false if the delete did not land, so the
 *  UI can avoid claiming it is gone when it is not. */
export async function deleteResume(): Promise<boolean> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return false;
    const { error } = await supabase.from("resumes").delete().eq("user_id", userId);
    return !error;
  } catch {
    return false;
  }
}
