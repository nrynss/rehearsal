import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RESUME_CHARS } from "../../lib/resume";
import { extractPdfText } from "../../lib/pdf";

/**
 * pdf.ts dynamically imports "pdfjs-dist" and the worker ?url module, and
 * touches DOM globals at module scope. We mock both dynamic imports so the
 * extraction logic (page loop, hasEOL handling, scan detection, fallback) is
 * tested deterministically in Node.
 */
const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

const workerUrlMock = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist", () => pdfjsMock);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: workerUrlMock }));

/** A fake pdf.js document whose pages produce the given text items. */
function fakeDoc(pages: Array<Array<Record<string, unknown>>>) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (n: number) => ({
      getTextContent: vi.fn(async () => ({ items: pages[n - 1] ?? [] })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractPdfText", () => {
  it("extracts page by page and joins with blank lines", async () => {
    pdfjsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(
        fakeDoc([
          [{ str: "Jane Doe", hasEOL: true }, { str: "Engineer", hasEOL: false }],
          [{ str: "React", hasEOL: false }],
        ]),
      ),
    });
    await expect(extractPdfText(new File([""], "resume.pdf", { type: "application/pdf" }))).resolves.toBe(
      "Jane Doe\nEngineer\n\nReact",
    );
  });

  it("detects a scanned PDF (empty text layer) with a plain message", async () => {
    pdfjsMock.getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc([[{ str: "", hasEOL: false }]])) });
    await expect(extractPdfText(new File([""], "scan.pdf", { type: "application/pdf" }))).rejects.toThrow(
      /looks like a scan/i,
    );
  });

  it("falls back to a plain message when pdf.js throws", async () => {
    pdfjsMock.getDocument.mockImplementation(() => {
      throw new Error("corrupt PDF: internal parser error");
    });
    await expect(extractPdfText(new File([""], "bad.pdf", { type: "application/pdf" }))).rejects.toThrow(
      /Paste the text instead/,
    );
  });

  it("truncates long extractions to MAX_RESUME_CHARS", async () => {
    pdfjsMock.getDocument.mockReturnValue({
      promise: Promise.resolve(fakeDoc([[{ str: "a".repeat(MAX_RESUME_CHARS + 500), hasEOL: false }]])),
    });
    const text = await extractPdfText(new File([""], "long.pdf", { type: "application/pdf" }));
    expect(text).toHaveLength(MAX_RESUME_CHARS);
  });
});
