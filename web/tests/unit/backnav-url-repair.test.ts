// @vitest-environment jsdom
//
// Real-wiring coverage for the canonical-URL repair path
// (review-defer-backnav-url-repair): imports the PRODUCTION registration
// from src/sync/url.ts (its module init calls registerCanonicalRepair) and
// drives it through the same fake-history harness as backStack.test.ts.
// Two legs demanded by the originating defer:
//   1. token pushed under session A, canonical switches to B while that
//      entry is buried, manager-owned landing on the stale entry → the
//      address is repaired to ?session=B with the LANDED entry's state
//      preserved.
//   2. syncUrl preserves a topmost token's state across a session-change
//      replaceState (only the URL refreshes — the token keeps working).
//
// The fake history does not track URLs (location.href is jsdom's fixed
// default), so "the address" is observed as the URL argument of the
// replaceState calls — unit fidelity for "location ends at ?session=B".
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// url.ts consumes only projectDir from sync/store; stub the heavy store.
vi.mock("../../src/sync/store", () => ({ projectDir: () => null }));

import { backStackDepth, pushBackSurface, __resetBackStackForTest } from "../../src/lib/backStack";
// Importing url.ts REGISTERS the real canonical-URL repair (module side
// effect) — the code under test is the production closure, not a fake.
import { syncUrl } from "../../src/sync/url";

let pushStateSpy: Mock<typeof history.pushState>;
let replaceStateSpy: Mock<typeof history.replaceState>;
let entries: { state: unknown }[];

const top = () => entries[entries.length - 1].state;
// ES2020 lib has no Array.prototype.at — index form (test-only helper).
function lastOf<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}
const lastReplaceCall = () => lastOf(replaceStateSpy.mock.calls)!;
const firePop = () => window.dispatchEvent(new PopStateEvent("popstate", { state: top() }));
// Hardware/browser Back: pop + deliver popstate WITHOUT history.back().
const hardwareBack = () => {
  if (entries.length > 1) entries.pop();
  firePop();
};

describe("canonical-URL repair (real sync/url.ts wiring)", () => {
  beforeEach(() => {
    entries = [{ state: null }];
    Object.defineProperty(window.history, "state", {
      configurable: true,
      get: () => top(),
    });
    pushStateSpy = vi
      .spyOn(history, "pushState")
      .mockImplementation((state) => void entries.push({ state }));
    replaceStateSpy = vi
      .spyOn(history, "replaceState")
      .mockImplementation((state) => void (entries[entries.length - 1] = { state }));
    vi.spyOn(history, "back").mockImplementation(() => {
      if (entries.length > 1) entries.pop();
      firePop();
    });
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
    vi.spyOn(history, "back").mockRestore();
    delete (window.history as { state?: unknown }).state;
    __resetBackStackForTest();
  });

  it("syncUrl preserves a topmost token's state across a session-change replaceState", () => {
    syncUrl("a"); // base entry canonical: ?session=a, plain session state
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);

    const close = vi.fn();
    pushBackSurface(close, "dlg"); // token is now the topmost entry
    const tokenState = top();

    // Session selection switches to B: the token entry's URL refreshes IN
    // PLACE — the token state must survive (only the URL changes).
    syncUrl("b");

    const call = lastReplaceCall();
    expect(call[0]).toBe(tokenState); // the vhBack token state, preserved
    expect(new URL(call[2]!).searchParams.get("session")).toBe("b");
    expect(backStackDepth()).toBe(1); // still exactly one live surface
  });

  it("manager-owned landing on a stale frozen entry repairs the address to the canonical URL, landed state preserved", () => {
    // Canonical is session A on the base entry.
    syncUrl("a");

    // Token 1 pushed under session A (transparent: its entry inherits the
    // push-time URL), then buried under token 2.
    const closeA = vi.fn();
    pushBackSurface(closeA, "dlg-a");
    const tokenAState = top();
    const closeB = vi.fn();
    pushBackSurface(closeB, "dlg-b");

    // Canonical switches to B while token 1's entry is BURIED: only the
    // topmost entry's URL refreshes; token 1 keeps its frozen ?session=a.
    syncUrl("b");
    expect(lastReplaceCall()[0]).toBe(top());

    // Hardware Back lands on token 1's stale entry — a manager-owned
    // traversal (back onto a still-open surface's entry).
    hardwareBack();
    expect(closeB).toHaveBeenCalledTimes(1); // B dismissed, A kept open

    // The registered REAL repair fired: the address is repaired to the
    // canonical ?session=B URL while preserving the LANDED entry's state
    // (token 1's vhBack marker — it keeps working after the repair).
    const call = lastReplaceCall();
    expect(call[0]).toBe(tokenAState); // landed state preserved, not clobbered
    expect(new URL(call[2]!).searchParams.get("session")).toBe("b");
    expect(closeA).not.toHaveBeenCalled(); // A survives as a live surface
    expect(backStackDepth()).toBe(1);
  });
});
