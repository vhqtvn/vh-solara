// @vitest-environment jsdom
//
// Lifecycle test for the code-frame ready/reset contract in code/frame.ts.
// postToCodeFrame must DELIVER directly once the framed viewer has announced
// vh-code:ready, QUEUE (not deliver) after resetCodeFrameReady() clears the
// flag ahead of a known iframe reload, and FLUSH the queued messages to the
// child's source window when it re-announces ready. This is the project-switch
// → ready=false → queue-then-flush path CodeFrame.tsx's createEffect relies on
// (it calls resetCodeFrameReady() on a src() change before the iframe reloads).
//
// jsdom has no matchMedia, but code/frame → ../layout calls window.matchMedia at
// module load. Install a minimal stub BEFORE the frame import is evaluated
// (vi.hoisted runs ahead of static imports).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
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
import { describe, expect, it, vi } from "vitest";
import {
  bindCodeFrame,
  installCodeFrameHost,
  postToCodeFrame,
  resetCodeFrameReady,
} from "../../src/code/frame";

// The module installs its window 'message' listener exactly once (module-level
// `installed` guard). Installing here (at describe evaluation, before tests run)
// makes the listener available to every case; repeat calls are no-ops.
installCodeFrameHost();

// Dispatch a vh-code:ready MessageEvent on window with a controlled `source`.
// The ready handler posts the flushed queue to e.source (NOT the module-level
// frame) so the flush is timing-independent of bindCodeFrame — so we point source
// at our spy window. jsdom's MessageEvent does not always preserve a
// programmatically-set `source`, so define it explicitly on the instance.
function announceReady(spyWin: { postMessage: (m: unknown, o: string) => void }) {
  const ev = new MessageEvent("message", {
    data: { type: "vh-code:ready" },
    origin: location.origin,
  });
  Object.defineProperty(ev, "source", {
    value: spyWin,
    writable: false,
    configurable: true,
  });
  window.dispatchEvent(ev);
}

function fakeFrame(contentWindow: { postMessage: (m: unknown, o: string) => void }) {
  return { contentWindow } as unknown as HTMLIFrameElement;
}

describe("code/frame — ready/reset queue-then-flush lifecycle", () => {
  it("delivers directly when ready, queues after reset, and flushes on the next ready", () => {
    const postMessage = vi.fn();
    const win = { postMessage };
    bindCodeFrame(fakeFrame(win));

    // Child announces ready → ready=true (pending is empty, nothing to flush).
    announceReady(win);

    // ready=true → a post goes straight to the frame's content window.
    const a = { type: "vh-code:open", path: "a" };
    postToCodeFrame(a);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith(a, location.origin);

    // Project switch: clear ready BEFORE the iframe reloads.
    resetCodeFrameReady();

    // ready=false → the post is QUEUED (the torn-down child window is gone), so
    // postMessage is NOT called again.
    const b = { type: "vh-code:open", path: "b" };
    postToCodeFrame(b);
    expect(postMessage).toHaveBeenCalledTimes(1);

    // The reloaded child re-announces ready → the queued `b` flushes to e.source.
    announceReady(win);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(b, location.origin);
  });

  it("queues messages posted before the first ready, then flushes them on ready", () => {
    // Start from a known not-ready state.
    resetCodeFrameReady();
    const postMessage = vi.fn();
    const win = { postMessage };
    bindCodeFrame(fakeFrame(win));

    // Posted while NOT ready → queued, delivered nowhere.
    const early = { type: "vh-code:theme" };
    postToCodeFrame(early);
    expect(postMessage).not.toHaveBeenCalled();

    // Child announces ready → the queued message flushes to e.source.
    announceReady(win);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith(early, location.origin);
  });
});
