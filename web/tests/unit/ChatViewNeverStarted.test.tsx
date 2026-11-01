// @vitest-environment jsdom
//
// P1 presentation-coverage closeout (DEFER from commit d329561's review):
// selector-level coverage existed (messageMeta.test.ts) but the MOUNTED
// either/or presentation — a real render showing `.msg-never` and NOT
// `.msg-error` for a refined row, and the inverse for a control row — was
// never proven. MessageRow.tsx's nested <Show> (neverStartedNotice wins;
// messageError is the fallback) is the single render decision point, so this
// test mounts the full ChatView (MessageRow inside it) and asserts the DOM.
//
// Same harness shape as ChatViewPartlessMessage.test.tsx: mock agents/models,
// stub jsdom's missing observers, seed the message store directly, assert
// row-scoped selectors (`.msg[data-mid=…]`) so per-row either/or is proven
// rather than a global class census.
//
// Row shapes mirror the two producers exactly:
//   - Refined (pkg/state/never_started.go mergeNeverStartedInfo): ONLY the
//     error block is rewritten to name=VHSolaraNeverStartedError with
//     data.message=Go's neverStartedUserMessage and data.cause=<upstream
//     name>; upstream time.completed survives.
//   - Control (real operator/limit abort): the validated incident control —
//     MessageAbortedError with substantive parts and duration ≫ 100 ms —
//     plus a generic provider error as a second control.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Import the shared stub BEFORE
// any import that triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// agents: ChatView's readyToSend memo requires agents() non-empty. Provide one.
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  awaitSendAgent: async () => ({ ok: true, agent: "build" }),
  resolveAgentForSession: () => ({ state: "agent", agent: "build" }),
  adoptDraftAgent: vi.fn(),
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

// models: readyToSend requires models() non-empty. Provide one model;
// selectionFor("") returns null.
vi.mock("../../src/models", () => ({
  models: () => [{
    providerID: "test",
    modelID: "m1",
    provider: "Test",
    name: "M1",
    label: "Test / M1",
    variants: [],
  }],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseVariant: vi.fn(),
  chooseModel: vi.fn(),
  applyModel: vi.fn(),
  loadModels: vi.fn(),
}));

// jsdom lacks IntersectionObserver, PointerEvent, and ResizeObserver. Stub
// fetch too (ChatView onMount may issue unrelated fetches).
beforeEach(() => {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })) as any;
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  (globalThis as any).fetch = undefined;
});

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";

// A snapshot of the current user-facing vocabulary: Go's
// neverStartedUserMessage (pkg/state/never_started.go), which the FE passes
// through from error.data.message and which messageMeta's FE literal fallback
// mirrors. This test asserts the EXACT rendered string, so FE rendering or
// FE-fallback drift turns it red — but a GO-ONLY edit to the vocabulary is
// invisible to the web suite (the fixture seeds this local copy, not the Go
// constant). The literal is hand-mirrored across four sites
// (never_started.go, messageMeta.ts, messageMeta.test.ts, this constant):
// touching either source requires re-verifying all four by hand.
const GO_NEVER_STARTED_MESSAGE =
  "Turn never ran: OpenCode aborted this turn before it started — this was not your stop. Re-sending will likely repeat this.";

// A never-started row as pkg/state/never_started.go produces it: completed
// (upstream stamp survives), zero parts, zero tokens, error block refined to
// name=VHSolaraNeverStartedError with data.message + data.cause.
const mkNeverStarted = (id: string): any => ({
  id,
  info: {
    role: "assistant",
    time: { created: 1000, completed: 1027 },
    error: {
      name: "VHSolaraNeverStartedError",
      data: { message: GO_NEVER_STARTED_MESSAGE, cause: "MessageAbortedError" },
    },
  },
  partOrder: [],
  parts: {},
});

// The validated incident CONTROL: a real operator/limit abort —
// MessageAbortedError WITH substantive parts and duration ≫ 100 ms. Must keep
// the plain red .msg-error presentation.
const mkOperatorAbort = (id: string): any => ({
  id,
  info: {
    role: "assistant",
    time: { created: 1000, completed: 146000 },
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  },
  partOrder: ["p1"],
  parts: {
    p1: { id: "p1", sessionID: "s1", messageID: id, type: "text", text: "Substantive partial work before the operator stop." },
  },
});

// A second control: any generic error row (not abort-shaped at all).
const mkGenericError = (id: string): any => ({
  id,
  info: {
    role: "assistant",
    time: { created: 1000, completed: 2000 },
    error: { name: "ProviderError", data: { message: "rate limited" } },
  },
  partOrder: [],
  parts: {},
});

const seed = (byId: Record<string, any>) =>
  setState("messages", "s1", { order: Object.keys(byId), byId });

describe("ChatView P1 — mounted never-started vs error either/or presentation", () => {
  afterEach(() => {
    cleanup();
    setState("messages", "s1", undefined as any);
    setState("messagesDelivered", "s1", undefined as any);
    setState("messagesError", "s1", undefined as any);
  });

  it("a refined never-started row renders .msg-never (exact vocabulary) and NOT .msg-error", async () => {
    const { container } = render(() => <ChatView sessionId="s1" />);
    seed({ m1: mkNeverStarted("m1") });
    setState("messagesDelivered", "s1", true);

    // The assistant row itself must render (guards a false red from the row
    // being absent entirely).
    await waitFor(() =>
      expect(container.querySelector('.msg.assistant[data-mid="m1"]')).toBeTruthy(),
    );

    // The quiet never-started notice is present, with the exact Go vocabulary
    // and the explanatory title attribute.
    const never = container.querySelector('.msg[data-mid="m1"] .msg-never');
    expect(never).toBeTruthy();
    expect(never!.textContent).toBe(GO_NEVER_STARTED_MESSAGE);
    expect(never!.getAttribute("title")).toBe(
      "OpenCode aborted this turn before it started — not your stop.",
    );

    // EITHER/OR (the DEFER's core claim): the generic red error box must NOT
    // render on this row, even though messageError(info) is truthy for the
    // refined shape (data.message is set) — MessageRow's nested <Show> must
    // suppress it.
    expect(container.querySelector('.msg[data-mid="m1"] .msg-error')).toBeNull();
  });

  it("operator-abort and generic-error rows render .msg-error and NOT .msg-never", async () => {
    const { container } = render(() => <ChatView sessionId="s1" />);
    seed({ m1: mkOperatorAbort("m1"), m2: mkGenericError("m2") });
    setState("messagesDelivered", "s1", true);

    await waitFor(() =>
      expect(container.querySelector('.msg.assistant[data-mid="m1"]')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(container.querySelector('.msg.assistant[data-mid="m2"]')).toBeTruthy(),
    );

    // Control 1 — real operator/limit abort (MessageAbortedError WITH parts):
    // the plain red error box, none of the "not your stop" vocabulary.
    const abortErr = container.querySelector('.msg[data-mid="m1"] .msg-error');
    expect(abortErr).toBeTruthy();
    expect(abortErr!.textContent).toContain("Aborted");
    expect(container.querySelector('.msg[data-mid="m1"] .msg-never')).toBeNull();

    // Control 2 — any generic error row: same either/or direction.
    const genericErr = container.querySelector('.msg[data-mid="m2"] .msg-error');
    expect(genericErr).toBeTruthy();
    expect(genericErr!.textContent).toContain("rate limited");
    expect(container.querySelector('.msg[data-mid="m2"] .msg-never')).toBeNull();
  });

  it("FE literal fallback: name-only refined row still renders .msg-never (fallback text), not .msg-error", async () => {
    // A row carrying the refined NAME but no data.message (e.g. a hand-built
    // fixture): messageMeta's local literal must classify AND render it —
    // neverStartedNotice returns the fallback, and the either/or still
    // suppresses .msg-error (messageError would fall through to the raw name).
    const fallbackRow: any = {
      id: "m1",
      info: {
        role: "assistant",
        time: { created: 1000, completed: 1007 },
        error: { name: "VHSolaraNeverStartedError" },
      },
      partOrder: [],
      parts: {},
    };
    const { container } = render(() => <ChatView sessionId="s1" />);
    seed({ m1: fallbackRow });
    setState("messagesDelivered", "s1", true);

    await waitFor(() =>
      expect(container.querySelector('.msg.assistant[data-mid="m1"]')).toBeTruthy(),
    );

    const never = container.querySelector('.msg[data-mid="m1"] .msg-never');
    expect(never).toBeTruthy();
    // The FE fallback literal mirrors Go's neverStartedUserMessage verbatim.
    expect(never!.textContent).toBe(GO_NEVER_STARTED_MESSAGE);
    expect(container.querySelector('.msg[data-mid="m1"] .msg-error')).toBeNull();
  });
});
