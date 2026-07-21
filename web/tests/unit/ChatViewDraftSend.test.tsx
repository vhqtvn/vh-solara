// @vitest-environment jsdom
//
// Regression test for the draft-send persisted-draft leak.
//
// Scenario: a NEW-session draft ("Start a new session" hero in ChatView) has
// text in the composer. The operator presses Send. send() calls
// ensureSession() -> createSession() (POST /oc/session), which on success calls
// setSelectedId(newId) — flipping draft->live and (in the real App.tsx mount
// tree) UNMOUNTING the draft ChatView and mounting a fresh live ChatView. The
// draft ChatView's draft-save createEffect is disposed by that unmount, so the
// setInput("") at the end of send() fires on an ORPHANED signal — the save
// effect does NOT re-run, and localStorage["vh.draft.__new__"] retains the
// typed text. The next time the user starts a new session, the fresh draft
// ChatView loads the stale text from localStorage and the composer reappears
// pre-filled with the previous draft.
//
// We render the draft ChatView directly (no App.tsx wrapper) but wrap it in a
// <Show when={!selectedId()}> that mirrors App.tsx's mount logic, so the
// draft->live signal flip from createSession actually UNMOUNTS the draft
// ChatView during send() — reproducing the exact production timing that
// disposes the save effect before setInput("") runs. We then drive a faithful
// createSession mock that invokes the REAL setSelectedId against the live sync
// store (so the flip happens), mock enqueue/sendText to resolve success, and
// assert (1) the persisted vh.draft.__new__ slot is gone after Send and (2) a
// SECOND fresh draft ChatView (simulating "user clicks New session again")
// starts with an empty composer.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Install the stub BEFORE any
// import that triggers layout.ts — vi.hoisted runs before ESM imports.
vi.hoisted(() => {
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { fireEvent } from "@testing-library/dom";
import { Show } from "solid-js";

// --- Mocks ------------------------------------------------------------------
//
// ChatView reads from four module surfaces. We mock each at the source so the
// component's own `import { ... } from "../X"` resolves to the stub.
//
// vi.mock factories are hoisted above top-level declarations by Vitest, so the
// mock fns MUST be created via vi.hoisted() (which is hoisted with the mocks
// and therefore in scope inside the factories). The (...args) => fn(...args)
// trampoline form is the established pattern (see QuestionCard.test.tsx).

const { createSessionMock, enqueueMock } = vi.hoisted(() => ({
  // Drives the real setSelectedId against the live sync store so the
  // draft->live signal flip happens exactly as in production. The <Show>
  // wrapper in the test render reacts to this flip and unmounts the draft
  // ChatView, mirroring App.tsx.
  createSessionMock: vi.fn(async (): Promise<string | null> => {
    const { setSelectedId } = await import("../../src/sync");
    const id = "new-session-id";
    setSelectedId(id);
    return id;
  }),
  enqueueMock: vi.fn(async () => "fake-item-id"),
}));

// agents: ChatView's readyToSend memo requires agents() non-empty. Provide one.
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  activeAgent: () => "build",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

// models: readyToSend requires models() non-empty for a draft (no per-session
// selection yet). Provide one model; selectionFor("") returns null (no pick).
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

// sync: keep the REAL store (so setSelectedId flips the real selectedId/draft
// signals exactly as in production) and override only createSession.
vi.mock("../../src/sync", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createSession: createSessionMock };
});

// queue: keep the real store (queueMode() default true is fine) and override
// only enqueue so sendText() resolves without a network round-trip.
vi.mock("../../src/queue", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, enqueue: enqueueMock };
});

// Defensive: ChatView's onMount / openSession may issue unrelated fetches
// (loadModels, fetchQueue, ...). Stub globalThis.fetch so none of them throw.
// jsdom also lacks window.matchMedia (read at module-load time by layout.ts),
// IntersectionObserver, and PointerEvent — stub those too.
beforeEach(() => {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })) as any;
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
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
});
afterEach(() => {
  (globalThis as any).fetch = undefined;
});

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import {
  selectedId as realSelectedId,
  setSelectedId as realSetSelectedId,
  newSession as realNewSession,
} from "../../src/sync";

// The persisted-draft localStorage key for a draft (props.sessionId="" -> sid
// "__new__") — derived by draftKey() at ChatView.tsx:49 =
// "vh.draft." + "__new__". The stored value is a versioned envelope
// {v:1,data:"<text>"} (see lib/store.ts:saveVersioned), but the KEY itself is
// the raw "vh.draft.__new__".
const DRAFT_KEY = "vh.draft.__new__";

describe("ChatView draft send — persisted draft cleared on success", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem(DRAFT_KEY);
    createSessionMock.mockClear();
    enqueueMock.mockClear();
    // Reset the shared sync signals so each test starts in the draft hero
    // state (selectedId=null, draft=true).
    realNewSession();
  });

  it("clears the persisted vh.draft.__new__ slot so the next draft mount starts empty", async () => {
    // Start in draft mode (selectedId=null, draft=true) — mirrors the App.tsx
    // hero state that mounts <ChatView sessionId="" draft />.
    realNewSession();
    expect(realSelectedId()).toBeNull();

    // Wrap the draft ChatView in <Show when={!selectedId()}> to mirror
    // App.tsx's mount tree: when createSession fires setSelectedId(newId), the
    // draft ChatView UNMOUNTS (disposing its draft-save createEffect) before
    // send()'s post-enqueue setInput("") runs. Without this wrapper the save
    // effect would re-run on setInput("") and clear localStorage anyway,
    // masking the bug. This is the exact timing that produces the leak in
    // production.
    const { container } = render(() => (
      <Show when={!realSelectedId()}>
        <ChatView sessionId="" draft />
      </Show>
    ));

    // Type into the composer.
    const textarea = container.querySelector(
      "textarea.composer-text",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.input(textarea, { target: { value: "hello" } });
    expect(textarea.value).toBe("hello");

    // Let the draft-save createEffect flush so the persisted slot reflects
    // "hello" before we click Send.
    await waitFor(() => {
      expect(localStorage.getItem(DRAFT_KEY)).toContain("hello");
    });

    // Click Send. The Send button is disabled until readyToSend() is true
    // (agents + models loaded — both mocked non-empty above).
    const sendBtn = container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    expect(sendBtn).toBeTruthy();
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);

    // After send() resolves, the persisted draft slot must be cleared. RED
    // before the fix: the unmount disposes the save effect, so the explicit
    // setInput("") never reaches localStorage and the slot still holds the
    // versioned "hello" envelope.
    await waitFor(() => {
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    // Simulate "user clicks New session again": newSession() flips selectedId
    // back to null and draft back to true; the <Show> re-evaluates and a
    // FRESH draft ChatView mounts. Its load effect reads
    // localStorage["vh.draft.__new__"] — which must now be empty.
    realNewSession();

    // Wait for the new ChatView's mount + load effect to populate the
    // textarea, then assert it starts empty.
    await waitFor(() => {
      const t = container.querySelector(
        "textarea.composer-text",
      ) as HTMLTextAreaElement | null;
      expect(t).toBeTruthy();
      expect(t!.value).toBe("");
    });

    // Sanity: the send actually happened.
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [, payload] = enqueueMock.mock.calls[0] as [string, { text: string }];
    expect(payload.text).toBe("hello");
  });

  it("clears the persisted vh.draft.__new__ slot on shell-branch (!cmd) send success", async () => {
    // Same bug class as the normal-send case, different branch: when the
    // FIRST send from a draft is a "!shell" command, the shell branch in
    // send() returns after ensureSession() (which already flipped draft->live
    // and unmounted the draft ChatView, disposing the draft-save effect)
    // WITHOUT clearing the persisted vh.draft.__new__ slot. The setInput("")
    // on the shell branch fires on an orphaned signal; localStorage retains
    // the versioned "!cmd" envelope and the next New session re-inflates it.
    //
    // RED before the fix: the shell branch has no draft-slot clear on its
    // success path, so localStorage["vh.draft.__new__"] still holds the
    // versioned "!echo hi" envelope after Send.
    //
    // Start in draft mode (selectedId=null, draft=true) — mirrors App.tsx hero.
    realNewSession();
    expect(realSelectedId()).toBeNull();

    // Wrap in <Show when={!selectedId()}> so the draft->live flip from
    // createSession UNMOUNTS the draft ChatView before send()'s post-enqueue
    // setInput("") runs — same timing that produces the leak in production.
    const { container } = render(() => (
      <Show when={!realSelectedId()}>
        <ChatView sessionId="" draft />
      </Show>
    ));

    // Type a shell command into the composer (leading "!" => shell branch).
    const textarea = container.querySelector(
      "textarea.composer-text",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.input(textarea, { target: { value: "!echo hi" } });
    expect(textarea.value).toBe("!echo hi");

    // Let the draft-save createEffect flush so the persisted slot reflects
    // "!echo hi" before we click Send.
    await waitFor(() => {
      expect(localStorage.getItem(DRAFT_KEY)).toContain("!echo hi");
    });

    // Click Send. The Send button is disabled until readyToSend() is true
    // (agents + models loaded — both mocked non-empty above). runShell ->
    // dispatchSend -> the mocked globalThis.fetch returns ok:true, so the
    // shell POST resolves success (true) on the fast path.
    const sendBtn = container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    expect(sendBtn).toBeTruthy();
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);

    // After send() resolves, the persisted draft slot must be cleared. RED
    // before the fix: the shell branch returns at `if (!ok) setInput(text)`
    // without touching localStorage, and the unmount already disposed the
    // save effect that would otherwise clear it — so the versioned "!echo hi"
    // envelope survives.
    await waitFor(() => {
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    // Sanity: createSession was called (shell still needs a live session),
    // and enqueue was NOT called (shell bypasses the queue — dispatchSend
    // posts directly to /oc/session/.../shell). This confirms we exercised
    // the shell branch, not the normal-send branch.
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
