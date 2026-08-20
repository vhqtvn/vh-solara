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

// Mid-history orphans — POSITIONAL settlement (option O-C of the 2026-08-20
// brief). The bridge above stamps only the LAST assistant message, so an
// incomplete assistant that is NO LONGER the newest in its transcript (the
// generating instance died, the session resumed with a later message) never
// receives an authoritative terminal — and pre-fix it ticked its ReasoningPart
// timer and streamed its caret forever. The fix is pure computation at this
// seam: an assistant message that is currently NOT the last renders settled.
// Nothing is written (no time.completed, no part time.end, no cache), so the
// presentation honestly reverses when ordering changes (revert/delete making
// the orphan newest again). These tests pin both directions of that flip.
describe("MessageParts — positional settlement of mid-history orphans (O-C)", () => {
  const ORPHAN_TEXT = "half an answer";
  // The mid-history orphan shape: incomplete assistant (no time.completed, no
  // part time.end) sandwiched between two user messages in `order`.
  function midHistorySession(reasoningStart: number, extraLatePart = false) {
    const orphanParts: Part[] = [
      { id: "pt-mid", sessionID: "s1", messageID: "mOrphan", type: "text", text: ORPHAN_TEXT } as Part,
      orphanReasoning("pr-mid", reasoningStart),
    ];
    // Test 7 only: a late part arrives on the same message id after the row
    // is already mid-history (the dying instance's final flush).
    if (extraLatePart)
      orphanParts.push({ id: "pt-late", sessionID: "s1", messageID: "mOrphan", type: "text", text: "late delta arrived" } as Part);
    return buildMessages([
      {
        info: { id: "mUser1", sessionID: "s1", role: "user", time: { created: 10 } },
        parts: [{ id: "pu1", sessionID: "s1", messageID: "mUser1", type: "text", text: "go" }],
      },
      {
        info: { id: "mOrphan", sessionID: "s1", role: "assistant", time: { created: 20 } },
        parts: orphanParts,
      },
      {
        info: { id: "mUser2", sessionID: "s1", role: "user", time: { created: 30 } },
        parts: [{ id: "pu2", sessionID: "s1", messageID: "mUser2", type: "text", text: "again" }],
      },
    ]);
  }

  it("incomplete NON-LAST assistant renders settled: no streaming engine, no caret, no ticking reasoning timer", () => {
    const sm = midHistorySession(20);
    const { container } = render(() => (
      <MessageParts
        m={sm.byId["mOrphan"]}
        isLastMessage={() => false}
        lastActivityKey={() => null}
        failed={() => false}
      />
    ));
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector(".stream-caret")).toBeNull();
    expect(container.querySelector(".tool-dur")).toBeNull();
    // Settled ≠ blank: the row still renders its content, final-shaped.
    expect(container.textContent).toContain(ORPHAN_TEXT);
  });

  it("negative control: the SAME incomplete assistant as the NEWEST message stays live", async () => {
    const sm = midHistorySession(20);
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
    await new Promise((r) => setTimeout(r, 260));
    expect(container.querySelector(".stream-caret")).not.toBeNull();
  });

  it("reactive non-last → last (revert/delete removes newer rows) restores the live streaming presentation", async () => {
    // Fake only the reasoning timer clock — the markdown flush runs on real
    // setTimeout/performance (same toFake set as the ReasoningPart flip test
    // above), so the 260ms caret wait below stays real-time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const sm = midHistorySession(Date.now() - 5000);
    const [isLast, setLast] = createSignal(false);
    const { container } = render(() => (
      <MessageParts
        m={sm.byId["mOrphan"]}
        isLastMessage={isLast}
        lastActivityKey={() => null}
        failed={() => false}
      />
    ));
    // Mid-history: settled — no streaming affordances at all.
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector(".tool-dur")).toBeNull();

    // The newer rows are deleted / the orphan is reverted-to-newest:
    setLast(true);
    expect(container.querySelector(".md-stream")).not.toBeNull();
    const dur = () => container.querySelector(".tool-dur");
    expect(dur()?.classList.contains("live")).toBe(true);
    expect(dur()?.textContent).toMatch(/5s/);
    // The restored reasoning timer actually TICKS — live again, not frozen.
    vi.advanceTimersByTime(3000);
    expect(dur()?.textContent).toMatch(/8s/);
    // And the streaming caret returns on the tail after the coalesced flush.
    await new Promise((r) => setTimeout(r, 260));
    expect(container.querySelector(".stream-caret")).not.toBeNull();
  });

  it("reactive last → non-last (a newer message arrives) settles immediately", async () => {
    const sm = midHistorySession(Date.now() - 5000);
    const [isLast, setLast] = createSignal(true);
    const { container } = render(() => (
      <MessageParts
        m={sm.byId["mOrphan"]}
        isLastMessage={isLast}
        lastActivityKey={() => null}
        failed={() => false}
      />
    ));
    // Live first, with the caret actually placed by the coalesced flush…
    expect(container.querySelector(".md-stream")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 260));
    expect(container.querySelector(".stream-caret")).not.toBeNull();
    expect(container.querySelector(".tool-dur.live")).not.toBeNull();

    // …then a newer message lands: no longer the transcript's newest →
    // settled in the SAME flush as the position change (no grace window).
    setLast(false);
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector(".stream-caret")).toBeNull();
    expect(container.querySelector(".tool-dur")).toBeNull();
  });

  it("an authoritatively completed assistant stays settled at EITHER position", () => {
    const sm = buildMessages([
      {
        info: { id: "mUser5", sessionID: "s1", role: "user", time: { created: 10 } },
        parts: [{ id: "pu5", sessionID: "s1", messageID: "mUser5", type: "text", text: "go" }],
      },
      {
        // Bridge-stamped shape: message terminal present, reasoning part still
        // end-less (never fabricated).
        info: { id: "mDone", sessionID: "s1", role: "assistant", time: { created: 20, completed: 21 } },
        parts: [orphanReasoning("pr-done", 20)],
      },
      {
        info: { id: "mUser5b", sessionID: "s1", role: "user", time: { created: 30 } },
        parts: [{ id: "pu5b", sessionID: "s1", messageID: "mUser5b", type: "text", text: "later" }],
      },
    ]);
    for (const isLast of [() => false, () => true]) {
      const { container } = render(() => (
        <MessageParts
          m={sm.byId["mDone"]}
          isLastMessage={isLast}
          lastActivityKey={() => null}
          failed={() => false}
        />
      ));
      expect(container.querySelector(".md-stream")).toBeNull();
      expect(container.querySelector(".stream-caret")).toBeNull();
      expect(container.querySelector(".tool-dur")).toBeNull();
    }
  });

  it("user-message settlement is unchanged (settled at either position)", () => {
    const sm = midHistorySession(20);
    for (const isLast of [() => false, () => true]) {
      const { container } = render(() => (
        <MessageParts
          m={sm.byId["mUser1"]}
          isLastMessage={isLast}
          lastActivityKey={() => null}
          failed={() => false}
        />
      ));
      expect(container.querySelector(".md-stream")).toBeNull();
      expect(container.querySelector(".stream-caret")).toBeNull();
    }
  });

  it("late old-ID part update while non-last: content updates WITHOUT restoring streaming affordances", async () => {
    // A late upsert lands an extra part on the same message id while the row
    // is already mid-history (e.g. the dying instance's final flush, or a
    // warm-refresh re-publish). Pure recomputation: fresh content renders on
    // the settled row — there is no synthetic settlement state to strip and
    // no streaming affordance comes back.
    const v1 = midHistorySession(20);
    const v2 = midHistorySession(20, true);
    const [msg, setMsg] = createSignal(v1.byId["mOrphan"]);
    const { container } = render(() => (
      <MessageParts m={msg()} isLastMessage={() => false} lastActivityKey={() => null} failed={() => false} />
    ));
    expect(container.textContent).toContain(ORPHAN_TEXT);
    setMsg(v2.byId["mOrphan"]);
    expect(container.textContent).toContain("late delta arrived");
    expect(container.querySelector(".md-stream")).toBeNull();
    // No LATE resurrection either — nothing schedules a streaming flush for a
    // row that stays non-last.
    await new Promise((r) => setTimeout(r, 260));
    expect(container.querySelector(".md-stream")).toBeNull();
    expect(container.querySelector(".stream-caret")).toBeNull();
  });
});
