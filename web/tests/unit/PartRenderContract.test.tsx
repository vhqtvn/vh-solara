// @vitest-environment jsdom
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Import the shared stub BEFORE the component
// import is evaluated — see _matchMedia.ts.
import "./_matchMedia";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import PartView from "../../src/components/Part";
import { einkProfile, setEinkProfile, setStreamLive, streamLive } from "../../src/prefs";
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

// ---------------------------------------------------------------------------
// E-ink display profile — settled-part streaming presentation
// ---------------------------------------------------------------------------
// While the profile is ON, a streaming markdown part is held back by default
// (the existing not-live-previewed path — the same presentation semantics as
// the saved block-by-block preference) behind a static accessible working
// indication, settles losslessly, and offers a profile-local live escape that
// must not touch the profile signal or the saved streamLive preference.
// Profile OFF must keep the historical behavior byte-identical: the same
// ~200ms live cadence with the pref on, the same empty hold-back with it off,
// and none of the profile UI. Cadence behavior is driven with fake timers
// (the FRAME_MS=200 coalesce window in Part.tsx MarkdownLive).
describe("e-ink profile — settled-part streaming presentation", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setEinkProfile(false);
    setStreamLive(true);
  });

  // Mount one streaming TEXT part whose text/settled state is driven
  // reactively — the way the chat store drives a part during a real stream.
  function mountStreamingText(id: string) {
    const [part, setPart] = createStore<Part>({
      id,
      sessionID: "s1",
      messageID: "m1",
      type: "text",
      text: "",
    } as Part);
    const [settled, setSettled] = createSignal(false);
    const res = render(() => <PartView part={part} settled={settled()} />);
    return { ...res, setPart, setSettled };
  }

  // Advance the streaming cadence by ms: let Solid's effects flush (they
  // schedule the FRAME_MS setTimeout on text change), then fire fake timers.
  const tick = async (ms: number) => {
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  };

  it("ON: streaming text is held back (no live churn) behind a static accessible working indication, and settles losslessly", async () => {
    vi.useFakeTimers();
    setStreamLive(true);
    setEinkProfile(true);
    const { container, setPart, setSettled } = mountStreamingText("eink-hold");

    // Held back from the first token: the working indication is mounted, the
    // live engine is not, and no streamed text is visible.
    const working = container.querySelector('[data-eink="working"]');
    expect(working).not.toBeNull();
    expect(container.querySelector(".md-stream")).toBeNull();
    // Static + accessible: a status role carrying plain text — legible with
    // animations disabled (the e-ink theme kill-switch), no motion needed.
    expect(working!.querySelector('[role="status"]')?.textContent).toContain("Working");

    // Deltas keep arriving (several cadence frames' worth of fake time) —
    // none may leak into the DOM: no live preview churn under the profile.
    setPart("text", "first chunk of a long reply");
    await tick(200);
    await tick(200);
    await tick(200);
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.textContent || "").not.toContain("first chunk");
    // …and the escape affordance is offered exactly here (profile-scoped).
    expect(container.querySelector('[data-eink="show-live"]')).not.toBeNull();

    // Lossless settle: the FULL text appears once the part settles (through
    // the existing settled presentation branch).
    setPart("text", "first chunk of a long reply and the final sentence");
    setSettled(true);
    await tick(1);
    expect(container.textContent || "").toContain("first chunk");
    expect(container.textContent || "").toContain("final sentence");
    // The indication is gone once settled.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
    expect(container.querySelector('[data-eink="show-live"]')).toBeNull();
  });

  it("ON: the live escape returns the live preview for that part without mutating the profile or saved streaming prefs", async () => {
    vi.useFakeTimers();
    setStreamLive(true);
    setEinkProfile(true);
    const savedBefore = localStorage.getItem("vh.prefs.streamLive.v1");
    const { container, setPart } = mountStreamingText("eink-escape");

    setPart("text", "streaming under the profile");
    await tick(250);
    expect(container.textContent || "").not.toContain("streaming under");

    // Real click on the escape affordance (Solid's delegated onClick).
    fireEvent.click(container.querySelector('[data-eink="show-live"]')!);

    // The live engine mounts for THIS part and the existing ~200ms cadence
    // renders the accumulated text.
    expect(container.querySelector(".md-stream")).not.toBeNull();
    await tick(250);
    expect(container.textContent || "").toContain("streaming under");

    // Profile-local: neither the profile nor the SAVED streaming preference
    // was written by the escape (byte-identical storage).
    expect(einkProfile()).toBe(true);
    expect(streamLive()).toBe(true);
    expect(localStorage.getItem("vh.prefs.streamLive.v1")).toBe(savedBefore);
  });

  it("ON: urgent surfaces are never deferred — a tool part renders its error state immediately while streaming", () => {
    setEinkProfile(true);
    // The hold-back gates ONLY the markdown live preview. Tool parts render
    // their status (including error) as soon as state arrives; questions and
    // permissions render outside PartView entirely (ChatView-level cards) and
    // never pass through the gate either.
    const { container } = render(() => (
      <PartView
        part={mk("tool", { tool: "bash", state: { status: "error", title: "command failed" } })}
        settled={false}
      />
    ));
    const tool = container.querySelector(".tool");
    expect(tool).not.toBeNull();
    expect(tool!.classList.contains("error")).toBe(true);
    expect(container.textContent || "").toContain("command failed");
    // The held-back markdown indication is a markdown-only surface: absent
    // for a tool part even under ON.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
  });

  it("ON with the streaming pref off: the profile's working indication still shows and the escape still works (profile-driven, not pref-driven)", async () => {
    vi.useFakeTimers();
    setEinkProfile(true);
    setStreamLive(false);
    const savedBefore = localStorage.getItem("vh.prefs.streamLive.v1");
    const { container, setPart } = mountStreamingText("eink-on-block");

    setPart("text", "held by both the pref and the profile");
    await tick(500);
    // Held back (no engine) behind the profile's indication + escape.
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.textContent || "").not.toContain("held by both");
    expect(container.querySelector('[data-eink="working"]')).not.toBeNull();
    expect(container.querySelector('[data-eink="show-live"]')).not.toBeNull();

    // The escape still works from here — and the saved pref (false) is never
    // rewritten by either the hold-back or the escape.
    fireEvent.click(container.querySelector('[data-eink="show-live"]')!);
    expect(container.querySelector(".md-stream")).not.toBeNull();
    await tick(250);
    expect(container.textContent || "").toContain("held by both");
    expect(streamLive()).toBe(false);
    expect(localStorage.getItem("vh.prefs.streamLive.v1")).toBe(savedBefore);
  });

  it("OFF: the live ~200ms cadence is unchanged and no profile UI exists", async () => {
    vi.useFakeTimers();
    setEinkProfile(false);
    setStreamLive(true);
    const { container, setPart } = mountStreamingText("eink-off-live");

    setPart("text", "alpha");
    await tick(250);
    expect(container.querySelector(".md-stream")).not.toBeNull();
    expect(container.textContent || "").toContain("alpha");

    // A later delta lands on a LATER cadence frame — coalescing preserved.
    setPart("text", "alpha beta");
    await tick(250);
    expect(container.textContent || "").toContain("beta");

    // Profile UI (indication + escape) exists only under the profile.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
    expect(container.querySelector('[data-eink="show-live"]')).toBeNull();
  });

  it("OFF with the streaming pref off: the block-by-block hold-back is unchanged (no profile UI)", async () => {
    vi.useFakeTimers();
    setEinkProfile(false);
    setStreamLive(false);
    const { container, setPart } = mountStreamingText("eink-off-block");

    setPart("text", "held block text");
    await tick(500);
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.textContent || "").not.toContain("held block text");
    // The e-ink indication/escape are profile-scoped: absent with it off —
    // OFF rendering stays byte-identical to the pre-profile behavior.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
    expect(container.querySelector('[data-eink="show-live"]')).toBeNull();
  });

  it("toggling the profile mid-stream flips the presentation reactively in both directions", async () => {
    vi.useFakeTimers();
    setStreamLive(true);
    setEinkProfile(false);
    const { container, setPart } = mountStreamingText("eink-midflip");

    setPart("text", "live before the flip");
    await tick(250);
    expect(container.querySelector(".md-stream")).not.toBeNull();

    // Profile on (the Settings/cross-tab path — the same signal): the engine
    // unmounts, the held-back indication mounts.
    setEinkProfile(true);
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector('[data-eink="working"]')).not.toBeNull();

    // Profile off again: back to the live engine (the escape was never used).
    setEinkProfile(false);
    expect(container.querySelector(".md-stream")).not.toBeNull();
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
  });
});
