import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RESUME_CHARS, deleteResume, forgetDevice, isReadableResumeFile, loadResume, readResumeFile, saveResume } from "../../lib/resume";

// The module imports { supabase } from ../lib/config. vi.mock hoists; the mock
// factory supplies a fake client whose auth/from methods return chainable
// stubs. vi.hoisted is required because the factory is hoisted above this
// file's const declarations.
const mockChain = vi.hoisted(() => ({
  auth: { getUser: vi.fn(), signOut: vi.fn(), getSession: vi.fn(), signInAnonymously: vi.fn() },
  from: vi.fn(),
}));

vi.mock("../../lib/config", () => ({
  supabase: mockChain,
}));

/** Build a fake `.from('resumes')` chain for a query returning `data`/`error`. */
function chainFrom(data: unknown, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    upsert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
    delete: vi.fn().mockReturnThis(),
  };
  mockChain.from.mockReturnValue(chain);
  return chain;
}

const USER_ID = "user-123";

beforeEach(() => {
  vi.clearAllMocks();
  mockChain.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isReadableResumeFile", () => {
  it("accepts text/* types", () => {
    expect(isReadableResumeFile(new File(["x"], "resume.txt", { type: "text/plain" }))).toBe(true);
  });

  it("accepts .md and .markdown by extension even without a mime type", () => {
    expect(isReadableResumeFile(new File(["x"], "resume.md", { type: "" }))).toBe(true);
  });

  it("rejects PDFs", () => {
    expect(isReadableResumeFile(new File(["x"], "resume.pdf", { type: "application/pdf" }))).toBe(false);
  });
});

describe("readResumeFile", () => {
  it("throws a friendly error for unreadable types", async () => {
    const pdf = new File(["x"], "resume.pdf", { type: "application/pdf" });
    await expect(readResumeFile(pdf)).rejects.toThrow(/Paste the text instead/);
  });

  it("throws for an empty file", async () => {
    const txt = new File([""], "resume.txt", { type: "text/plain" });
    await expect(readResumeFile(txt)).rejects.toThrow(/looks empty/);
  });

  it("trims and truncates to MAX_RESUME_CHARS", async () => {
    const big = "a".repeat(MAX_RESUME_CHARS + 100);
    const txt = new File([big], "resume.txt", { type: "text/plain" });
    const text = await readResumeFile(txt);
    expect(text).toHaveLength(MAX_RESUME_CHARS);
    expect(text.startsWith("a")).toBe(true);
  });
});

describe("loadResume", () => {
  it("returns null when there is no signed-in user", async () => {
    mockChain.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(loadResume()).resolves.toBeNull();
  });

  it("returns the parsed resume row", async () => {
    const row = { content: "My resume", file_name: "cv.txt", updated_at: "2026-01-15T10:00:00Z" };
    chainFrom(row);
    const resume = await loadResume();
    expect(resume?.content).toBe("My resume");
    expect(resume?.fileName).toBe("cv.txt");
    expect(resume?.updatedAt).toBe(Date.parse("2026-01-15T10:00:00Z"));
  });

  it("returns null when the query errors", async () => {
    chainFrom(null, { message: "boom" });
    await expect(loadResume()).resolves.toBeNull();
  });
});

describe("saveResume", () => {
  it("saves via upsert keyed on user_id and returns the saved row", async () => {
    const row = { content: "Fresh resume", file_name: null, updated_at: "2026-01-15T10:00:00Z" };
    const chain = chainFrom(row);
    const saved = await saveResume("  Fresh resume  ", "cv.txt");
    expect(chain.upsert).toHaveBeenCalledWith(
      { user_id: USER_ID, content: "Fresh resume", file_name: "cv.txt" },
      { onConflict: "user_id" },
    );
    expect(saved?.content).toBe("Fresh resume");
    expect(saved?.fileName).toBeUndefined();
  });

  it("returns null for blank content", async () => {
    await expect(saveResume("   ")).resolves.toBeNull();
  });

  it("returns null when the upsert errors", async () => {
    chainFrom(null, { message: "boom" });
    await expect(saveResume("some content")).resolves.toBeNull();
  });
});

describe("deleteResume", () => {
  it("deletes the user's row and reports success", async () => {
    const chain = chainFrom(undefined, null);
    await expect(deleteResume()).resolves.toBe(true);
    expect(chain.delete).toHaveBeenCalled();
  });

  it("returns false when there is no user", async () => {
    mockChain.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(deleteResume()).resolves.toBe(false);
  });
});

describe("forgetDevice", () => {
  it("deletes the resume and signs out", async () => {
    chainFrom(undefined, null);
    mockChain.auth.signOut.mockResolvedValue({ error: null });
    await expect(forgetDevice()).resolves.toBe(true);
    expect(mockChain.auth.signOut).toHaveBeenCalled();
  });
});
