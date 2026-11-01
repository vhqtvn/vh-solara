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

/** Sub-window of `src` starting at `marker` — scopes fixture assertions to
 *  the mirror under guard so a second quoted-name occurrence elsewhere in
 *  the file cannot mask a fixture-name drift. */
function scoped(src: string, marker: string, len = 600): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`parity guard: marker not found: ${marker}`);
  return src.slice(i, i + len);
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
    // Scoped to the `refined` initializer (the mirror under guard); the file
    // also quotes the bare name in its fallback-path case, which is NOT a
    // mirror and must not mask a fixture drift.
    const fixture = scoped(testMessageMeta, "const refined = {");
    expect(fixture).toContain(`name: "${ERROR_NAME}"`);
    expect(fixture).toContain(`"${USER_MESSAGE}"`);
  });

  it("ChatViewNeverStarted.test.tsx fixtures mirror the canonical pair", () => {
    // Name scoped to the mkNeverStarted factory (the file's other quoted
    // name is not a mirror); the message is pinned at the
    // GO_NEVER_STARTED_MESSAGE constant definition — the only place the
    // literal appears — which the factory feeds into data.message.
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
