// @vitest-environment jsdom
//
// Host→pane tail/follow command listener (web/src/tailListener.ts).
//
// Pins the dispatch table (following:true → forceChatTailFollow; following:
// false → validated but NOT dispatched — the read-first verdict on
// force-unfollow durability), the inbound security invariants that mirror the
// heartbeat/route/status/select bridges (embed gate, inbound source-guard
// BEFORE any state mutation, payload allowlist to {following:boolean} only),
// and the no-op standalone case. The dispatch target (forceChatTailFollow) is
// mocked so the test asserts the listener's routing, not the ChatView seam.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the tailFollow bridge so we assert the listener's routing only (same
// pattern as selectListener.test.ts mocking setSelectedId/switchProject).
const mocks = vi.hoisted(() => ({
  forceChatTailFollow: vi.fn<(...args: unknown[]) => boolean>(),
}));
vi.mock("../../src/tailFollow", () => ({
  forceChatTailFollow: mocks.forceChatTailFollow,
}));

import { startTailListener, TAIL_TYPE } from "../../src/tailListener";

const { forceChatTailFollow: forceMock } = mocks;

function makeFakeParent(): { parent: Window } {
  const parent = {
    postMessage: () => {
      /* the tail listener never replies */
    },
  } as unknown as Window;
  return { parent };
}

/** Dispatch a host→SPA message on window with a programmatically-set `source`.
 *  jsdom's MessageEvent does not always preserve a set source (see
 *  selectListener.test.ts), so define it explicitly so the inbound
 *  source-guard (`ev.source === window.parent`) passes when intended. */
function sendTail(source: Window, following: unknown, extra?: Record<string, unknown>): void {
  const ev = new MessageEvent("message", {
    data: { type: TAIL_TYPE, following, ...extra },
    origin: "https://host.example",
  });
  Object.defineProperty(ev, "source", {
    value: source,
    writable: false,
    configurable: true,
  });
  window.dispatchEvent(ev);
}

describe("tail listener — no-op when standalone (embed gate)", () => {
  beforeEach(() => {
    forceMock.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("returns undefined when window.parent === window (standalone)", () => {
    // jsdom default: window.parent === window.
    const dispose = startTailListener();
    expect(dispose, "standalone → no-op (undefined)").toBeUndefined();
    dispose?.();
  });

  it("does not dispatch when standalone (no listener installed)", () => {
    // jsdom default: window.parent === window. Even if a tail-shaped message
    // were dispatched, no listener was installed, so dispatch stays clean.
    startTailListener()?.();
    sendTail(window, true);
    expect(forceMock, "standalone: no force-follow").not.toHaveBeenCalled();
  });
});

describe("tail listener — dispatch + security (embedded)", () => {
  let parent: Window;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    forceMock.mockReset();
    const fake = makeFakeParent();
    parent = fake.parent;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startTailListener();
    expect(dispose, "embedded → disposer returned").toBeDefined();
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  // ---- dispatch table -------------------------------------------------------

  it("following:true → dispatches forceChatTailFollow (the jump-to-latest path)", () => {
    sendTail(parent, true);
    expect(forceMock, "force-follow dispatched").toHaveBeenCalledTimes(1);
    expect(forceMock).toHaveBeenCalledWith();
  });

  it("following:false → validated but NOT dispatched (read-first verdict)", () => {
    // Force-unfollow is not durably expressible in ChatView (the RO/self-heal
    // recoveries re-engage an at-bottom following=false); the listener keeps
    // honoring the closed payload contract but only dispatches the follow path.
    sendTail(parent, false);
    expect(forceMock, "force-unfollow must not dispatch").not.toHaveBeenCalled();
  });

  // ---- inbound source-guard (BEFORE any state mutation) ---------------------

  it("rejects a tail command from a non-parent source (no dispatch)", () => {
    const alien = {} as Window;
    sendTail(alien, true);
    expect(forceMock, "alien source: no force-follow").not.toHaveBeenCalled();
  });

  it("rejects a tail command from window itself as source (not parent)", () => {
    // A self-posted tail command (source === window, not window.parent) must be
    // ignored — the SPA must not drive its own follow state from an injected
    // message.
    sendTail(window, true);
    expect(forceMock).not.toHaveBeenCalled();
  });

  // ---- payload allowlist (CF1: boolean following only) ----------------------

  it("ignores a payload missing following", () => {
    sendTail(parent, undefined);
    expect(forceMock).not.toHaveBeenCalled();
  });

  it("ignores a payload with non-boolean following (string)", () => {
    sendTail(parent, "true");
    expect(forceMock).not.toHaveBeenCalled();
  });

  it("ignores a payload with non-boolean following (number)", () => {
    sendTail(parent, 1);
    expect(forceMock).not.toHaveBeenCalled();
  });

  it("ignores a poison field: dispatches on following:true, drops access_token", () => {
    // CF1: a payload carrying following:true PLUS a poison access_token must
    // still dispatch (the allowlisted field is valid) but the token never
    // reaches the dispatch target — forceChatTailFollow takes no args.
    sendTail(parent, true, { access_token: "SECRET", evil: true });
    expect(forceMock, "allowlisted field dispatched").toHaveBeenCalledTimes(1);
    for (const call of forceMock.mock.calls) {
      expect(call.length, "no payload fields forwarded").toBe(0);
    }
  });

  it("ignores an unrelated message type entirely", () => {
    const ev = new MessageEvent("message", {
      data: { type: "vh-host-select", dir: "/x", session: "s1" },
      origin: "https://host.example",
    });
    Object.defineProperty(ev, "source", { value: parent, writable: false, configurable: true });
    window.dispatchEvent(ev);
    expect(forceMock, "non-tail type ignored").not.toHaveBeenCalled();
  });

  it("ignores non-object data entirely", () => {
    const ev = new MessageEvent("message", {
      data: "vh-host-tail",
      origin: "https://host.example",
    });
    Object.defineProperty(ev, "source", { value: parent, writable: false, configurable: true });
    window.dispatchEvent(ev);
    expect(forceMock, "non-object data ignored").not.toHaveBeenCalled();
  });

  // ---- lifecycle -----------------------------------------------------------

  it("disposer stops dispatch (listener removed)", () => {
    dispose!();
    dispose = undefined;
    sendTail(parent, true);
    expect(forceMock, "no dispatch after dispose").not.toHaveBeenCalled();
  });
});
