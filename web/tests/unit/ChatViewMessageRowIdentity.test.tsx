// @vitest-environment jsdom
//
// Area 2 + Area 4 — row-DOM identity and MessageParts-cache preservation
// characterization for the ChatView message-row `<For>` callback
// (ChatView.tsx ~1588-1739), the extraction candidate for a future `MessageRow`
// component.
//
// AREA 2 (row DOM identity): Solid `<For>` keys rows by message-object
// reference. `messages()` = `s.order.map(id => s.byId[id])`, so updates that
// keep `byId[id]` referentially stable (append a message, stream a part in
// place, toggle inspect on a DIFFERENT row) must NOT remount the row — the
// `.msg[data-mid]` element must stay reference-equal. Also pins the DOM
// CONTRACT that `.msg` is a direct child of `.chat-content` (no wrapper element
// inserted above `.msg`), which scroll/read/nav logic relies on.
//
// AREA 4 (MessageParts cache preservation): streaming a NEW part onto an
// existing message must NOT remount MessageParts (it owns a keyed cache that
// reuses wrapper objects for unchanged keys). There is no production seam
// exposing a construction counter, so we assert the OUTCOME: an EXISTING part's
// DOM node survives the append of a new part (reference-equal). A remount would
// discard the cache → recreate every part's DOM → the reference would change.
//
// TESTS-ONLY: no production source is modified.
import "./_chatRowHarness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import {
  mountChatView,
  appendMessage,
  mkAssistant,
  mkMarkerPart,
  mkTextPart,
  mkUser,
  seedMessages,
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

// Flush Solid's batched effects + any scheduled microtasks so a setState update
// is reflected in the DOM before the next query.
const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-mid="${id}"]`) as HTMLElement;

describe("Area 2 — row DOM identity across reactive updates (no remount)", () => {
  it("appending another message keeps the existing row element reference-equal", async () => {
    // MUTATION OBSERVED: if an extraction re-keyed `<For>` by index or recreated
    // row elements when the list grew (e.g. mapping to fresh components without
    // preserving the message reference), `.msg[data-mid="m1"]` would be a NEW
    // element after the append → reference inequality.
    const { container } = await mountChatView("s1");
    seedMessages("s1", { m1: mkUser("m1") });
    const before = row(container, "m1");
    expect(before).toBeTruthy();

    appendMessage("s1", mkUser("m2"));
    await flush();

    const after = row(container, "m1");
    expect(after).toBe(before); // reference-equal — row NOT remounted
    // DOM contract: `.msg` is a direct child of `.chat-content` (no wrapper
    // element inserted above `.msg` by an extraction).
    expect(after.parentElement?.classList.contains("chat-content")).toBe(true);
    // Sanity: the appended row did render (the update took effect).
    expect(row(container, "m2")).toBeTruthy();
  });

  it("streaming a new part onto a message keeps the row element reference-equal", async () => {
    // MUTATION OBSERVED: if streaming a part recreated the message object (e.g.
    // an extraction rebuilt byId entries instead of mutating in place), `<For>`
    // would see a new item reference → remount the row → new `.msg` element.
    const { container } = await mountChatView("s1");
    seedMessages("s1", {
      m1: mkAssistant("m1", ["p1"], { p1: mkTextPart("p1", "first") }),
    });
    const before = row(container, "m1");
    expect(before).toBeTruthy();

    // upsertPart shape (in place): partOrder.push + parts[id]=part.
    streamPart("s1", "m1", mkTextPart("p2", "second"));
    await flush();

    const after = row(container, "m1");
    expect(after).toBe(before); // reference-equal — row NOT remounted
  });

  it("toggling inspection on a DIFFERENT message keeps the unaffected row reference-equal", async () => {
    // MUTATION OBSERVED: if an extraction re-ran the row callback when the
    // shared `inspectId()` signal changed (instead of reading it reactively
    // inside only the inspected row's `<Show>`), the non-inspected row could be
    // recreated → new `.msg` element.
    const { container } = await mountChatView("s1");
    seedMessages("s1", { m1: mkUser("m1"), m2: mkUser("m2") });
    const before = row(container, "m1");
    expect(before).toBeTruthy();
    expect(row(container, "m2")).toBeTruthy();

    // Toggle inspect on m2 (a DIFFERENT row). m1 must be unaffected.
    const inspectM2 = container.querySelector(
      '[data-mid="m2"] button[aria-label="Inspect"]',
    ) as HTMLButtonElement;
    fireEvent.click(inspectM2);
    await flush();

    // m2's inspect panel opened (sanity: the toggle took effect).
    expect(container.querySelector('[data-mid="m2"] .msg-inspect')).toBeTruthy();
    // m1's row is reference-equal AND has no inspect panel.
    const after = row(container, "m1");
    expect(after).toBe(before); // reference-equal — row NOT remounted
    expect(container.querySelector('[data-mid="m1"] .msg-inspect')).toBeNull();
  });
});

describe("Area 4 — MessageParts cache preservation across streaming updates", () => {
  it("streaming a new part does NOT remount MessageParts (existing part DOM survives)", async () => {
    // The first part is a synchronous marker (`[data-kind="agent"]`, no resource
    // fetch) — the robust observable for reference-equality. The second part is
    // text so the realistic streaming append path is exercised.
    //
    // MUTATION OBSERVED: if streaming a new part remounted MessageParts, its
    // keyed `cache` Map is recreated → every part's wrapper is rebuilt → the
    // marker `[data-kind="agent"]` element would be a NEW node → reference
    // inequality. (If the cache were preserved, the unchanged key "p:pAgent" is
    // reused → `<For>` keeps the marker's DOM.)
    const { container } = await mountChatView("s1");
    seedMessages("s1", {
      m1: mkAssistant(
        "m1",
        ["pAgent", "pText1"],
        {
          pAgent: mkMarkerPart("pAgent", "agent", { name: "researcher" }),
          pText1: mkTextPart("pText1", "first block"),
        },
      ),
    });
    const parts1 = container.querySelector('[data-mid="m1"] .msg-parts') as HTMLElement;
    await flush();
    const markerBefore = parts1.querySelector('[data-kind="agent"]') as HTMLElement;
    expect(markerBefore).toBeTruthy();

    streamPart("s1", "m1", mkTextPart("pText2", "appended token"));
    await flush();

    const markerAfter = parts1.querySelector('[data-kind="agent"]');
    // Cache preserved → the marker DOM node survived the append (reference-equal).
    expect(markerAfter).toBe(markerBefore);
    // Sanity: the new part DID render (the stream took effect — non-vacuous).
    expect(parts1.textContent).toContain("appended token");
  });
});
