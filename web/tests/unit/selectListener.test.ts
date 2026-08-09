// @vitest-environment jsdom
//
// Host→pane reverse-nav select listener (web/src/selectListener.ts).
//
// Pins the dispatch table (same-dir → setSelectedId; cross-dir → switchProject
// + setSelectedId), the inbound security invariants that mirror the
// heartbeat/route/status bridges (embed gate, inbound source-guard BEFORE any
// state mutation, payload allowlist to {dir,session} only), and the no-op
// standalone case. The dispatch targets (setSelectedId/switchProject) are
// mocked so the test asserts the SPA listener's routing, not the sync engine.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the sync dispatch targets so we assert the listener's routing only.
// `projectDir` is a SolidJS accessor (called as projectDir()); mock it as a
// function returning the controllable same-dir/cross-dir discriminator.
// `vi.hoisted` keeps these references alive across vitest's mock-hoisting (the
// mock factory runs BEFORE top-level `const`, so plain consts hit the TDZ).
const mocks = vi.hoisted(() => {
  // A mutable ref so per-test reassignment of the project-dir discriminator
  // is visible to the mock factory's closure.
  const projectDirRef = { current: "/curr" };
  return {
    projectDirRef,
    setSelectedId: vi.fn<(id: string | null) => void>(),
    switchProject: vi.fn<(dir: string, fromUrl?: boolean) => void>(),
  };
});
vi.mock("../../src/sync/store", () => ({
  projectDir: () => mocks.projectDirRef.current,
}));
vi.mock("../../src/sync/actions", () => ({
  // Wire the spies directly so they capture EXACTLY the args the listener
  // passes (a wrapper would add a spurious `undefined` for the default arg).
  setSelectedId: mocks.setSelectedId,
  switchProject: mocks.switchProject,
}));

import { startSelectListener, SELECT_TYPE } from "../../src/selectListener";

const { projectDirRef, setSelectedId: setSelectedIdMock, switchProject: switchProjectMock } = mocks;
const setProjectDir = (v: string): void => {
  projectDirRef.current = v;
};

interface Posted {
  msg: { type?: string } & Record<string, unknown>;
  origin: string;
}

function makeFakeParent(): { parent: Window; posted: Posted[] } {
  const posted: Posted[] = [];
  const parent = {
    postMessage: (msg: unknown, origin: string) => {
      posted.push({ msg: msg as Posted["msg"], origin });
    },
  } as unknown as Window;
  return { parent, posted };
}

/** Dispatch a host→SPA message on window with a programmatically-set `source`.
 *  jsdom's MessageEvent does not always preserve a set source (see
 *  CodeFrameReady.test.ts / heartbeatRouteEmit), so define it explicitly so the
 *  inbound source-guard (`ev.source === window.parent`) passes when intended. */
function sendSelect(
  source: Window,
  dir: unknown,
  session: unknown,
  extra?: Record<string, unknown>,
): void {
  const ev = new MessageEvent("message", {
    data: { type: SELECT_TYPE, dir, session, ...extra },
    origin: "https://host.example",
  });
  Object.defineProperty(ev, "source", {
    value: source,
    writable: false,
    configurable: true,
  });
  window.dispatchEvent(ev);
}

describe("select listener — no-op when standalone (embed gate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setProjectDir("/curr");
    setSelectedIdMock.mockReset();
    switchProjectMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("returns undefined when window.parent === window (standalone)", () => {
    // jsdom default: window.parent === window.
    const dispose = startSelectListener();
    expect(dispose, "standalone → no-op (undefined)").toBeUndefined();
    dispose?.();
  });

  it("does not dispatch a select when standalone (no listener installed)", () => {
    // jsdom default: window.parent === window. Even if a select-shaped message
    // were dispatched, no listener was installed, so dispatch stays clean.
    startSelectListener()?.();
    sendSelect(window, "/x", "s1");
    expect(setSelectedIdMock, "standalone: no setSelectedId").not.toHaveBeenCalled();
    expect(switchProjectMock, "standalone: no switchProject").not.toHaveBeenCalled();
  });
});

describe("select listener — dispatch + security (embedded)", () => {
  let parent: Window;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    setProjectDir("/curr");
    setSelectedIdMock.mockReset();
    switchProjectMock.mockReset();
    const fake = makeFakeParent();
    parent = fake.parent;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startSelectListener();
    expect(dispose, "embedded → disposer returned").toBeDefined();
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  // ---- dispatch table -------------------------------------------------------

  it("same-dir select → setSelectedId only (warm Stream-2 switch)", () => {
    setProjectDir("/curr");
    sendSelect(parent, "/curr", "s1");
    expect(setSelectedIdMock, "same-dir: setSelectedId(session)").toHaveBeenCalledWith("s1");
    expect(switchProjectMock, "same-dir: NO switchProject").not.toHaveBeenCalled();
  });

  it("cross-dir select → switchProject then setSelectedId", () => {
    setProjectDir("/curr");
    sendSelect(parent, "/other", "s2");
    expect(switchProjectMock, "cross-dir: switchProject(dir) once").toHaveBeenCalledTimes(1);
    // switchProject is called WITHOUT fromUrl (default false → syncUrl runs,
    // which pushes the new route, correct for a host-driven select).
    expect(switchProjectMock).toHaveBeenCalledWith("/other");
    expect(setSelectedIdMock, "cross-dir: setSelectedId(session) after switchProject").toHaveBeenCalledWith("s2");
    // Ordering: switchProject must run before setSelectedId (switchProject clears
    // selection via setSelectedIdRaw(null); the follow-up setSelectedId re-selects).
    expect(switchProjectMock.mock.invocationCallOrder[0]).toBeLessThan(
      setSelectedIdMock.mock.invocationCallOrder[0],
    );
  });

  // ---- inbound source-guard (BEFORE any state mutation) ---------------------

  it("rejects a select from a non-parent source (no dispatch)", () => {
    const alien = {} as Window;
    sendSelect(alien, "/curr", "s1");
    expect(setSelectedIdMock, "alien source: no setSelectedId").not.toHaveBeenCalled();
    expect(switchProjectMock, "alien source: no switchProject").not.toHaveBeenCalled();
  });

  it("rejects a select from window itself as source (not parent)", () => {
    // A self-posted select (source === window, not window.parent) must be
    // ignored — the SPA must not drive its own select from an injected message.
    sendSelect(window, "/curr", "s1");
    expect(setSelectedIdMock).not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  // ---- payload allowlist (CF1: dir+session strings only) --------------------

  it("ignores a payload missing dir", () => {
    sendSelect(parent, undefined, "s1");
    expect(setSelectedIdMock).not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("ignores a payload missing session", () => {
    sendSelect(parent, "/curr", undefined);
    expect(setSelectedIdMock).not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("ignores a payload with non-string dir", () => {
    sendSelect(parent, 42, "s1");
    expect(setSelectedIdMock).not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("ignores a payload with non-string session", () => {
    sendSelect(parent, "/curr", { evil: true });
    expect(setSelectedIdMock).not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("ignores a poison field: forwards dir+session, drops access_token", () => {
    // CF1: a payload carrying dir+session PLUS a poison access_token must still
    // dispatch (the allowlisted fields are valid) but the token never reaches
    // the dispatch targets — setSelectedId/switchProject see only the strings.
    setProjectDir("/curr");
    sendSelect(parent, "/curr", "s1", { access_token: "SECRET", evil: true });
    expect(setSelectedIdMock, "allowlisted fields dispatched").toHaveBeenCalledWith("s1");
    // setSelectedId receives ONLY the session string; the token is never passed.
    for (const call of setSelectedIdMock.mock.calls) {
      expect(call[0]).toBe("s1");
    }
  });

  it("ignores an unrelated message type entirely", () => {
    const ev = new MessageEvent("message", {
      data: { type: "vh-host-handshake", nonce: "x" },
      origin: "https://host.example",
    });
    Object.defineProperty(ev, "source", { value: parent, writable: false, configurable: true });
    window.dispatchEvent(ev);
    expect(setSelectedIdMock, "non-select type ignored").not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  // ---- lifecycle -----------------------------------------------------------

  it("disposer stops dispatch (listener removed)", () => {
    setProjectDir("/curr");
    dispose!();
    dispose = undefined;
    sendSelect(parent, "/curr", "s1");
    expect(setSelectedIdMock, "no dispatch after dispose").not.toHaveBeenCalled();
    expect(switchProjectMock).not.toHaveBeenCalled();
  });
});
