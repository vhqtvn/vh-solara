// @vitest-environment jsdom
// jsdom doesn't implement matchMedia, but Part.tsx → code/frame → layout calls
// window.matchMedia at module load. Import the shared stub BEFORE the component
// import is evaluated — see _matchMedia.ts (same discipline as
// PartRenderContract.test.tsx).
import "./_matchMedia";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import PartView from "../../src/components/Part";
import { MessageParts } from "../../src/components/chat/MessageParts";
import { buildMessages } from "../../src/lib/reduce";
import type { Part } from "../../src/types";

// Cold-load orphan tail — the RENDER side of the 2026-08-20 dead-instance fix.
//
// A session whose opencode instance died mid-generation keeps an orphaned last
// assistant message forever: no time.completed, and a reasoning part with
// time.start but no time.end. The store-side fix (cross-stream completion
// bridge, arrival-path #3 — see crossStreamCompletion.test.ts) stamps a
// message-level terminal when the transcript becomes resident while the
// session is authoritatively idle. These tests pin the OBSERVABLE render
// contract that acceptance demands:
//   - the orphan tail renders SETTLED: no `.md-stream` (full markdown render
//     path), no `.stream-caret`, and NO ticking ReasoningPart timer;
//   - a reasoning part that is settled with no time.end shows NO duration
//     (the true duration is unknown — a frozen page-load−start delta would be
//     fabricated data that grows on every reload);
//   - a genuinely live reasoning part (unsettled, no end) still ticks — the
//     live-streaming path is not weakened.

// jsdom lacks ResizeObserver (the expanded tail reasoning body observes its
// content). Same no-op stub discipline as ChatViewPartlessMessage.test.tsx.
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The dead-instance reasoning part: start stamped, end missing forever.
function orphanReasoning(id: string, start: number): Part {
  return {
    id,
    sessionID: "s1",
    messageID: "m1",
    type: "reasoning",
    text: "half a thought",
    time: { start },
  } as Part;
}

describe("ReasoningPart — settled orphan (no time.end)", () => {
  it("renders NO duration for a settled reasoning part with no end (unknown, not a frozen bogus delta)", () => {
    // start far in the past: pre-fix, elapsed() fell back to the frozen
    // `now`-at-creation signal and rendered a huge "Nm Ns" string.
    const { container } = render(() => (
      <PartView part={orphanReasoning("pr-settled", 1_000_000)} settled={true} />
    ));
    expect(container.querySelector(".tool-dur")).toBeNull();
    expect(container.querySelector(".reasoning-time")).toBeNull();
    // settled ⇒ the full-markdown branch, not the live streaming engine.
    expect(container.querySelector(".md-stream")).toBeNull();
  });

  it("ticks + shows a live duration while unsettled (live path unchanged), then STOPS and hides when settled flips", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const [settled, setSettled] = createSignal(false);
    const start = Date.now() - 5000; // 5s ago
    const { container } = render(() => (
      <PartView part={orphanReasoning("pr-flip", start)} settled={settled()} />
    ));

    // LIVE: duration shown with the .live class, and it TICKS.
    const dur = () => container.querySelector(".tool-dur");
    expect(dur()).not.toBeNull();
    expect(dur()?.classList.contains("live")).toBe(true);
    expect(dur()?.textContent).toMatch(/5s/);
    vi.advanceTimersByTime(3000);
    expect(dur()?.textContent).toMatch(/8s/);

    // The bridge stamp lands (activity-idle → settled in the same flush):
    // the timer stops and the unknown duration disappears entirely.
    setSettled(true);
    expect(dur()).toBeNull();
    const after = dur();
    vi.advanceTimersByTime(60000);
    // still gone — no resurrection on a later tick.
    expect(container.querySelector(".tool-dur")).toBeNull();
    expect(after).toBeNull();
  });
});

describe("MessageParts — orphan tail record (post-stamp) renders settled", () => {
  // The orphan shape AFTER the arrival-path #3 stamp: message-level
  // time.completed present (stamped by the bridge), reasoning part still
  // end-less (never fabricated).
  const stampedOrphan = () =>
    buildMessages([
      {
        info: { id: "mUser", sessionID: "s1", role: "user", time: { created: 10 } },
        parts: [{ id: "pu", sessionID: "s1", messageID: "mUser", type: "text", text: "go" }],
      },
      {
        info: { id: "mOrphan", sessionID: "s1", role: "assistant", time: { created: 20, completed: 21 } },
        parts: [orphanReasoning("pr", 20)],
      },
    ]);

  it("no stream caret, no streaming engine, no reasoning duration on the settled orphan tail", () => {
    const { container } = render(() => (
      <MessageParts
        m={stampedOrphan().byId["mOrphan"]}
        isLastMessage={() => true}
        lastActivityKey={() => null}
        failed={() => false}
      />
    ));
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector(".stream-caret")).toBeNull();
    expect(container.querySelector(".tool-dur")).toBeNull();
  });

  it("negative control: the UNstamped orphan tail (no completed) still renders the live streaming view + caret", async () => {
    // This is the pre-fix bug shape pinned as the control: without the bridge
    // stamp (record still lacking time.completed), the tail renders live —
    // proving the fix lives in the stamp, not in a render-side heuristic.
    const sm = buildMessages([
      {
        info: { id: "mUser", sessionID: "s1", role: "user", time: { created: 10 } },
        parts: [{ id: "pu", sessionID: "s1", messageID: "mUser", type: "text", text: "go" }],
      },
      {
        info: { id: "mOrphan", sessionID: "s1", role: "assistant", time: { created: 20 } },
        parts: [orphanReasoning("pr-live", 20)],
      },
    ]);
    const { container } = render(() => (
      <MessageParts
        m={sm.byId["mOrphan"]}
        isLastMessage={() => true}
        lastActivityKey={() => null}
        failed={() => false}
      />
    ));
    expect(container.querySelector(".md-stream")).not.toBeNull();
    expect(container.querySelector(".tool-dur.live")).not.toBeNull();
    // The caret is placed by the coalesced streaming flush (~200ms frame).
    await new Promise((r) => setTimeout(r, 260));
    expect(container.querySelector(".stream-caret")).not.toBeNull();
  });
});
