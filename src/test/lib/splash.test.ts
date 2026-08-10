import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissSplash, hasDismissedSplash } from "../../lib/splash";

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
