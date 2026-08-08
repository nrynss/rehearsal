import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Test-only config. `vite build`/`dev` keep using vite.config.ts; vitest picks
 * this file up because it is named vitest.config.ts.
 *
 * No tailwind/svgr plugins here: component tests render into jsdom, which
 * never processes CSS, and no component imports an SVG.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
