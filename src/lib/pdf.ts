import { MAX_RESUME_CHARS } from "./resume";

/**
 * PDF resume extraction — client-side only, with pdf.js.
 *
 * The file is read into memory via `File.arrayBuffer()` and never leaves the
 * browser: no upload to us, none to any third party. That is the whole reason
 * this exists instead of linking out — the resume is the most personal thing
 * the product touches, so the text layer is pulled out right here and dropped
 * into the textarea where the user can check it before saving.
 *
 * pdf.js must be imported lazily: its build touches DOMMatrix and other DOM
 * globals at module scope, so a static import would crash Node (and vitest).
 * The worker is wired through Vite's `?url` import, which emits the worker
 * file as an asset and returns its URL.
 */

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      try {
        // Vite turns `?url` into the emitted worker asset's URL. pdf.js v6
        // always constructs the worker with `type: "module"`, so the .mjs
        // worker file is exactly what it wants.
        const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as { default?: string };
        if (worker.default) pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      } catch {
        // No worker in this environment (tests). Extraction below reports the
        // friendly fallback message instead of crashing.
      }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/** Extract the text layer of a PDF, page by page, joined with blank lines.
 *  Column layouts interleave slightly — acceptable, the user sees the result
 *  in the textarea and can fix it before saving. Throws plain messages the UI
 *  can render as-is, never a raw error or stack trace. */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        // TextItem carries `str`; marked-content entries do not — skip those.
        if ("str" in item) {
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
      }
      const trimmed = text.trim();
      if (trimmed) pages.push(trimmed);
    }
    const joined = pages.join("\n\n").trim();
    if (!joined) {
      // A scanned PDF has no text layer and extracts nothing — say so plainly.
      throw new Error("This PDF looks like a scan — there's no text to extract. Paste the text instead.");
    }
    return joined.slice(0, MAX_RESUME_CHARS);
  } catch (err) {
    if (err instanceof Error && /scan/i.test(err.message)) throw err;
    // Extraction is a convenience; the paste box remains the guaranteed path.
    throw new Error("Couldn't read that PDF. Paste the text instead.");
  }
}
