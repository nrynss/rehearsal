import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Vitest runs with `globals: false` (imports are explicit), so Testing
 * Library cannot auto-register its afterEach cleanup — do it here.
 */
afterEach(() => {
  cleanup();
});
