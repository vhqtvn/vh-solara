import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The Solid plugin lets unit tests render components (.test.tsx); logic tests
  // (.test.ts, node env) are unaffected. Component tests opt into jsdom per-file
  // via a `// @vitest-environment jsdom` docblock.
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
