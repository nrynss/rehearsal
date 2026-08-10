import { chromium } from "playwright";

/**
 * Smoke test for the Relive summary at 375px (iPhone SE-class viewport).
 *
 * Serves the real ReliveScreen through Vite (real CSS, real components) and
 * asserts:
 *  1. The verdict line renders (banded on content average).
 *  2. The weakest-content-axis line renders.
 *  3. The missed-points total renders.
 *  4. Attendance cells are demoted (answered/skipped still present).
 *  5. No horizontal overflow at 375px.
 *  6. The inner Content/Delivery subtabs are keyboard-operable.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:5173";
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp/relive-shots";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Chromium logs a generic "Failed to load resource" console error for its
  // default /favicon.ico probe (this app ships nativelyai.svg instead). That
  // probe never surfaces as a response event, so we can't filter it by URL.
  // Real failures are caught below via response/requestfailed handlers.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const args = m.args().map((a) => a.jsonValue().catch(() => null));
    Promise.all(args).then((vals) => {
      const detail = vals.filter((v) => v !== null).join(" ");
      console.log("CONSOLE-ERROR:", m.text(), "|", detail);
    });
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("favicon")) errors.push(`HTTP ${res.status()}: ${res.url()}`);
    // Log every response that isn't 200 so we can see exactly what failed.
    if (res.status() !== 200) console.log("RESP:", res.status(), res.url());
  });
  page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`));
  page.on("request", (req) => {
    if (req.url().includes("favicon") || req.url().includes(".woff") || req.url().includes(".ttf")) {
      console.log("REQ:", req.url());
    }
  });

  await page.goto(`${BASE}/smoke/relive-smoke.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__smokeReady === true, null, { timeout: 10_000 });

  // The session is inside an Expander, closed by default — open it.
  const trigger = page.getByRole("button", { name: /Senior QA Automation Engineer/ });
  await trigger.click();
  await sleep(350); // collapse-row transition (200ms) + a beat

  // --- 1. Verdict (avgContent 3.0 → "almost" band) ---
  const verdict = page.getByText(/One more rehearsal before the interview/);
  if (!(await verdict.count())) throw new Error("verdict line missing");

  // --- 2. Weakest content axis (Specificity, avg 2.0) ---
  const weakest = page.getByText(/Specificity is the weakest content axis, averaging 2\.0/);
  if (!(await weakest.count())) throw new Error("weakest-axis line missing");

  // --- 3. Missed-points total (3 answered, 5 missed) ---
  const missed = page.getByText(/5 key points missed across 3 questions\./);
  if (!(await missed.count())) throw new Error("missed-total line missing");

  // --- 4. Demoted attendance cells ---
  const answered = page.getByText("answered", { exact: true });
  const skipped = page.getByText("skipped", { exact: true });
  if (!(await answered.count())) throw new Error("'answered' cell missing");
  if (!(await skipped.count())) throw new Error("'skipped' cell missing");
  const labels = await page.locator("span").allTextContents();
  const answeredVal = labels.find((t) => t.trim() === "3");
  const skippedVal = labels.find((t) => t.trim() === "1");
  if (answeredVal === undefined || skippedVal === undefined) {
    throw new Error(`attendance values missing (answered=3, skipped=1). Got: ${labels.join(" | ")}`);
  }

  // --- 5. No horizontal overflow at 375px ---
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
  });
  if (overflow.scrollW > overflow.clientW) {
    throw new Error(`horizontal overflow: scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}`);
  }

  // --- 6. Inner subtabs are keyboard-operable (roving tabindex) ---
  const contentTab = page.getByRole("tab", { name: "content" }).first();
  await contentTab.focus();
  await page.keyboard.press("ArrowRight");
  const deliverySelected = await page.getByRole("tab", { name: "delivery" }).first().getAttribute("aria-selected");
  if (deliverySelected !== "true") throw new Error("ArrowRight on subtab did not move to delivery");

  // Screenshots: full summary, plus the expanded question area.
  await page.screenshot({ path: `${SHOT_DIR}/relive-375-summary.png`, fullPage: true });
  await page.getByText(/Tell me about a hard problem/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT_DIR}/relive-375-question.png` });

  if (errors.length) {
    throw new Error(`page errors:\n${errors.join("\n")}`);
  }

  console.log("PASS: Relive summary at 375px — verdict, weakest axis, missed total, demoted attendance, no overflow, subtab keyboard nav.");
  console.log(`Screenshots: ${SHOT_DIR}/relive-375-summary.png, ${SHOT_DIR}/relive-375-question.png`);
} finally {
  await browser.close();
}
