/**
 * The one-time splash screen's dismissal flag.
 *
 * The splash appears once per browser: it shows until the visitor dismisses it
 * (any way in counts — Start, Sign in or Create an account) and then never
 * interrupts them again. The flag lives in localStorage because the decision
 * must be synchronous — it is read before any network call, so a slow or
 * failing session can never hold the splash on screen or block the way in.
 *
 * This is strictly necessary state for a screen the user asked for, alongside
 * the Supabase session. The app sets no analytics, no advertising and no
 * third-party storage — nothing else is ever written here.
 */
const SPLASH_DISMISS_KEY = "rehearsal:splash-dismissed";

/** True when this browser has already dismissed the splash. */
export function hasDismissedSplash(): boolean {
  try {
    return localStorage.getItem(SPLASH_DISMISS_KEY) === "1";
  } catch {
    // Storage unavailable (private mode, blocked cookies). Showing the splash
    // is the honest fallback — the visitor can always dismiss it.
    return false;
  }
}

/** Record that this browser dismissed the splash. Never throws. */
export function dismissSplash(): void {
  try {
    localStorage.setItem(SPLASH_DISMISS_KEY, "1");
  } catch {
    // Storage unavailable — the flag just won't persist; the in-memory
    // decision still gets the visitor into the app.
  }
}
