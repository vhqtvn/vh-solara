// @vitest-environment node
//
// CROSS-TREE IMPORT GUARD (host-web → web/).
//
// Background: host-web/src/theme.ts imports the SPA's curated theme catalog
// via `../../web/src/themeCatalog` — the ONE sanctioned host-web → web/
// cross-tree import. The repo's two docker build stages (repo-root Dockerfile
// and Dockerfile.e2e) have no web/ tree in their hostbuild stage, so that
// import only works there because both Dockerfiles explicitly
// `COPY web/src/themeCatalog.ts ./web/src/` (e726b4e for Dockerfile.e2e,
// 274b25e for Dockerfile). A NEW cross-tree import added under host-web/src
// stays green in every local lane (the file exists in a checkout) and only
// breaks the docker image at build time. This test is the tripwire: it fails
// `npm run test:unit` the moment a second host-web → web/ import appears.
//
// Approach (deliberately cheap — regex over source text, no parser, no
// typecheck dependency):
//   * scans ONLY .ts/.tsx files under host-web/src/ — host-web/vite.config.ts
//     lives at host-web/ root, outside src/, so its comment-only `../../web/src`
//     occurrence (line 30) is out of scope by construction;
//   * flags import / export-from / dynamic-import specifiers CONTAINING
//     `../../web/` — a substring test, so files deeper in host-web/src (whose
//     escape into repo-root web/ is `../../../web/`) are caught too;
//   * comments are blanked before matching (length-preserving so line numbers
//     stay exact, and string-literal-aware so `"https://…"` strings do not
//     open a comment), so commented-out imports do not false-positive;
//   * only the host-web → web/ direction is guarded (the reverse direction
//     never broke a build).
//
// Known limitations (sane for a guard, disclosed here): regex literals are
// not lexed (a pathological regex containing `//` or `/*` could mis-blank a
// line), nested template-literal interpolation is treated naively, and
// non-import forms such as require() are not scanned. The failure mode of a
// false positive is one human look at the named file — never silence.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/tests/unit
// import.meta.url-anchored (NOT process.cwd) so the test passes from any
// invocation directory — same convention as themeCatalogParity.test.ts.
const repoRoot = path.resolve(here, "..", "..", "..");
const HOST_WEB_SRC = path.join(repoRoot, "host-web", "src");

/**
 * The complete sanctioned-exception list for host-web → web/ cross-tree
 * imports. Every entry MUST have a matching `COPY <repo-path> ./web/src/`
 * line in BOTH repo-root Dockerfiles (asserted below), because the docker
 * hostbuild stages have no web/ tree otherwise.
 */
const SANCTIONED_CROSS_TREE_IMPORTS: ReadonlyArray<{ file: string; spec: string }> = [
  { file: "host-web/src/theme.ts", spec: "../../web/src/themeCatalog" },
];

/** A specifier "escapes into web/" if it reaches repo-root web/ from ANY
 * depth under host-web/src: `../../web/` (files directly in src) and its
 * superstrings (`../../../web/` from src subdirs) all contain this. */
const CROSS_TREE = /\.\.\/\.\.\/web\//;

type Hit = { file: string; line: number; spec: string; form: string };

/** Blank line comments and block comments with spaces (newlines and LENGTH
 * preserved so match indices map 1:1 back to the original text), while
 * leaving string literals intact — a `//` inside "…" or '…' or `…` must not
 * open a comment, and quotes inside comments must not open a string. */
function blankComments(src: string): string {
  const out = src.split("");
  type Mode = "code" | "line" | "block" | "str";
  let mode: Mode = "code";
  let quote = ""; // which quote opened "str" mode
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "str";
        quote = c;
      }
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    // "str": keep contents verbatim (specifiers live here); an escape
    // sequence skips its char too so `\"` cannot close the string.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) mode = "code";
    i++;
  }
  return out.join("");
}

/** 1-based line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Import forms whose specifier we check. matchAll iterates a clone of each
 * regex, so module-level lastIndex stays 0 across calls.
 *
 * Deliberately NOT scanned: require(), non-literal dynamic imports built by
 * concatenation, and web/→host-web (reverse direction, never broke a build).
 */
const FORMS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  // import <clause> from "…"  — covers `import {x} from`, `import type {x}
  // from`, `import * as ns from`, multiline clauses.
  { kind: "import", re: /\bimport\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g },
  // import "…"  — side-effect import.
  { kind: "import (side-effect)", re: /\bimport\s*['"]([^'"]+)['"]/g },
  // export <clause> from "…"  — covers `export {x} from`, `export type {x}
  // from`, `export * from`.
  { kind: "export-from", re: /\bexport\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g },
  // dynamic import with a plain string or template literal (interpolation is
  // still caught — `${…}` inside the capture does not hide the path prefix).
  { kind: "dynamic import", re: /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g },
];

/** Scan one source text; returns cross-tree hits sorted by line. The input is
 * treated as ORIGINAL text (comment blanking happens inside). */
function scanText(text: string): Array<{ line: number; spec: string; form: string }> {
  const stripped = blankComments(text);
  const hits: Array<{ line: number; spec: string; form: string }> = [];
  for (const form of FORMS) {
    for (const m of stripped.matchAll(form.re)) {
      // form 4 captures the quote in m[1] and the specifier in m[2]; forms
      // 1–3 capture the specifier in m[1]. Normalize:
      const spec = form.kind === "dynamic import" ? m[2] : m[1];
      if (spec == null || m.index == null) continue;
      if (CROSS_TREE.test(spec)) {
        hits.push({ line: lineOf(stripped, m.index), spec, form: form.kind });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Recursively collect .ts/.tsx files under `dir` (deterministic order). */
function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSources(p));
    else if (ent.isFile() && /\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Live scan of host-web/src — repo-relative file paths in the hits. */
function scanHostWebSrc(): Hit[] {
  const hits: Hit[] = [];
  for (const abs of walkSources(HOST_WEB_SRC)) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
    const text = fs.readFileSync(abs, "utf8");
    for (const h of scanText(text)) hits.push({ file: rel, ...h });
  }
  return hits;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Dockerfile side of the contract: every sanctioned import's target file
 * must be COPYed into the docker hostbuild stage — in BOTH repo Dockerfiles.
 * `../../web/src/themeCatalog` → `web/src/themeCatalog.ts` (TS ESM `.js`
 * specifiers are mapped to their `.ts` source).
 */
function dockerfileProblems(dfName: string, content: string): string[] {
  const problems: string[] = [];
  for (const s of SANCTIONED_CROSS_TREE_IMPORTS) {
    const copySrc = s.spec.replace(/^\.\.\/\.\.\//, "").replace(/\.js$/, "") + ".ts";
    const copyRe = new RegExp(`^COPY\\s+${escapeRe(copySrc)}\\s`, "m");
    if (!copyRe.test(content)) {
      problems.push(
        `${dfName} is missing \`COPY ${copySrc} ./web/src/\` — the sanctioned ` +
          `import ${s.file} → ${s.spec} breaks the docker hostbuild stage ` +
          `without it (see e726b4e / 274b25e for the pattern).`,
      );
    }
  }
  return problems;
}

/**
 * Derivation seam: hits (from the live scan OR synthetic) → problem strings.
 * Pure so the drift branch is unit-pinnable (see the self-check below)
 * without touching the real theme.ts.
 */
function crossTreeProblems(hits: Hit[]): string[] {
  const problems: string[] = [];

  // (a) anything beyond the sanctioned list is a violation
  const unsanctioned = hits.filter(
    (h) => !SANCTIONED_CROSS_TREE_IMPORTS.some((s) => s.file === h.file && s.spec === h.spec),
  );
  if (unsanctioned.length > 0) {
    problems.push(
      [
        "New host-web → web/ cross-tree import(s) detected:",
        "",
        ...unsanctioned.map((h) => `  ${h.file}:${h.line}: ${h.spec}  (${h.form})`),
        "",
        "host-web must stay self-contained except for the sanctioned list:",
        ...SANCTIONED_CROSS_TREE_IMPORTS.map((s) => `  - ${s.file} → ${s.spec}`),
        "",
        "Local lanes stay green while the docker image breaks: the docker",
        "hostbuild stage has no web/ tree unless it is COPYed in. For each",
        "violation either:",
        "  1. REMOVE the import (preferred — keep host-web self-contained), or",
        "  2. add the matching COPY line to BOTH docker files — repo-root",
        "     Dockerfile AND Dockerfile.e2e (see the existing",
        "     `COPY web/src/themeCatalog.ts ./web/src/` lines) — AND extend",
        "     SANCTIONED_CROSS_TREE_IMPORTS in this test.",
      ].join("\n"),
    );
  }

  // (b) drift: a sanctioned entry that no longer matches must also fail —
  // the exception list and the two Dockerfile COPY lines travel together.
  const drifted = SANCTIONED_CROSS_TREE_IMPORTS.filter(
    (s) => !hits.some((h) => s.file === h.file && s.spec === h.spec),
  );
  if (drifted.length > 0) {
    problems.push(
      [
        "sanctioned cross-tree import changed — update this exception list AND both Dockerfile COPY lines (Dockerfile, Dockerfile.e2e)",
        ...drifted.map((s) => `  no longer found: ${s.file} → ${s.spec}`),
        "",
        "If the import moved or changed path, update SANCTIONED_CROSS_TREE_IMPORTS",
        "above and re-check that BOTH Dockerfile and Dockerfile.e2e still COPY",
        "the right file (the companion assertion in this file checks that).",
      ].join("\n"),
    );
  }

  return problems;
}

describe("host-web → web/ cross-tree import guard", () => {
  it("host-web/src contains only the sanctioned cross-tree imports into web/", () => {
    expect(crossTreeProblems(scanHostWebSrc())).toEqual([]);
  });

  it("both Dockerfiles COPY every sanctioned cross-tree file into the hostbuild stage", () => {
    const problems = ["Dockerfile", "Dockerfile.e2e"].flatMap((df) =>
      dockerfileProblems(df, fs.readFileSync(path.join(repoRoot, df), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  // Synthetic self-checks: pin the matcher itself so the live guard above
  // can never silently rot (deterministic red proofs for the scan logic).
  describe("matcher self-check (synthetic sources)", () => {
    it("flags a plain static import escaping into web/", () => {
      expect(scanText('import { x } from "../../web/src/foo";')).toEqual([
        { line: 1, spec: "../../web/src/foo", form: "import" },
      ]);
    });

    it("flags export-from, dynamic (string + template), and deeper-depth escapes with exact lines", () => {
      const src = [
        "// header comment mentioning ../../web/src/themeCatalog.ts (must not flag)",
        'export { x } from "../../web/src/foo";',
        'const m = await import("../../web/src/bar");',
        "const t = await import(`../../web/src/baz`);",
        'import { deep } from "../../../web/src/qux";',
      ].join("\n");
      expect(scanText(src)).toEqual([
        { line: 2, spec: "../../web/src/foo", form: "export-from" },
        { line: 3, spec: "../../web/src/bar", form: "dynamic import" },
        { line: 4, spec: "../../web/src/baz", form: "dynamic import" },
        { line: 5, spec: "../../../web/src/qux", form: "import" },
      ]);
    });

    it("does not flag comment-only occurrences (the host-web/vite.config.ts:30 class)", () => {
      const src = [
        "// tree (src/theme.ts → ../../web/src/themeCatalog.ts). Vite's default",
        '/* import { x } from "../../web/src/foo"; */',
        'import { y } from "./local";',
      ].join("\n");
      expect(scanText(src)).toEqual([]);
    });

    it("does not flag non-web escapes, plain strings, or side-effect-local imports", () => {
      const src = [
        'const s = "../../web/src/notAnImport";',
        'import a from "../../pkg/x";',
        'import "./side-effect-local";',
        "const u = 'https://example.com//not-a-comment';",
      ].join("\n");
      expect(scanText(src)).toEqual([]);
    });

    it("dockerfileProblems fails a Dockerfile missing the COPY line", () => {
      expect(dockerfileProblems("Dockerfile", "FROM scratch\nRUN nothing\n")).toHaveLength(1);
      expect(
        dockerfileProblems("Dockerfile.e2e", "COPY web/src/themeCatalog.ts ./web/src/\n"),
      ).toEqual([]);
    });

    it("crossTreeProblems: sanctioned hit passes; missing/changed entry fires the DRIFT path", () => {
      const sanctionedHit: Hit = {
        file: "host-web/src/theme.ts",
        line: 25,
        spec: "../../web/src/themeCatalog",
        form: "import",
      };

      // Exact sanctioned hit → clean.
      expect(crossTreeProblems([sanctionedHit])).toEqual([]);

      // Sanctioned entry gone entirely → exactly the drift problem, with the
      // card-prescribed message naming BOTH Dockerfiles.
      const gone = crossTreeProblems([]);
      expect(gone).toHaveLength(1);
      expect(gone[0]).toContain(
        "sanctioned cross-tree import changed — update this exception list AND both Dockerfile COPY lines (Dockerfile, Dockerfile.e2e)",
      );
      expect(gone[0]).toContain("no longer found: host-web/src/theme.ts → ../../web/src/themeCatalog");

      // Spec changed → BOTH halves fire: the new spec is unsanctioned AND the
      // old sanctioned spec has drifted. This is the regression pin for the
      // spec-level drift comparison — a self-comparing `s.spec === s.spec`
      // yields only the unsanctioned half (length 1), missing the drift.
      const changed = crossTreeProblems([{ ...sanctionedHit, spec: "../../web/src/themeCatalogX" }]);
      expect(changed).toHaveLength(2);
      expect(changed[0]).toContain("New host-web → web/ cross-tree import(s) detected:");
      expect(changed[0]).toContain("host-web/src/theme.ts:25: ../../web/src/themeCatalogX");
      expect(changed[1]).toContain("sanctioned cross-tree import changed");
      expect(changed[1]).toContain("no longer found: host-web/src/theme.ts → ../../web/src/themeCatalog");
    });
  });
});
