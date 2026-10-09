// @vitest-environment node
//
// Theme-catalog PARITY GUARD (mechanical — replaces hand-sync vigilance).
//
// Three surfaces are hand-synced around web/src/themeCatalog.ts (the shared
// single source of truth for BOTH SPAs' curated theme list):
//   1. the catalog itself (ids + light flags),
//   2. the `.theme-<id>` palette blocks in host-web/src/styles/tokens.css,
//   3. the inline pre-paint `ids` / light-marker lists in
//      host-web/index.html (the no-flash head script — a catalog id missing
//      there costs a one-paint flash; a wrong light entry costs wrong
//      shadows/color-scheme).
// This test fs-reads the two host-web files and asserts set equality against
// the catalog, so editing any one surface without the others fails
// `npm run test:unit` instead of shipping silent drift.
//
// It lives in web/tests/unit even though it guards host-web files: host-web
// has NO unit lane — web's vitest is the repo's only unit lane — and the
// default node environment makes plain fs reads fine here.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../../src/themeCatalog";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/tests/unit
const repoRoot = path.resolve(here, "..", "..", "..");
const TOKENS_PATH = path.join(repoRoot, "host-web", "src", "styles", "tokens.css");
const INDEX_HTML_PATH = path.join(repoRoot, "host-web", "index.html");

// Deliberately absent from BOTH host-web surfaces (documented in the
// tokens.css file header and the index.html script itself):
//  - "custom": the SPA's user-built theme — applied via inline CSS vars, no
//    palette block, never offered in the host picker;
//  - "dark": dark IS the host's :root default palette (there is deliberately
//    no .theme-dark block), and the pre-paint script guards
//    `id !== "dark"` separately, so the inline ids list omits it too.
const EXEMPT = new Set(["custom", "dark"]);

const catalogIds = THEMES.map((t) => t.id);
const expectedIds = new Set(catalogIds.filter((id) => !EXEMPT.has(id)));
const expectedLightIds = new Set(THEMES.filter((t) => t.light).map((t) => t.id));

/** Comma-wrapped inline list (",dim,midnight,…,") → ["dim","midnight",…]. */
function parseInlineList(raw: string): string[] {
  const body = raw.replace(/^,/, "").replace(/,$/, "");
  return body === "" ? [] : body.split(",");
}

const tokens = fs.readFileSync(TOKENS_PATH, "utf8");
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");

// `:root.theme-<id> {` palette blocks — the file's only .theme-* selectors
// (the `:root.host-theme-light` marker block does not match this shape).
const cssThemeIds = [...tokens.matchAll(/:root\.theme-([a-z0-9-]+)\s*\{/g)].map((m) => m[1]);

// The inline comma-wrapped lists: `var ids = ",…,";` for the full id set, and
// the `",…,".indexOf(` literal inside the light-marker branch for lightIds.
const idsLiteral = indexHtml.match(/var ids\s*=\s*"([^"]*)"/)?.[1];
const lightLiteral = indexHtml.match(/"(,[a-z0-9-]+(?:,[a-z0-9-]+)*,?)"\.indexOf\(/)?.[1];

describe("theme catalog ↔ host-web parity guard", () => {
  it("catalog ids are unique and the exemptions are real catalog entries", () => {
    expect(new Set(catalogIds).size, "no duplicate catalog ids").toBe(catalogIds.length);
    for (const id of EXEMPT) {
      expect(catalogIds, `"${id}" is still a catalog id (exemption is valid)`).toContain(id);
    }
  });

  it("every catalog theme (except custom/dark) has a :root.theme-<id> palette block — and no extras", () => {
    expect([...expectedIds].sort()).toEqual([...new Set(cssThemeIds)].sort());
  });

  it("the inline pre-paint ids list equals the catalog (except custom/dark) — no extras either way", () => {
    expect(idsLiteral, "host-web/index.html still declares `var ids = …`").toBeDefined();
    expect(parseInlineList(idsLiteral!).sort()).toEqual([...expectedIds].sort());
  });

  it("the inline lightIds list equals exactly the catalog ids flagged light", () => {
    expect(
      lightLiteral,
      "host-web/index.html still carries the `,light,…`.indexOf( lightIds literal",
    ).toBeDefined();
    expect(parseInlineList(lightLiteral!).sort()).toEqual([...expectedLightIds].sort());
  });
});
