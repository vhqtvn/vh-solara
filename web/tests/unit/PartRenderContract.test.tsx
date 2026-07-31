// @vitest-environment jsdom
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Import the shared stub BEFORE the component
// import is evaluated — see _matchMedia.ts.
import "./_matchMedia";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import PartView from "../../src/components/Part";
import type { Part } from "../../src/types";

// INV-7 render contract: every opencode part kind must render a defined,
// non-empty result. Before the fix, Part.tsx's Switch handled only text /
// reasoning / tool / file and silently dropped step-start, step-finish, patch,
// agent, retry, compaction (and any unknown kind) — those returned nothing and
// vanished from the transcript while the daemon still held them. This test
// mounts the dispatcher (PartView) once per kind in the canonical taxonomy
// (sourced from the live opencode DB: 9 observed types) plus the spec-named-but
// -unobserved snapshot/retry and a synthetic unknown kind, and asserts each
// produces non-empty DOM. No kind may render to nothing.

afterEach(() => {
  cleanup();
});

function mk(type: string, extra: Record<string, unknown> = {}): Part {
  return {
    id: `p-${type}`,
    sessionID: "s1",
    messageID: "m1",
    type,
    ...extra,
  } as Part;
}

// A part renders non-empty iff its container gains at least one element child
// (structural render) or non-whitespace text (prose/markdown). This is the
// INV-7 guarantee: nothing is silently dropped to a null/empty render.
function assertRendered(kind: string, part: Part) {
  const { container } = render(() => <PartView part={part} settled={true} />);
  const root = container as unknown as HTMLElement;
  const hasElement = root.querySelector("*") !== null;
  const text = (root.textContent || "").trim();
  if (!hasElement && text === "") {
    throw new Error(`part kind "${kind}" rendered empty (dropped) — INV-7 violation`);
  }
}

describe("INV-7 Part render contract — every kind renders, none dropped", () => {
  // Canonical taxonomy observed in the live opencode DB (1.58M parts):
  // tool, step-start, step-finish, text, reasoning, patch, file, compaction,
  // agent. Plus the structural markers. Each MUST render non-empty.
  it("renders the prose/content kinds (text, reasoning, tool, file) non-empty", () => {
    assertRendered("text", mk("text", { text: "hello world" }));
    assertRendered("reasoning", mk("reasoning", { text: "thinking…", time: { start: 1, end: 2 } }));
    assertRendered("tool", mk("tool", { tool: "bash", state: { status: "completed" } }));
    assertRendered("file", mk("file", { filename: "note.txt", mime: "text/plain" }));
  });

  it("renders the structural kinds previously dropped (step-start/finish, patch, agent, compaction) non-empty", () => {
    assertRendered("step-start", mk("step-start", { snapshot: {} }));
    assertRendered("step-finish", mk("step-finish", { cost: {}, reason: "", snapshot: {}, tokens: { input: 10, output: 20 } }));
    assertRendered("patch", mk("patch", { files: [{ path: "a.go" }, { path: "b.go" }], hash: "abc" }));
    assertRendered("agent", mk("agent", { name: "researcher" }));
    assertRendered("compaction", mk("compaction", { auto: true, overflow: false }));
  });

  it("renders a step-finish marker that surfaces token cost", () => {
    const { container } = render(() => (
      <PartView part={mk("step-finish", { tokens: { input: 1000, output: 2000 } })} settled={true} />
    ));
    const root = container as unknown as HTMLElement;
    const marker = root.querySelector('[data-kind="step-finish"]');
    expect(marker).not.toBeNull();
    // 1000 + 2000 = 3000 → "Step · 3,000 tok"
    expect((marker as HTMLElement).textContent || "").toContain("3,000");
  });

  it("renders a patch marker that surfaces the file count", () => {
    const { container } = render(() => (
      <PartView part={mk("patch", { files: [{}, {}, {}, {}] })} settled={true} />
    ));
    const root = container as unknown as HTMLElement;
    const marker = root.querySelector('[data-kind="patch"]');
    expect(marker).not.toBeNull();
    expect((marker as HTMLElement).textContent || "").toContain("4 files");
  });

  it("renders spec-named-but-unobserved kinds (snapshot, retry) via the catch-all — not dropped", () => {
    // `snapshot` is a KEY inside step-start/step-finish (not its own type) and
    // `retry` was absent from the live DB. If either ever appears as a type, the
    // catch-all renders it as a labeled marker instead of vanishing.
    assertRendered("snapshot", mk("snapshot"));
    assertRendered("retry", mk("retry"));
  });

  it("renders a genuinely unknown future kind via the catch-all — not dropped", () => {
    assertRendered("unknown-future-kind", mk("some-new-opencode-kind"));
    // The catch-all should label the marker with the actual type so the user can
    // see what arrived even if the renderer doesn't know it.
    const { container } = render(() => <PartView part={mk("some-new-opencode-kind")} settled={true} />);
    const root = container as unknown as HTMLElement;
    const marker = root.querySelector('[data-kind="some-new-opencode-kind"]');
    expect(marker).not.toBeNull();
    expect((marker as HTMLElement).textContent || "").toContain("some-new-opencode-kind");
  });
});

// ---------------------------------------------------------------------------
// INV-5 — client-side sequence-gap detection (SKIPPED: out of scope this slice)
// ---------------------------------------------------------------------------
// TODO(INV-5): the client sync layer (web/src/sync/*) does NOT detect a dropped
// part.upsert frame when the gap is under the ring threshold: feeding a
// part.upsert at seq=N then seq=N+2 (one dropped frame) leaves the cursor
// max-ratcheting N→N+2 with neither a gap signal nor a recovery fetch. This is
// a standing client-side GAP documented in the delivery-proof audit
// (invariants.md INV-5). It is OUT OF SCOPE for this slice because the fix
// requires changes to web/src/sync/* which are under concurrent in-flight work
// (a hard keep-out here). This test is written as the alarm (per
// standing-proof.md §4 item 2) but marked skip so the suite stays green while
// machine-documenting the gap. Un-skip + implement once the sync-layer work
// lands and exposes a hookable seam.
describe.skip("INV-5: a dropped part.upsert frame is detected or recovered", () => {
  it("would assert a seq=N → seq=N+2 gap is surfaced OR a recovery fetch fires", () => {
    // Intended assertion (blocked on web/src/sync/* API, which is in flux):
    //   feed the sync reducer a part.upsert at seq=N, then seq=N+2;
    //   assert EITHER a gap is detected (an error/notice) OR a recovery fetch
    //   is triggered. Today neither happens — the cursor silently advances.
    expect(true).toBe(true); // placeholder; real assertion lives behind the skip
  });
});
