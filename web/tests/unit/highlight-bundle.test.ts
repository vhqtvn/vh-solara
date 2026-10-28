// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pin the 2026-10-10 page-load fix: the SPA shell must NOT link
// /vh/highlight.css. Eight per-pane same-URL fetches of that link serialized
// inside the browser network stack (~one RTT per pane at 110ms RTT), gating
// each pane's JS boot and TTI (P0 diagnosis,
// docs/checkpoints/2026-10-11-page-load-perf-waterfall-closeout.md). The highlight CSS
// now ships inside the hashed app stylesheet via the generated artifact
// imported FIRST by src/index.tsx; its byte parity with the daemon's
// /vh/highlight.css handler is enforced by pkg/web/highlight_parity_test.go.
// Re-adding the per-pane link reintroduces the serialized fetch stair.

const shell = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const entry = readFileSync(new URL("../../src/index.tsx", import.meta.url), "utf8");

describe("highlight css bundling", () => {
  it("SPA shell does not link /vh/highlight.css", () => {
    // Match a <link> element referencing the per-pane stylesheet URL (not mere
    // prose mentions of the handler, which are fine in comments).
    expect(shell).not.toMatch(/<link\b[^>]*highlight\.css/);
    expect(shell).not.toContain('href="/vh/highlight.css"');
  });

  it("entry imports the generated highlight stylesheet", () => {
    expect(entry).toContain('import "./styles/highlight.generated.css";');
  });

  it("generated highlight stylesheet is the entry's first CSS import", () => {
    const cssImports = entry.match(/^import\s+"[^"]+\.css";$/gm) ?? [];
    expect(cssImports[0]).toBe('import "./styles/highlight.generated.css";');
  });
});
