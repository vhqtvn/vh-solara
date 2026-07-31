// @vitest-environment jsdom
//
// Area 3 + Area 5 — deferred-row characterization for the ChatView message-row
// `<For>` callback (ChatView.tsx ~1588-1739), the extraction candidate for a
// future `MessageRow` component. Each row wraps its `MessageParts` in
// `<Deferred eager={i() >= messages().length - EAGER_TAIL}>` (EAGER_TAIL=30),
// so occlusion-based virtualization defers a row's heavy content (markdown /
// mermaid / fetch) until it nears the viewport.
//
// AREA 3 (observer root + lifetime): for a non-eager (deferred) row, the
// Deferred component creates exactly ONE IntersectionObserver on mount, rooted
// at `.chat-scroll` (the scrollEl), observing its `.msg-parts` div. Activation
// (intersection) mounts the content and disconnects; the observer is NEVER
// recreated and an activated row NEVER reverts to deferred — pins that a
// MessageRow extraction must preserve the Deferred wiring + lifetime.
//
// AREA 5 (deferred skeleton contract): before activation, the `.msg[data-mid]`
// shell EXISTS with the row metadata/actions current behavior requires (role
// label, timestamp, copy action) even while heavy parts are deferred. This is
// the contract scroll/read/nav logic relies on: the row element is queryable
// even when its content is not yet mounted.
//
// These use the controllable IntersectionObserver from _chatRowHarness
// (ioRecords / fireIntersectFor). To make a row deferred, the list must exceed
// EAGER_TAIL (30): with 31 messages only the index-0 row is deferred.
//
// TESTS-ONLY: no production source is modified.
import "./_chatRowHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@solidjs/testing-library";
import {
  fireIntersectFor,
  ioRecords,
  mkAssistant,
  mkTextPart,
  mkUser,
  mountChatView,
  seedMessages,
  appendMessage,
  setupRowGlobals,
  teardownRowGlobals,
  streamPart,
} from "./_chatRowHarness";
import { setState } from "../../src/sync/store";

beforeEach(() => {
  setupRowGlobals();
});
afterEach(() => {
  teardownRowGlobals();
  setState("messages", "s1", undefined as any);
  setState("messagesDelivered", "s1", undefined as any);
  setState("messagesError", "s1", undefined as any);
  cleanup();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// The deferred assistant row (index 0). Its text part is "heavy content" that
// Deferred keeps unmounted until intersection.
const deferredAssistant = () =>
  mkAssistant("m1", ["pText"], { pText: mkTextPart("pText", "deferred heavy content") });

// Build a 31-message transcript where ONLY m1 (index 0) is deferred
// (0 < 31 - EAGER_TAIL(30) → not eager; indices 1..30 are eager). m2..m31 are
// minimal user rows (no parts) to keep the test cheap.
function seedDeferredList() {
  const byId: Record<string, any> = { m1: deferredAssistant() };
  for (let i = 2; i <= 31; i++) byId[`m${i}`] = mkUser(`m${i}`);
  seedMessages("s1", byId);
}

// The Deferred observer for a row's `.msg-parts` (rootMargin "1200px 0px",
// distinguishing it from ChatView's loadMoreObserver which uses "600px 0px 0px 0px").
function deferredObserverFor(partsEl: Element) {
  return ioRecords.find(
    (r) => r.target === partsEl && /1200px/.test(String((r.opts as any).rootMargin || "")),
  );
}

describe("Area 3 — deferred observer root + lifetime", () => {
  it("the deferred row's observer is rooted at .chat-scroll (the scrollEl)", async () => {
    const { container } = await mountChatView("s1");
    seedDeferredList();
    await flush();

    const partsEl = container.querySelector('[data-mid="m1"] .msg-parts') as HTMLElement;
    expect(partsEl).toBeTruthy();
    const scrollEl = container.querySelector(".chat-scroll") as HTMLElement;
    expect(scrollEl).toBeTruthy();

    const obs = deferredObserverFor(partsEl);
    // MUTATION OBSERVED: if an extraction stopped forwarding the Deferred `root`
    // (scrollEl), the observer would fall back to the viewport (null) instead of
    // the scroll container → obs.root would be null, not scrollEl.
    expect(obs).toBeTruthy();
    expect(obs!.root).toBe(scrollEl);
    // And it is observing the row's own `.msg-parts` element.
    expect(obs!.target).toBe(partsEl);
  });

  it("the deferred row creates exactly ONE observer, not recreated by streaming/list updates", async () => {
    const { container } = await mountChatView("s1");
    seedDeferredList();
    await flush();

    const partsEl = container.querySelector('[data-mid="m1"] .msg-parts') as HTMLElement;
    const obsBefore = deferredObserverFor(partsEl);
    expect(obsBefore).toBeTruthy();
    const observersForM1Before = ioRecords.filter((r) => r.target === partsEl).length;
    expect(observersForM1Before).toBe(1);

    // A streaming/list update that does NOT remount the row must NOT construct a
    // new observer for it. Append a message + stream a part, then re-check.
    appendMessage("s1", mkUser("m32"));
    streamPart("s1", "m1", mkTextPart("pText2", "streamed"));
    await flush();

    // MUTATION OBSERVED: if the extraction remounted the Deferred on each update
    // (e.g. keyed it wrongly), a SECOND observer would be constructed for m1's
    // `.msg-parts` → count > 1. Still-deferred (un-activated) state is asserted
    // here; the next test covers the post-activation lifetime.
    expect(ioRecords.filter((r) => r.target === partsEl).length).toBe(1);
    // The original observer instance is unchanged (same reference, not recreated).
    expect(deferredObserverFor(partsEl)).toBe(obsBefore);
  });

  it("activation mounts the content, disconnects the observer, and never reverts", async () => {
    const { container } = await mountChatView("s1");
    seedDeferredList();
    await flush();

    const partsEl = container.querySelector('[data-mid="m1"] .msg-parts') as HTMLElement;
    const obs = deferredObserverFor(partsEl);
    expect(obs).toBeTruthy();

    // Before activation: heavy content is absent (deferred).
    expect(partsEl.querySelector(".md")).toBeNull();

    // Activate: fire intersection for m1's observer.
    fireIntersectFor(partsEl, true);
    await flush();

    // MUTATION OBSERVED (activation): if the extraction failed to wire the
    // intersection callback to Deferred's setShow(true), the heavy content would
    // never mount → `.md` stays absent.
    expect(partsEl.querySelector(".md")).toBeTruthy();
    expect(partsEl.textContent).toContain("deferred heavy content");
    // The observer disconnected once activated (Deferred releases it).
    expect(obs!.disconnected).toBe(true);

    // Later updates must NOT revert an activated row to deferred, nor reconstruct
    // its observer. Stream a part + append a message; the content stays mounted,
    // no new observer appears, the original stays disconnected.
    streamPart("s1", "m1", mkTextPart("pText3", "post-activation stream"));
    appendMessage("s1", mkUser("m32"));
    await flush();

    // MUTATION OBSERVED (no-revert): if the extraction re-deferred on update
    // (e.g. re-initialized the Deferred `show` signal), the heavy content would
    // unmount again → `.md` absent.
    expect(partsEl.querySelector(".md")).toBeTruthy();
    expect(partsEl.textContent).toContain("deferred heavy content");
    // MUTATION OBSERVED (no-recreate): no new observer for m1's `.msg-parts`,
    // and the original is still the disconnected one (not reconnected/recreated).
    expect(ioRecords.filter((r) => r.target === partsEl).length).toBe(1);
    expect(deferredObserverFor(partsEl)).toBe(obs);
    expect(obs!.disconnected).toBe(true);
  });
});

describe("Area 5 — deferred row skeleton contract (shell queryable pre-activation)", () => {
  it("before activation: .msg[data-mid] shell + metadata/actions present, heavy part absent", async () => {
    const { container } = await mountChatView("s1");
    seedDeferredList();
    await flush();

    // Do NOT activate (no fireIntersectFor). The row shell must still exist.
    const shell = container.querySelector('[data-mid="m1"]') as HTMLElement;
    // MUTATION OBSERVED (shell-exists): if the extraction rendered the `.msg`
    // wrapper INSIDE the Deferred (gated on activation), the row element would
    // be absent pre-activation → scroll/read/nav that query `[data-mid]` would
    // break for off-screen rows.
    expect(shell).toBeTruthy();
    expect(shell.classList.contains("msg")).toBe(true);

    // Row metadata/actions required by current behavior are present on the shell
    // regardless of deferral (they live in `.msg-head`, OUTSIDE the Deferred).
    expect(shell.querySelector(".msg-role")?.textContent).toBe("Assistant");
    expect(shell.querySelector(".msg-time")).toBeTruthy();
    expect(shell.querySelector("button.msg-copy")).toBeTruthy();

    // Heavy parts are deferred: the `.msg-parts` wrapper exists (Deferred always
    // renders its outer div) but its content is NOT mounted, and the reserved
    // min-height marks the deferral as active (not eager).
    const partsEl = shell.querySelector(".msg-parts") as HTMLElement;
    expect(partsEl).toBeTruthy();
    // MUTATION OBSERVED (content-deferred): if the extraction made m1 eager (e.g.
    // miscalculated EAGER_TAIL), the heavy `.md` would be present pre-activation.
    expect(partsEl.querySelector(".md")).toBeNull();
    expect(partsEl.textContent).not.toContain("deferred heavy content");
    expect(partsEl.style.minHeight).toBe("48px"); // Deferred minHeight reserve
  });
});
