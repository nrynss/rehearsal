import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSplashDismissal,
  dismissSplash,
  hasDismissedSplash,
  onShowIntroRequested,
  requestShowIntro,
} from "../../lib/splash";

const KEY = "rehearsal:splash-dismissed";

/** A minimal in-memory localStorage. jsdom's real one is not guaranteed to be
 *  an instance of `Storage` (vitest 4 can hand Node's built-in global
 *  instead), so the global is stubbed directly rather than via the prototype. */
function makeFakeStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const originalStorage = globalThis.localStorage;
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: makeFakeStorage(store),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalStorage,
  });
  vi.restoreAllMocks();
});

describe("splash dismissal", () => {
  it("is not dismissed before the visitor acts", () => {
    expect(hasDismissedSplash()).toBe(false);
  });

  it("is dismissed after dismissSplash", () => {
    dismissSplash();
    expect(hasDismissedSplash()).toBe(true);
    expect(store.get(KEY)).toBe("1");
  });

  it("never throws when localStorage is unavailable and reports not dismissed", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    expect(() => hasDismissedSplash()).not.toThrow();
    expect(() => dismissSplash()).not.toThrow();
    expect(hasDismissedSplash()).toBe(false);
  });
});

describe("clearSplashDismissal", () => {
  it("removes the dismissal flag", () => {
    dismissSplash();
    expect(hasDismissedSplash()).toBe(true);
    clearSplashDismissal();
    expect(hasDismissedSplash()).toBe(false);
    expect(store.get(KEY)).toBeUndefined();
  });

  it("is a silent no-op when the flag is already unset", () => {
    expect(() => clearSplashDismissal()).not.toThrow();
    expect(hasDismissedSplash()).toBe(false);
  });

  it("never throws when localStorage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    expect(() => clearSplashDismissal()).not.toThrow();
  });
});

describe("onShowIntroRequested / requestShowIntro", () => {
  it("fires every registered listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    onShowIntroRequested(a);
    onShowIntroRequested(b);
    requestShowIntro();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("the returned unsubscribe stops the listener", () => {
    const a = vi.fn();
    const off = onShowIntroRequested(a);
    requestShowIntro();
    expect(a).toHaveBeenCalledTimes(1);
    off();
    requestShowIntro();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("clearing the flag before requestShowIntro re-shows the intro on the next load", () => {
    const listener = vi.fn(() => {
      clearSplashDismissal();
    });
    onShowIntroRequested(listener);
    dismissSplash();
    requestShowIntro();
    expect(hasDismissedSplash()).toBe(false);
  });
});
