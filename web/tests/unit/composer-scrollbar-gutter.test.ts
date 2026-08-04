// Deletion guard for the composer caret/mirror drift fix.
//
// The real regression gate is the Playwright e2e in
// tests/e2e/composer-width-parity.spec.ts (it asserts the two layers share a
// clientWidth with a real space-taking scrollbar). This unit test catches ONLY
// accidental deletion of the `scrollbar-gutter: stable` declaration from the
// shared rule — it cannot catch a regression reintroduced by other means (e.g.
// a conflicting override, a width change elsewhere), because jsdom has no layout
// engine and cannot observe clientWidth. It exists so that removing the line
// fails fast in the cheap unit lane instead of only in e2e.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "../../src/styles/legacy/80-professional-pass.css");

describe("composer caret/mirror CSS contract", () => {
  it("reserves a stable scrollbar gutter on the SHARED composer layer rule", () => {
    const css = readFileSync(cssPath, "utf8");
    // The fix must live on the shared `.composer-mirror, .composer-text` rule
    // so the gutter is reserved on BOTH layers — putting it on only one layer
    // would reintroduce the drift. Match that specific selector block.
    const shared = css.match(/\.composer-mirror\s*,\s*\.composer-text\s*\{([^}]*)\}/);
    expect(shared, "shared .composer-mirror, .composer-text rule must exist").toBeTruthy();
    expect(shared![1], "shared rule must declare scrollbar-gutter: stable").toContain(
      "scrollbar-gutter: stable",
    );
  });
});
