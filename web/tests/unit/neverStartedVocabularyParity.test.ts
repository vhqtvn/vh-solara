// @vitest-environment node
//
// Never-started vocabulary PARITY GUARD (mechanical — replaces hand-sync
// vigilance).
//
// The P1 never-started vocabulary is hand-mirrored across surfaces with no
// compiler keeping them together:
//   1. the Go canonical constants (pkg/state/never_started.go — the single
//      source of truth: NeverStartedErrorName + neverStartedUserMessage),
//   2. the FE fallback literals (web/src/components/chat/messageMeta.ts),
//   3. the fixtures in web/tests/unit/messageMeta.test.ts and
//      web/tests/unit/ChatViewNeverStarted.test.tsx (hand-built rows that
//      must keep matching the real classifier output).
// This test fs-reads every surface and asserts they all carry the same
// name+message pair, so editing any ONE of them alone fails
// `npm run test:unit` instead of shipping silent drift. It also pins the
// LIVE messageMeta behavior (neverStartedNotice falls back to the canonical
// text when a row carries the name without data.message), which is the path
// real rows take when the FE fallback actually matters.
//
// One declared FE-only literal is pinned as such: the MessageRow tooltip
// title ("OpenCode aborted this turn before it started — not your stop.").
// It is presentation-only (a shortened tooltip phrasing with no Go
// counterpart and no parity surface to drift against), so it is asserted as
// a fixed literal rather than derived from the canonical message.
//
// It lives in web/tests/unit and fs-reads files outside web/ — the default
// node environment makes plain fs reads fine here (same posture as
// themeCatalogParity.test.ts).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER_STARTED_ERROR_NAME, neverStartedNotice } from "../../src/components/chat/messageMeta";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/tests/unit
const repoRoot = path.resolve(here, "..", "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(repoRoot, ...p), "utf8");

const goNeverStarted = read("pkg", "state", "never_started.go");
const feMessageMeta = read("web", "src", "components", "chat", "messageMeta.ts");
const feMessageRow = read("web", "src", "components", "chat", "MessageRow.tsx");
const testMessageMeta = read("web", "tests", "unit", "messageMeta.test.ts");
const testChatView = read("web", "tests", "unit", "ChatViewNeverStarted.test.tsx");

// The canonical vocabulary (single source of truth: Go's
// neverStartedUserMessage — byte-identical everywhere, em-dash included).
const ERROR_NAME = "VHSolaraNeverStartedError";
const USER_MESSAGE =
  "Turn never ran: OpenCode aborted this turn before it started — this was not your stop. Re-sending will likely repeat this.";
// Declared FE-only literal (see header): the MessageRow tooltip phrasing.
const FE_ONLY_TITLE = "OpenCode aborted this turn before it started — not your stop.";

/** Sub-window of `src` from `marker` through the STRUCTURALLY matching close
 *  brace of the first block opened at/after the marker — scopes fixture
 *  assertions to the mirror under guard so a second quoted-name occurrence
 *  elsewhere in the file cannot mask a fixture-name drift. Bounds are
 *  structural, not a fixed byte length: formatting changes inside the fixture
 *  (extra line wraps, spacing, reordering) cannot false-break the window, and
 *  a missing/unbalanced block throws (fail-closed) instead of passing
 *  vacuously. The brace scanner skips string/template literals (honoring
 *  escapes) and line comments so quoted or commented braces never move the
 *  depth. Not parsed — and absent from the two scanned windows (the source
 *  FILES are not so guaranteed; messageMeta.test.ts carries a regex literal
 *  outside its window): regex literals, block comments, and ${…} template
 *  interpolation. */
function scoped(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`parity guard: marker not found: ${marker}`);
  const open = src.indexOf("{", start);
  if (open < 0) throw new Error(`parity guard: no block opens after marker: ${marker}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++; // skip the escaped char
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`parity guard: unbalanced block after marker: ${marker}`);
}

describe("never-started vocabulary parity (Go canonical ↔ FE fallback ↔ test mirrors)", () => {
  it("Go canonical carries the name and user message", () => {
    expect(goNeverStarted).toContain(`NeverStartedErrorName = "${ERROR_NAME}"`);
    expect(goNeverStarted).toContain(`"${USER_MESSAGE}"`);
  });

  it("FE fallback in messageMeta.ts carries the same name and message", () => {
    expect(feMessageMeta).toContain(`NEVER_STARTED_ERROR_NAME = "${ERROR_NAME}"`);
    expect(feMessageMeta).toContain(`"${USER_MESSAGE}"`);
    expect(NEVER_STARTED_ERROR_NAME).toBe(ERROR_NAME);
  });

  it("messageMeta.test.ts fixtures mirror the canonical pair", () => {
    // Scoped to the `refined` initializer — marker through its matching
    // close brace (the mirror under guard); the file also quotes the bare
    // name in its fallback-path case, which is NOT a mirror and must not
    // mask a fixture drift.
    const fixture = scoped(testMessageMeta, "const refined = {");
    expect(fixture).toContain(`name: "${ERROR_NAME}"`);
    expect(fixture).toContain(`"${USER_MESSAGE}"`);
  });

  it("ChatViewNeverStarted.test.tsx fixtures mirror the canonical pair", () => {
    // Name scoped to the mkNeverStarted factory — marker through its
    // matching close brace (the file's other quoted name is not a mirror);
    // the message is pinned at the GO_NEVER_STARTED_MESSAGE constant
    // definition — the only place the literal appears — which the factory
    // feeds into data.message.
    const factory = scoped(testChatView, "const mkNeverStarted");
    expect(factory).toContain(`name: "${ERROR_NAME}"`);
    expect(testChatView).toContain(`"${USER_MESSAGE}"`);
  });

  it("live fallback: neverStartedNotice returns the canonical message for a name-only row", () => {
    expect(neverStartedNotice({ error: { name: ERROR_NAME } })).toBe(USER_MESSAGE);
    // data.message (the classifier-refined payload) still wins over the fallback.
    expect(neverStartedNotice({ error: { name: ERROR_NAME, data: { message: "x" } } })).toBe("x");
    expect(neverStartedNotice({ error: { name: "OtherError" } })).toBeNull();
  });

  it("MessageRow tooltip title stays the declared FE-only literal", () => {
    expect(feMessageRow).toContain(`"${FE_ONLY_TITLE}"`);
  });
});

describe("scoped() window extraction (self-test)", () => {
  // Committed stand-in for the run-once mutation evidence recorded in a4a2ff9:
  // these synthetic-string cases (no file reads, no mutation) pin the
  // scanner's contract so a future edit that loosens any property fails HERE
  // instead of silently widening/narrowing the parity windows above.
  // Deliberately NOT pinned: regex literals, block comments, and ${…}
  // interpolation — the scanner's doc above declares them absent; pinning
  // them would pin non-behavior.

  it("(a) padding-resistance: window spans whitespace/comment padding to the structural close", () => {
    const src = [
      "const before = 0;",
      "const target = {", // marker + first block open
      "  name: 1,",
      "", // whitespace padding
      "  // comment padding",
      "  mid: 2,", // literal far from the marker, deep in the block
      "",
      "  tail: 3,",
      "};",
      "const after = 9;",
    ].join("\n");
    const win = scoped(src, "const target = {");
    expect(win.startsWith("const target = {")).toBe(true); // starts at the marker
    expect(win).toContain("tail: 3"); // reaches the far literal…
    expect(win.endsWith("}")).toBe(true); // …through the structural close (inclusive brace, exclusive what follows)
    expect(win).not.toContain("const after"); // and stops there
  });

  it("(b) anti-masking: a bare target literal AFTER the block's close is not in the window", () => {
    const src = [
      "const fixture = {",
      '  name: "INSIDE",',
      "};",
      'const elsewhere = { name: "MASKER" };', // same-shaped literal OUTSIDE — must not mask
    ].join("\n");
    const win = scoped(src, "const fixture = {");
    expect(win).toContain("INSIDE");
    expect(win).not.toContain("MASKER"); // window ends at the block close: later content can't satisfy assertions
  });

  it("(c) throws on all three fail-closed paths", () => {
    // Missing marker.
    expect(() => scoped("const a = { ok: 1 };\n", "no such marker")).toThrow("marker not found");
    // Marker present, but no block opens after it.
    expect(() => scoped("const target = 1;", "const target")).toThrow("no block opens after marker");
    // Block opens but never closes.
    expect(() => scoped("const target = { a: 1,", "const target")).toThrow("unbalanced block");
  });

  it("(d) lexical skipping: a '}' inside a string and a '// {' comment do not move depth", () => {
    const src = [
      "const target = {", // marker + real open (depth 1)
      '  s1: "escaped \\"q\\" then } stays inside",', // '}' in a string (escape honored) — not a close
      "  // comment with an open { that is not a brace", // '{' in a line comment — not an open
      "  afterBoth: 2,", // survives both fake braces: depth still 1
      "};", // the REAL depth-0 close
      'const after = "SENTINEL_AFTER_CLOSE";',
    ].join("\n");
    const win = scoped(src, "const target = {");
    expect(win).toContain("afterBoth: 2"); // the string '}' did not close the block early
    expect(win.endsWith("}")).toBe(true); // the comment '{' did not add depth — closes at the real depth-0 brace
    expect(win).not.toContain("SENTINEL_AFTER_CLOSE"); // closed at the real depth-0 brace
  });
});
