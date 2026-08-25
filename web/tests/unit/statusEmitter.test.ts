// @vitest-environment jsdom
//
// P1 session-attention status emitter (web/src/statusEmitter.ts).
//
// Pins the derivation table (all explicit attention/activity values + the
// honest unknown/absent case), the idempotent-on-change emission, and the
// security invariants that mirror the heartbeat/route bridge: embed gate,
// inbound source-guard, captured-origin targeting (never '*'), and
// dir+session as the only routing identifiers.
//
// The store maps are driven directly (same pattern as selectors.test.ts). The
// handshake is delivered with a programmatically-set `source` so the inbound
// source-guard (`ev.source === window.parent`) passes (jsdom does not always
// preserve a set source — see CodeFrameReady.test.ts / heartbeatRouteEmit).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { setState } from "../../src/sync/store";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";
import { startStatusEmitter, derivePaneCounts } from "../../src/statusEmitter";
import { bindChatTail } from "../../src/tailFollow";

const HOST_ORIGIN = "https://host.example";

interface Posted {
  msg: {
    type?: string;
    dir?: string;
    session?: string;
    title?: string;
    attention?: string;
    activity?: string;
  } & Record<string, unknown>;
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

function sendHandshake(source: Window, origin: string): void {
  const ev = new MessageEvent("message", {
    data: { type: "vh-host-handshake" },
    origin,
  });
  Object.defineProperty(ev, "source", {
    value: source,
    writable: false,
    configurable: true,
  });
  window.dispatchEvent(ev);
}

function setUrl(search: string): void {
  window.history.replaceState({}, "", search === "" ? "/" : `/${search}`);
}

const SID = "s1";

function resetStore(): void {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("unread", reconcile({}));
  setState("authoritativeReady", false);
  // The tree flat map is a module singleton (the subtreeBusy rollup source);
  // reset it so a seeded facet never bleeds across cases.
  resetTreeStore();
}

// A minimal tree node for the subtreeBusy rollup tests (same inert-defaults
// shape as childrenIndex.test.ts's tNode — only activity + flags matter to
// sessionWorking).
function tNode(
  id: string,
  opts?: { parentId?: string | null; activity?: string; subtreeBusy?: boolean },
): TreeNode {
  return {
    id,
    parentId: opts?.parentId ?? null,
    title: id,
    activity: (opts?.activity ?? "idle") as TreeNode["activity"],
    childCount: 0,
    loaded: false,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      subtreeBusy: opts?.subtreeBusy,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 0,
  };
}

function resident(title = ""): void {
  setState("sessions", SID, { id: SID, title });
  setState("authoritativeReady", true);
}

function statusMsgs(posted: Posted[]): Posted[] {
  return posted.filter((p) => p.msg.type === "status");
}

describe("status emitter — no-op when standalone (embed gate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setUrl("");
    resetStore();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    setUrl("");
  });

  it("returns undefined when window.parent === window (standalone)", () => {
    // jsdom default: window.parent === window.
    const dispose = startStatusEmitter();
    expect(dispose, "standalone → no-op (undefined)").toBeUndefined();
    dispose?.();
  });
});

describe("status emitter — derivation + emission (embedded)", () => {
  let posted: Posted[];
  let dispose: (() => void) | undefined;
  // Tail-follow bridge binding for the `following` tests. The bridge is module
  // state (late-bound accessor); always unbind so later tests see the honest
  // unbound default (true).
  let unbindTail: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    setUrl(`?session=${SID}`);
    resetStore();
    const fake = makeFakeParent();
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => fake.parent });
    dispose = startStatusEmitter();
    expect(dispose, "embedded → disposer returned").toBeDefined();
  });
  afterEach(() => {
    unbindTail?.();
    unbindTail = undefined;
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    setUrl("");
    resetStore();
  });

  function handshakeAndTick(): void {
    sendHandshake(window.parent, HOST_ORIGIN);
    vi.advanceTimersByTime(1000);
  }

  // ---- security invariants (mirror heartbeat/route exactly) ----------------

  it("holds off until the host handshake arrives (no post before origin captured)", () => {
    // No handshake yet → tick posts nothing (origin not captured).
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "no status before handshake").toBe(0);
    handshakeAndTick();
    expect(statusMsgs(posted).length, "status posted after handshake").toBeGreaterThan(0);
  });

  it("targets the captured host origin — never '*'", () => {
    handshakeAndTick();
    for (const p of statusMsgs(posted)) {
      expect(p.origin, "status reply origin-targeted").toBe(HOST_ORIGIN);
      expect(p.origin, "never the wildcard '*'").not.toBe("*");
    }
  });

  it("rejects a handshake from a non-parent source (inbound source-guard)", () => {
    const alien = {} as Window;
    sendHandshake(alien, "https://attacker.example");
    vi.advanceTimersByTime(1000);
    // Origin never captured from an alien source → no status posted.
    expect(statusMsgs(posted).length, "alien handshake ignored").toBe(0);
  });

  // ---- derivation table: explicit attention values -------------------------

  it("derives attention=needs_permission when permissions map non-empty", () => {
    handshakeAndTick(); // establish + emit baseline (unknown, not resident)
    resident();
    setState("permissions", SID, { p1: { id: "p1", sessionID: SID } });
    vi.advanceTimersByTime(1000);
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.attention).toBe("needs_permission");
  });

  it("derives attention=needs_reply when questions map non-empty", () => {
    handshakeAndTick();
    resident();
    setState("questions", SID, { q1: { id: "q1", sessionID: SID, questions: [] } });
    vi.advanceTimersByTime(1000);
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.attention).toBe("needs_reply");
  });

  it("prioritizes needs_permission over needs_reply when both maps non-empty", () => {
    handshakeAndTick();
    resident();
    setState("questions", SID, { q1: { id: "q1", sessionID: SID, questions: [] } });
    setState("permissions", SID, { p1: { id: "p1", sessionID: SID } });
    vi.advanceTimersByTime(1000);
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.attention, "permission wins over question").toBe("needs_permission");
  });

  it("derives attention=none when both maps empty", () => {
    handshakeAndTick();
    resident();
    vi.advanceTimersByTime(1000);
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.attention).toBe("none");
  });

  // ---- derivation table: explicit activity values --------------------------

  it("derives activity=running when own activity is busy", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "busy");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("running");
  });

  it("derives activity=running when own activity is retry", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "retry");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("running");
  });

  it("derives activity=error when activity map is error", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "error");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("error");
  });

  it("derives activity=done_unread when root unread watermark set + idle", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "idle");
    setState("unread", SID, true); // SID is its own root
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("done_unread");
  });

  it("derives activity=idle when idle and root not unread", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "idle");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("idle");
  });

  it("derives activity=running over done_unread (a busy session is not done)", () => {
    handshakeAndTick();
    resident();
    setState("activity", SID, "busy");
    setState("unread", SID, true);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("running");
  });

  // ---- derivation table: honest unknown ------------------------------------

  it("derives activity=unknown when authoritativeReady is false", () => {
    handshakeAndTick();
    // authoritativeReady stays false (resetStore default) even though the
    // session is in the map — honesty before residency.
    setState("sessions", SID, { id: SID });
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("unknown");
  });

  it("derives activity=unknown when the session is not resident", () => {
    handshakeAndTick();
    setState("authoritativeReady", true);
    // sessions[SID] absent
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("unknown");
  });

  // ---- title + identifiers -------------------------------------------------

  it("carries dir + session from the URL and title from Session.title", () => {
    setUrl("?dir=/proj-x&session=s2");
    setState("sessions", "s2", { id: "s2", title: "Refactor parser" });
    setState("authoritativeReady", true);
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.dir).toBe("/proj-x");
    expect(last.session).toBe("s2");
    expect(last.title).toBe("Refactor parser");
  });

  it("falls title back to '' when Session.title is absent", () => {
    setUrl(`?session=${SID}`);
    setState("sessions", SID, { id: SID }); // no title
    setState("authoritativeReady", true);
    handshakeAndTick();
    expect(statusMsgs(posted).at(-1)!.msg.title).toBe("");
  });

  it("reports the honest no-target state when no session is in the URL", () => {
    setUrl(""); // no session
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.session).toBe("");
    expect(last.attention).toBe("none");
    expect(last.activity).toBe("unknown");
  });

  // ---- idempotent-on-change (NOT an event log) -----------------------------

  it("emits only on change; no-op repeats while the tuple is unchanged", () => {
    resident("T");
    setState("activity", SID, "idle");
    handshakeAndTick();
    const afterFirst = statusMsgs(posted).length;
    expect(afterFirst, "at least one status posted").toBeGreaterThan(0);
    // Two more ticks with NO state change → no additional status messages.
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "unchanged tuple does not re-emit").toBe(afterFirst);
    // A genuine change (idle → busy) emits exactly one more.
    setState("activity", SID, "busy");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "change emits one more").toBe(afterFirst + 1);
    expect(statusMsgs(posted).at(-1)!.msg.activity).toBe("running");
  });

  it("re-emits the current status on re-handshake even when unchanged (C-F1)", () => {
    // C-F1: after a host-shell reload the iframes survive (renderer:'always'),
    // so the SPA document is unchanged and `lastKey` still holds the pre-reload
    // status key. Without a reset on re-handshake the emitter would (wrongly)
    // consider the current status already-emitted and the host's IN-MEMORY
    // statusByPane (lost on host reload, unlike route which is persisted) would
    // stay empty while the heartbeat recovers → attention badges silently
    // vanish. The handshake listener resets lastKey so the next tick re-posts.
    resident("T");
    setState("activity", SID, "idle");
    handshakeAndTick();
    const afterFirst = statusMsgs(posted).length;
    expect(afterFirst, "baseline status posted").toBeGreaterThan(0);
    const emittedStatus = { ...statusMsgs(posted).at(-1)!.msg };

    // Two ticks with NO state change → no additional status (idempotent-on-change).
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "unchanged tuple does not re-emit").toBe(afterFirst);

    // A SECOND handshake (a host-shell reload re-handshakes) resets lastKey →
    // the next tick re-posts the CURRENT status even though nothing changed.
    sendHandshake(window.parent, HOST_ORIGIN);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "re-handshake re-emits the current status").toBe(afterFirst + 1);
    const reEmitted = statusMsgs(posted).at(-1)!.msg;
    expect(reEmitted.attention).toBe(emittedStatus.attention);
    expect(reEmitted.activity).toBe(emittedStatus.activity);
    expect(reEmitted.title).toBe(emittedStatus.title);
    expect(reEmitted.session).toBe(emittedStatus.session);
  });

  // ---- tail-follow (following) ----------------------------------------------

  it("carries following=true when the chat is at the tail (bridge default)", () => {
    resident();
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.following, "unbound bridge → honest on default").toBe(true);
  });

  it("carries following=false when the bound chat reads history", () => {
    // Bind a ChatView-like accessor reporting the reader scrolled up; the next
    // tick's status must carry following=false.
    unbindTail = bindChatTail(
      () => false,
      () => {},
    );
    resident();
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.following, "bound accessor false → reported").toBe(false);
  });

  it("reports following=true when no session is open (nothing to not-follow)", () => {
    setUrl(""); // no session
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.session).toBe("");
    expect(last.following, "no session → honest on default").toBe(true);
  });

  it("a following flip re-emits (following is in the idempotence key)", () => {
    resident("T");
    setState("activity", SID, "idle");
    handshakeAndTick();
    const afterFirst = statusMsgs(posted).length;
    expect(afterFirst, "baseline status posted").toBeGreaterThan(0);
    expect(statusMsgs(posted).at(-1)!.msg.following).toBe(true);

    // The operator scrolls up inside the pane → the bridge reports false → the
    // next tick emits exactly one more status (key change), carrying false.
    unbindTail = bindChatTail(
      () => false,
      () => {},
    );
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "following flip re-emits").toBe(afterFirst + 1);
    expect(statusMsgs(posted).at(-1)!.msg.following).toBe(false);

    // Stable false → no further emissions (idempotent-on-change).
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "unchanged following does not re-emit").toBe(afterFirst + 1);
  });

  it("disposer stops emission (listener removed, interval cleared)", () => {
    resident();
    handshakeAndTick();
    const before = statusMsgs(posted).length;
    dispose!();
    dispose = undefined;
    setState("activity", SID, "busy"); // would change the tuple
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "no emission after dispose").toBe(before);
  });

  // ---- TAB-PAIRS: per-pane aggregates (runningCount + unreadCount) ---------
  // Derivation contract (ROOT GRANULARITY, operator directive — subsessions
  // never inflate the pair): running = ROOT sessions where sessionWorking()
  // holds (own busy|retry OR the server-computed subtreeBusy rollup — the same
  // predicate the sidebar's working indicator uses); unread = ROOT sessions
  // carrying the server watermark. Both derive from server-authoritative store
  // maps ONLY, which is what makes the host-rendered (X|Y) identical across
  // devices by construction.

  it("derivePaneCounts: empty dir → 0/0", () => {
    expect(derivePaneCounts()).toEqual({ runningCount: 0, unreadCount: 0 });
  });

  it("derivePaneCounts: all idle (root + subsession) → 0/0", () => {
    setState("sessions", "r", { id: "r" });
    setState("sessions", "c", { id: "c", parentID: "r" });
    setState("activity", "r", "idle");
    setState("activity", "c", "idle");
    expect(derivePaneCounts()).toEqual({ runningCount: 0, unreadCount: 0 });
  });

  it("derivePaneCounts: running counts busy+retry ROOTS, not idle/error (two busy roots → X=2)", () => {
    setState("sessions", "a", { id: "a" });
    setState("sessions", "b", { id: "b" });
    setState("sessions", "c", { id: "c" });
    setState("sessions", "d", { id: "d" });
    setState("activity", "a", "busy");
    setState("activity", "b", "retry");
    setState("activity", "c", "idle");
    setState("activity", "d", "error");
    expect(derivePaneCounts().runningCount, "busy+retry roots only").toBe(2);
    expect(derivePaneCounts().unreadCount, "no unread roots").toBe(0);
  });

  it("derivePaneCounts: busy root + busy subsession → X=1 (root granularity; was 2)", () => {
    // The operator directive: a subsession's own activity must NOT add a
    // second count on top of its root.
    setState("sessions", "r", { id: "r" });
    setState("sessions", "c", { id: "c", parentID: "r" });
    setState("activity", "r", "busy");
    setState("activity", "c", "busy");
    expect(derivePaneCounts().runningCount, "root+sub both busy → ONE running root").toBe(1);
  });

  it("derivePaneCounts: orphaned-parent session counts as a root (busy orphan → runningCount 1)", () => {
    // The orphaned-parent disjunct of the root enumeration: parentID is set
    // but points at a session NOT resident in state.sessions (the parent
    // left the store) — the session still enumerates as a root, so its busy
    // activity counts. Pins the `state.sessions[p]` residency check against
    // a future `if (p) continue;` "simplification" that would silently stop
    // counting busy orphans while the rest of the suite stays green.
    setState("sessions", "o", { id: "o", parentID: "missing" });
    setState("activity", "o", "busy");
    expect(derivePaneCounts().runningCount, "busy orphan counts as a root").toBe(1);
  });

  it("derivePaneCounts: idle root + busy subsession → X=1 via the subtreeBusy rollup (chosen default)", () => {
    // PIN THE ROLLUP DEFAULT: the root's OWN activity is idle; the server
    // rolls its busy descendant up into flags.subtreeBusy on the root (the
    // same facet the sidebar indicator trusts), and sessionWorking() ORs it
    // in — so the root still counts as running. The stricter own-activity-only
    // reading would report 0 here (see the REVERSIBLE DEFAULT note in
    // derivePaneCounts).
    setState("sessions", "r", { id: "r" });
    setState("sessions", "c", { id: "c", parentID: "r" });
    setState("activity", "c", "busy");
    // Before the tree facet lands, the count never walks children itself
    // (sessionWorking's self-only fallback) → the honest interim value is 0.
    expect(derivePaneCounts().runningCount, "no facet yet → no client-side subtree walk").toBe(0);
    // The tree snapshot lands carrying the server-computed rollup → X=1.
    seedTreeStore([
      tNode("r", { subtreeBusy: true }),
      tNode("c", { parentId: "r", activity: "busy" }),
    ]);
    expect(derivePaneCounts().runningCount, "rollup: busy sub keeps root working").toBe(1);
  });

  it("derivePaneCounts: unread counts the unread ROOT once (subsessions never add)", () => {
    // Tree: root r → children c1, c2; separate root s. Only r is unread.
    setState("sessions", "r", { id: "r" });
    setState("sessions", "c1", { id: "c1", parentID: "r" });
    setState("sessions", "c2", { id: "c2", parentID: "r" });
    setState("sessions", "s", { id: "s" });
    setState("unread", "r", true);
    expect(derivePaneCounts().unreadCount, "3 sessions under one unread root → 1").toBe(1);
    expect(derivePaneCounts().runningCount).toBe(0);
    // A busy SUBSESSION alone does NOT count as running either (root r's own
    // activity is idle and no subtreeBusy facet is seeded — root granularity
    // means the pair speaks only for roots).
    setState("activity", "c1", "busy");
    expect(derivePaneCounts().runningCount, "busy subsession alone does not count").toBe(0);
  });

  it("carries runningCount + unreadCount on the emitted status", () => {
    setState("sessions", SID, { id: SID });
    setState("activity", SID, "busy");
    setState("unread", SID, true);
    handshakeAndTick();
    const last = statusMsgs(posted).at(-1)!.msg;
    expect(last.runningCount).toBe(1);
    expect(last.unreadCount).toBe(1);
  });

  it("a count change re-emits (counts are in the idempotence key)", () => {
    setState("sessions", SID, { id: SID });
    setState("activity", SID, "idle");
    handshakeAndTick();
    const afterFirst = statusMsgs(posted).length;
    expect(afterFirst, "baseline posted").toBeGreaterThan(0);
    expect(statusMsgs(posted).at(-1)!.msg.runningCount).toBe(0);

    // No change → no re-emit.
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length).toBe(afterFirst);

    // A session goes busy → the aggregate change re-emits exactly once.
    setState("activity", SID, "busy");
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "count change re-emits").toBe(afterFirst + 1);
    expect(statusMsgs(posted).at(-1)!.msg.runningCount).toBe(1);

    // An unread watermark lands (server busy→idle elsewhere in the dir) →
    // another single re-emit.
    setState("sessions", "r2", { id: "r2" });
    setState("unread", "r2", true);
    vi.advanceTimersByTime(1000);
    expect(statusMsgs(posted).length, "unread change re-emits").toBe(afterFirst + 2);
    expect(statusMsgs(posted).at(-1)!.msg.unreadCount).toBe(1);
  });
});
