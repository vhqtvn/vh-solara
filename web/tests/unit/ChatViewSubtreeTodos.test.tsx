// @vitest-environment jsdom
//
// D6 — ChatView subtree-todos fetch-effect (P5).
//
// ChatView.tsx:611-633 fetches the server-authoritative subtree todo rollup
// (GET /vh/session/:id/subtree-todos) on session open and polls it every 5s
// while the session stays open, mirroring the fetchQueue idiom. A monotonic
// `todoPollReq` discards a response from a prior session (or after unmount) so a
// slow in-flight fetch can never clobber the current session's state.
//
// The server wire contract is pinned by Go tests under pkg/web/. These tests pin
// the FE CONSUMER behavior: optimistic fetch on open, 5s poll cadence,
// fresh-response application, stale-response dropping on session switch, and
// cleanup (interval cleared + in-flight suppressed) on unmount.
//
// The scaffold (agents/models mocks + matchMedia/IntersectionObserver/Pointer
// Event/ResizeObserver stubs) mirrors ChatViewRevealDeadlock.test.tsx — the
// minimal render surface for a live ChatView. fetchSubtreeTodos is mocked at the
// source so we control resolution order without a real network round-trip.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// code/frame.ts via ChatView's transitive deps). Import the shared stub BEFORE
// any import that triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { SubtreeTodosResp } from "../../src/subtreeTodos";

// fetchSubtreeTodos: controlled mock. Hoisted so the factory below can reference
// it. Per-test code seeds mockResolvedValue / mockImplementationOnce to drive
// the poll cadence and stale-resolution ordering.
const { fetchSubtreeTodosMock } = vi.hoisted(() => ({
  fetchSubtreeTodosMock: vi.fn(),
}));
vi.mock("../../src/subtreeTodos", () => ({
  fetchSubtreeTodos: fetchSubtreeTodosMock,
}));

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

// models: readyToSend requires models() non-empty. Provide one model.
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

// jsdom lacks IntersectionObserver, PointerEvent, and ResizeObserver. Stub fetch
// too (ChatView onMount may issue unrelated fetches — none reach subtreeTodos,
// which is mocked). sync store is REAL (ChatViewRevealDeadlock pattern).
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
  fetchSubtreeTodosMock.mockReset();
});
afterEach(() => {
  (globalThis as any).fetch = undefined;
  vi.useRealTimers();
  cleanup();
});

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";

// Build a well-formed SubtreeTodosResp (the shape fetchSubtreeTodos resolves
// with). `active`/`left` drive the Tasks pill DOM; total is advisory.
function todosResp(
  sessionId: string,
  active: number,
  left: number,
): SubtreeTodosResp {
  return {
    epoch: "e1",
    revision: 1,
    data: {
      sessionId,
      totals: { active, left, total: active + left },
      items: [],
    },
  };
}

// A controllable pending promise so a poll can be held in-flight across a
// session switch / unmount and then resolved to prove stale suppression.
function deferred<T = SubtreeTodosResp>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// The Tasks pill renders two .tasks-count spans: "<active> active" and
// "<left> left". Returns them trimmed, in DOM order, or [] when the pill is
// absent (no open tasks).
function taskCounts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".tasks-count")).map(
    (e) => (e.textContent ?? "").trim(),
  );
}

describe("ChatView subtree-todos fetch-effect (D6)", () => {
  afterEach(() => {
    // Drop any slot openSession reserved so tests are isolated.
    setState("messages", "ses_a", undefined as any);
    setState("messages", "ses_b", undefined as any);
  });

  it("fetches on open and re-fetches on the 5s poll cadence", async () => {
    vi.useFakeTimers();
    fetchSubtreeTodosMock.mockResolvedValue(todosResp("ses_a", 1, 2));

    render(() => <ChatView sessionId="ses_a" />);

    // The immediate poll fires on mount (createEffect → void poll()).
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1);
    expect(fetchSubtreeTodosMock).toHaveBeenLastCalledWith("ses_a");

    // Just before the 5s interval: still one call.
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1);

    // Cross the 5s boundary → second poll.
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(2);

    // Another 5s → third poll. Cadence is exactly 5s, not faster.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(3);
    expect(fetchSubtreeTodosMock).toHaveBeenLastCalledWith("ses_a");
  });

  it("applies a fresh response to the Tasks pill", async () => {
    // Real timers: the resolved mock promise lands via the normal microtask
    // queue, and waitFor polls the DOM until the pill reflects it.
    fetchSubtreeTodosMock.mockResolvedValue(todosResp("ses_a", 2, 3));

    const { container } = render(() => <ChatView sessionId="ses_a" />);

    await waitFor(() => {
      expect(taskCounts(container as unknown as HTMLElement)).toEqual([
        "2 active",
        "3 left",
      ]);
    });
  });

  it("drops a stale response from a prior session (monotonic todoPollReq)", async () => {
    // Hold ses_a's first poll in-flight across the switch so we can resolve it
    // AFTER ses_b has already applied its own fresh response.
    const sesAPoll = deferred();
    fetchSubtreeTodosMock.mockImplementationOnce(() => sesAPoll.promise);
    // Subsequent calls (ses_b's polls) resolve immediately with 5/6.
    fetchSubtreeTodosMock.mockResolvedValue(todosResp("ses_b", 5, 6));

    const [sid, setSid] = createSignal("ses_a");
    const { container } = render(() => <ChatView sessionId={sid()} />);

    // ses_a's immediate poll is in-flight (deferred, not yet resolved).
    await waitFor(() => expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1));

    // Switch to ses_b: the effect re-runs, the old run's onCleanup bumps
    // todoPollReq (so ses_a's pending poll is now stale), and the new run
    // issues ses_b's poll which resolves with 5/6.
    setSid("ses_b");
    await waitFor(() => {
      expect(taskCounts(container as unknown as HTMLElement)).toEqual([
        "5 active",
        "6 left",
      ]);
    });

    // Now resolve the STALE ses_a response (9/9). It must be suppressed — the
    // monotonic guard sees myReq !== todoPollReq and returns before
    // setSubtreeTodos, so ses_b's 5/6 must remain.
    sesAPoll.resolve(todosResp("ses_a", 9, 9));
    // Let the stale microtask drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(taskCounts(container as unknown as HTMLElement)).toEqual([
      "5 active",
      "6 left",
    ]);
    expect(container?.textContent ?? "").not.toContain("9 active");
    expect(container?.textContent ?? "").not.toContain("9 left");
  });

  it("clears the poll interval and suppresses the in-flight fetch on unmount", async () => {
    vi.useFakeTimers();
    // Keep the poll pending so both guards are exercised: the interval must be
    // cleared (no further polls) AND the in-flight resolve after unmount must
    // be a no-op (no throw, no state write).
    const inFlight = deferred();
    fetchSubtreeTodosMock.mockImplementation(() => inFlight.promise);

    const { unmount } = render(() => <ChatView sessionId="ses_a" />);

    // The immediate poll fired and is pending.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1);

    unmount();

    // Advance well past several poll intervals — the interval was cleared by
    // onCleanup, so NO further polls fire.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1);

    // Resolving the in-flight fetch AFTER unmount must not throw or schedule
    // any further work. onCleanup bumped todoPollReq, so the resolve path hits
    // the stale guard and returns before touching the (disposed) signal.
    expect(() => inFlight.resolve(todosResp("ses_a", 9, 9))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSubtreeTodosMock).toHaveBeenCalledTimes(1);
  });
});
