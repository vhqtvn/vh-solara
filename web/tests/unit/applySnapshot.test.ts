// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { gzipSync } from "node:zlib";
import { applySnapshot, applySessionEvent, applySessionSnapshot, applyMessageEvent, decodeMessagesBatch, resetTreeStreamStateForTesting, getBranchRequestGenForTesting, lazyExpandBranch } from "../../src/sync/stream";
import { state, setState, setSelectedIdRaw } from "../../src/sync/store";
import { sessionLastAgent } from "../../src/sync/selectors";
import type { Snapshot } from "../../src/types";

// B2a (resync-window gating of lastAgents) + B2b (session.delete prunes the
// per-session maps) integration coverage. These drive the REAL applySnapshot /
// applySessionEvent against the singleton sync store (the selectors.test.ts
// convention), so they need jsdom for the window.setTimeout that bumpUpdating()
// / persist() schedule. applySnapshot is the tree stream's sole reconciliation
// entry point and does NOT call refreshOpenSessions (that lives in the
// EventSource handler), so these tests make no network calls.

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty — a true reset (selectors.test.ts pattern).
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("messages", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({})); // F5: was leaking across tests
  setState("refreshing", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("currentVerbs", reconcile({}));
  setState("expandedBranches", reconcile({}));
  setState("branchStubs", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
  // Reset the open-session signal so a prior test's selection can't exempt a
  // session from the stub-demotion reconcile (isolates the reconcile cases).
  setSelectedIdRaw(null);
  resetTreeStreamStateForTesting();
});

describe("applySnapshot — B2a resync-window lastAgents gating", () => {
  it("merge-protects a prev label when the epoch just changed (transition snapshot)", () => {
    setState("epoch", "oldEpoch");
    setState("lastAgents", "s1", "build");
    const snap: Snapshot = {
      seq: 1,
      epoch: "newEpoch", // epoch transition → resync window
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } },
      // mid-aggregation: server omits s1's label, but the FE already knows "build"
      lastAgents: { s2: "plan" },
    };
    applySnapshot(snap);
    // s1 preserved (merge-protect); s2's incoming label applied.
    expect(state.lastAgents.s1).toBe("build");
    expect(state.lastAgents.s2).toBe("plan");
    // The transition latches the flag for the toast and advances the epoch.
    expect(state.epochChanged).toBe(true);
    expect(state.epoch).toBe("newEpoch");
  });

  it("merge-protects a prev label when a session is hydrated===false (no epoch change)", () => {
    setState("epoch", "stable");
    setState("lastAgents", reconcile({ s1: "build", s2: "plan" }));
    const snap: Snapshot = {
      seq: 2,
      epoch: "stable", // NO epoch transition
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: false } }, // s2 mid-aggregation
      // server omits s2 (still pulling its tail); s1 updated authoritatively
      lastAgents: { s1: "ship" },
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBe("ship"); // incoming non-empty wins
    expect(state.lastAgents.s2).toBe("plan"); // FE label preserved (merge-protect)
    expect(state.epochChanged).toBe(false); // no epoch transition latched
  });

  it("merge-protects while the latched epochChanged flag is still set (toast not yet consumed)", () => {
    setState("epoch", "stable");
    setState("epochChanged", true); // a recent transition the toast hasn't cleared yet
    setState("lastAgents", reconcile({ s1: "build" }));
    const snap: Snapshot = {
      seq: 3,
      epoch: "stable", // epoch now stable, all hydrated
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } },
      lastAgents: { s2: "plan" }, // server omits s1
    };
    applySnapshot(snap);
    // Still inside the resync window (latch set) → s1's FE label preserved.
    expect(state.lastAgents.s1).toBe("build");
    expect(state.lastAgents.s2).toBe("plan");
  });

  it("wholesale-replaces lastAgents when stable + all hydrated (legitimate clears propagate)", () => {
    setState("epoch", "stable");
    setState("lastAgents", reconcile({ s1: "build", s2: "plan" }));
    const snap: Snapshot = {
      seq: 4,
      epoch: "stable", // no transition
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } }, // all hydrated
      // authoritative: s2 legitimately cleared (its latest assistant no longer
      // has an agent / recomputed messages yield none)
      lastAgents: { s1: "ship" },
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBe("ship"); // updated
    expect(state.lastAgents.s2).toBeUndefined(); // cleared — NO merge-protect
  });

  it("does NOT force resync when gate is omitted (older daemon) + epoch stable", () => {
    // An older daemon that omits snap.gate entirely must still get wholesale
    // replace when the epoch is stable — otherwise the overcorrection returns
    // for every such daemon (clears never propagate). Only EXPLICIT
    // hydrated===false counts toward the resync window.
    setState("epoch", "stable");
    setState("lastAgents", "s1", "build");
    const snap: Snapshot = {
      seq: 5,
      epoch: "stable",
      sessions: [{ id: "s1" }],
      // gate omitted; authoritative snapshot clears s1
      lastAgents: {},
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBeUndefined(); // cleared
  });
});

describe("applySessionEvent — B2b session.delete prunes per-session maps", () => {
  it("deletes lastAgents/messagesLoaded/messagesError/refreshing alongside the session", () => {
    setState("sessions", "s1", { id: "s1" });
    setState("lastAgents", "s1", "build");
    setState("messagesLoaded", "s1", true);
    setState("messagesError", "s1", true);
    setState("refreshing", "s1", true);

    applySessionEvent("session.delete", 99, { id: "s1" });

    expect(state.sessions.s1).toBeUndefined();
    expect(state.lastAgents.s1).toBeUndefined();
    expect(state.messagesLoaded.s1).toBeUndefined();
    expect(state.messagesError.s1).toBeUndefined();
    expect(state.refreshing.s1).toBeUndefined();
    expect(state.cursor).toBe(99); // the cursor still advances on a tracked event
  });

  it("does not prune metadata on session.upsert (only the session row is touched)", () => {
    setState("lastAgents", "s1", "build");
    applySessionEvent("session.upsert", 7, { id: "s1", title: "t" });
    expect(state.sessions.s1).toEqual({ id: "s1", title: "t" });
    expect(state.lastAgents.s1).toBe("build"); // untouched
  });
});

// Slice C — async selected-session hydration. The Stream-2 first-open snapshot
// no longer waits for the upstream full-message fetch: a hydrating snapshot
// (gate.messagesLoaded===false) must keep the loading UI up until the explicit
// messages.loaded completion event lands (or a re-snapshot reports loaded).
describe("applySessionSnapshot / applyMessageEvent — Slice C async hydration", () => {
  it("a HYDRATING partial snapshot does NOT mark the session delivered", () => {
    // openSession sets messagesLoaded=false on open; the hydrating snapshot must
    // NOT flip it to true (only messages.loaded / a loaded gate does).
    setState("messagesLoaded", "s1", false);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } }, // background fetch still in flight
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    // messages slice is populated (empty order) but the delivery flag stays false
    // so the transcript shows "loading" rather than "delivered-and-empty".
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messages.s1).toBeDefined();
  });

  it("a FULL snapshot (messagesLoaded true) marks the session delivered", () => {
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: true } },
      messages: { s1: [{ info: { id: "m1", sessionID: "s1", role: "user" }, parts: [] }] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messages.s1.order).toEqual(["m1"]);
  });

  it("an older daemon (gate.messagesLoaded omitted) stays delivered (back-compat)", () => {
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: {} }, // no messagesLoaded field → undefined !== false → delivered
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(true);
  });

  it("a hydrating snapshot ACTIVELY clears a stale delivered=true (daemon restart case)", () => {
    // A session that was previously delivered (messagesLoaded===true, e.g. the
    // daemon restarted / epoch changed while the session was open and stale
    // delivered state lingers) must be flipped BACK to loading when a hydrating
    // partial snapshot (gate.messagesLoaded===false) overwrites messages[id].
    // Otherwise the empty-order snapshot renders "delivered-and-empty".
    setState("messagesLoaded", "s1", true);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } },
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messages.s1).toBeDefined();
  });

  it("messages.loaded flips the delivery flag (the completion signal)", () => {
    setState("messagesLoaded", "s1", false); // was hydrating
    applyMessageEvent("messages.loaded", 42, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    // trackCursor:false → Stream 2 must NOT advance the shared resume cursor.
    expect(state.cursor).toBe(0);
  });

  it("messages.loaded fires even when the fetch returned no message.* deltas", () => {
    // Empty/unchanged fetch: no message.upsert would ever land, but the
    // completion event still flips the flag → "delivered-and-empty".
    setState("messagesLoaded", "s1", false);
    applyMessageEvent("messages.loaded", 43, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
  });

  it("messages.error sets messagesError + keeps messagesLoaded false", () => {
    setState("messagesLoaded", "s1", false);
    applyMessageEvent("messages.error", 44, { sessionID: "s1", error: "boom" }, false);
    // messages.error is NOT completion, so it must NOT flip the delivery flag
    // (messagesLoaded stays false — a true here would show a misleading empty
    // view). But 4fa8255 sets a SEPARATE messagesError flag so ChatView's reveal
    // gate (revealed = ready && (delivered || messageFailed)) releases: a failed
    // hydration reveals whatever partial content we have + an error hint instead
    // of wedging on the loading UI forever (messages.loaded never arrives on
    // failure). So the old "keeps loading UI up" claim misdescribes post-4fa8255
    // behavior; only "messagesLoaded stays false" is still accurate.
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messagesError.s1).toBe(true);
  });

  it("messages.loaded clears a prior messagesError (retry success supersedes failure)", () => {
    // A later successful load must clear a past failure flag so the reveal gate
    // stops treating the session as "failed/partial" (stream.ts messages.loaded).
    setState("messagesLoaded", "s1", false);
    setState("messagesError", "s1", true);
    applyMessageEvent("messages.loaded", 50, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messagesError.s1).toBeUndefined();
  });

  it("a DELIVERED session snapshot clears a prior messagesError", () => {
    // A snapshot whose gate reports the full history (messagesLoaded !== false)
    // supersedes a prior background-hydration failure (retry after error, or a
    // Stream-2 reconnect that re-snapshots loaded) (stream.ts else-branch).
    setState("messagesError", "s1", true);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: true } }, // delivered
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messagesError.s1).toBeUndefined();
  });

  it("a PARTIAL snapshot (gate.messagesLoaded===false) clears a prior messagesError", () => {
    // F3/F4 regression guard: a hydration attempt's partial snapshot is the
    // client-side "hydration started" signal that fires for BOTH openSession-
    // driven hydration AND a Stream-2 reconnect retry (which does NOT call
    // openSession). It must proactively clear a stale messagesError so the
    // reveal gate does not release on the prior failure while a retry is already
    // in flight (otherwise the chat shows the "select again to retry" hint
    // during an in-flight retry). If the retry ALSO fails, messages.error
    // re-sets the flag.
    setState("messagesError", "s1", true);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } }, // partial — fetch in flight
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messagesError.s1).toBeUndefined();
  });

  it("message.upsert arriving BEFORE completion is applied without claiming loaded", () => {
    // Stream 2 forwards reconciled deltas on the same connection as the fetch;
    // they can land before messages.loaded. They must populate the transcript
    // but not flip the delivery flag (only messages.loaded does). The
    // message.upsert payload is the FLAT MessageInfo ({id,sessionID,role}).
    setState("messagesLoaded", "s1", false);
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "message.upsert",
      40,
      { id: "m1", sessionID: "s1", role: "user" },
      false,
    );
    expect(state.messages.s1.order).toContain("m1");
    expect(state.messagesLoaded.s1).toBe(false);
  });

  it("messages.batch wholesale-sets the transcript (cold-load structural fix)", () => {
    // Fix #3: a cold-load collapses the N per-message/per-part upserts into ONE
    // messages.batch carrying the full reconciled list. The client ingests it in
    // a single buildMessages mutation (the same path applySessionSnapshot uses
    // for a warm snapshot) — NOT as N individual events. Decoupled from the
    // reveal gate: content only; messages.loaded (still emitted after the batch)
    // flips messagesLoaded. So a batch landing while messagesLoaded===false
    // stages the content but does NOT claim loaded.
    setState("messagesLoaded", "s1", false);
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "messages.batch",
      41,
      {
        sessionID: "s1",
        messages: [
          { info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "a" }] },
          { info: { id: "m2", sessionID: "s1", role: "assistant", time: { created: 2 } }, parts: [{ id: "p2", sessionID: "s1", messageID: "m2", type: "text", text: "b" }] },
        ],
      },
      false,
    );
    // Wholesale set: both messages + both parts present, in order.
    expect(state.messages.s1.order).toEqual(["m1", "m2"]);
    expect(state.messages.s1.byId.m1.parts.p2).toBeUndefined();
    expect(state.messages.s1.byId.m1.parts.p1).toBeDefined();
    expect(state.messages.s1.byId.m2.parts.p2).toBeDefined();
    // The batch carries CONTENT; it must NOT flip the delivery flag (the gate
    // still waits for messages.loaded — P1-WEB-020 reveal gate is load-bearing).
    expect(state.messagesLoaded.s1).toBe(false);
    // trackCursor:false → Stream 2 must NOT advance the shared resume cursor.
    expect(state.cursor).toBe(0);

    // messages.loaded AFTER the batch flips the gate open (content was staged).
    applyMessageEvent("messages.loaded", 42, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    // Content survived — the wholesale set is not clobbered by the gate flip.
    expect(state.messages.s1.order).toEqual(["m1", "m2"]);
  });

  it("messages.batch ingest path works with a gzip+base64 compressed payload (decode then apply)", async () => {
    // End-to-end of the new compressed cold-load: the server emits
    // {sessionID, encoding:"gzip64", data: base64(gzip({"messages":[...]}))}.
    // The stream.ts listener decodes via decodeMessagesBatch THEN hands the
    // decoded {sessionID, messages} to applyMessageEvent's "messages.batch"
    // case (unchanged). This pins the decode→apply contract the listener
    // relies on: the case must keep reading payload.sessionID + payload.messages.
    setState("messagesLoaded", "s7", false);
    setState("messages", "s7", { order: [], byId: {} });
    const messages = [
      { info: { id: "m1", sessionID: "s7", role: "user", time: { created: 1 } }, parts: [{ id: "p1", sessionID: "s7", messageID: "m1", type: "text", text: "a" }] },
      { info: { id: "m2", sessionID: "s7", role: "assistant", time: { created: 2 } }, parts: [{ id: "p2", sessionID: "s7", messageID: "m2", type: "text", text: "b" }] },
    ];
    const data = Buffer.from(gzipSync(Buffer.from(JSON.stringify({ messages })))).toString("base64");
    // Mirrors the listener body: decode first, then apply the decoded payload.
    const decoded = await decodeMessagesBatch({ sessionID: "s7", encoding: "gzip64", data });
    applyMessageEvent("messages.batch", 50, decoded, false);
    // Wholesale set landed; gate NOT flipped (content-only, like the raw case).
    expect(state.messages.s7.order).toEqual(["m1", "m2"]);
    expect(state.messages.s7.byId.m1.parts.p1).toBeDefined();
    expect(state.messages.s7.byId.m2.parts.p2).toBeDefined();
    expect(state.messagesLoaded.s7).toBe(false);
    expect(state.cursor).toBe(0); // trackCursor:false
    // The subsequent gate flip still works after the compressed ingest.
    applyMessageEvent("messages.loaded", 51, { sessionID: "s7" }, false);
    expect(state.messagesLoaded.s7).toBe(true);
    expect(state.messages.s7.order).toEqual(["m1", "m2"]);
  });
});

// Cold-tree chip regression: the daemon's background cold seed
// (seedColdLastAgents, a non-blocking goroutine) usually completes AFTER this
// client's first snapshot landed, so Snapshot.LastAgents carried nothing for
// the un-opened session and the per-agent chip stayed blank until the session
// was opened. The seed now pushes a live "lastAgent.set" event; the chip must
// render from it BEFORE any session is opened. sessionLastAgent backs the chip.
describe("applyMessageEvent — lastAgent.set cold-seed live patch (tree chip)", () => {
  it("renders the cold chip from a live lastAgent.set event before any session is opened", () => {
    // No messages loaded, no seeded label → no chip.
    expect(sessionLastAgent("cold")).toBeUndefined();
    // The background seed delivers the label as a live event after the snapshot.
    applyMessageEvent("lastAgent.set", 1, { sessionID: "cold", agent: "build" });
    expect(state.lastAgents.cold).toBe("build");
    // sessionLastAgent is what AgentChip reads; it must now resolve to "build".
    expect(sessionLastAgent("cold")).toBe("build");
  });

  it("clears the cold chip when an empty agent arrives", () => {
    setState("lastAgents", "cold", "build");
    applyMessageEvent("lastAgent.set", 2, { sessionID: "cold", agent: "" });
    expect(state.lastAgents.cold).toBeUndefined();
    expect(sessionLastAgent("cold")).toBeUndefined();
  });

  it("keeps live-scan precedence: a loaded session shows its real agent, not the seeded value", () => {
    // A live event would overwrite the seed map, but the selector MUST still
    // prefer the authoritative message scan once messages are loaded.
    setState("lastAgents", "live", "stale");
    setState("messages", "live", {
      order: ["m1"],
      byId: {
        m1: { id: "m1", info: { id: "m1", sessionID: "live", role: "assistant", agent: "real" }, partOrder: [], parts: {} },
      },
    });
    applyMessageEvent("lastAgent.set", 3, { sessionID: "live", agent: "seeded" });
    // The event updated the seed map (mirroring the daemon), but the chip reads
    // the live assistant turn's agent, NOT the stale/seeded value.
    expect(state.lastAgents.live).toBe("seeded");
    expect(sessionLastAgent("live")).toBe("real");
  });
});

// Phase 2 Gate A — projected snapshot merge path. When snap.projected is true,
// applySnapshot takes the MERGE branch: sessions absent from the array are
// PRESERVED as hidden (NOT deleted). Only an explicit session.delete event
// removes a session. This is the core contract of the collapsed-frontier
// projection: the server ships only roots + active closure + frontier stubs,
// and the client must not infer deletion from omission.
//
// Capability matrix (old↔new × query params):
//   old client (no proj param) → new server: AUTHORITY_COMPLETE → wholesale-replace
//   new client (proj=1)        → old server (ignores proj=1): AUTHORITY_COMPLETE (no `projected` field) → wholesale-replace
//   new client (proj=1)        → new server (Phase 4+): projected:true → merge
// Phase 2 server still emits AUTHORITY_COMPLETE regardless of proj=1; the merge
// path is exercised here with synthetic projected snapshots.
describe("applySnapshot — Phase 2 Gate A projected merge path", () => {
  it("PRESERVES absent sessions when projected:true (hidden !== deleted)", () => {
    // Seed two sessions via AUTHORITY_COMPLETE (the existing wholesale-replace path).
    applySnapshot({
      seq: 1,
      epoch: "e1",
      sessions: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }],
    });
    expect(state.sessions.s1).toBeDefined();
    expect(state.sessions.s2).toBeDefined();

    // A PROJECTED snapshot carries ONLY s1 (s2 is collapsed behind a frontier
    // stub on the server). s2 must be PRESERVED on the client.
    applySnapshot({
      seq: 2,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1", title: "A-updated" }],
    });
    expect(state.sessions.s1).toEqual({ id: "s1", title: "A-updated" }); // upserted
    expect(state.sessions.s2).toBeDefined(); // PRESERVED — not deleted
    expect((state.sessions.s2 as any).title).toBe("B"); // unchanged
  });

  it("DELETES absent sessions when projected is absent (AUTHORITY_COMPLETE regression guard)", () => {
    // Seed two sessions.
    applySnapshot({
      seq: 1,
      epoch: "e1",
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    expect(state.sessions.s1).toBeDefined();
    expect(state.sessions.s2).toBeDefined();

    // AUTHORITY_COMPLETE (no projected field) with only s1 → s2 is DELETED.
    applySnapshot({
      seq: 2,
      epoch: "e1",
      sessions: [{ id: "s1" }],
    });
    expect(state.sessions.s1).toBeDefined();
    expect(state.sessions.s2).toBeUndefined(); // DELETED — wholesale-replace
  });

  it("only session.delete removes a session in projected mode", () => {
    // Seed via AUTHORITY_COMPLETE.
    applySnapshot({
      seq: 1,
      epoch: "e1",
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    // Projected snapshot omits s2 — it's preserved.
    applySnapshot({
      seq: 2,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1" }],
    });
    expect(state.sessions.s2).toBeDefined(); // still there
    // An explicit session.delete event removes s2 — even in projected mode.
    applySessionEvent("session.delete", 3, { id: "s2" });
    expect(state.sessions.s2).toBeUndefined(); // now deleted
    expect(state.sessions.s1).toBeDefined(); // untouched
  });

  it("merges activity (upsert incoming, preserve absent)", () => {
    setState("activity", "s1", "busy");
    setState("activity", "s2", "idle");
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1" }],
      activity: { s1: "idle" }, // s1 changed busy→idle; s2 absent
    });
    expect(state.activity.s1).toBe("idle"); // updated
    expect(state.activity.s2).toBe("idle"); // preserved (hidden, still idle)
  });

  it("merges lastAgents (incoming non-empty wins, absent preserved)", () => {
    setState("lastAgents", "s1", "build");
    setState("lastAgents", "s2", "plan");
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1" }],
      lastAgents: { s1: "ship" }, // s1 updated; s2 absent
    });
    expect(state.lastAgents.s1).toBe("ship"); // updated
    expect(state.lastAgents.s2).toBe("plan"); // preserved
  });

  it("replaces permissions per-session for included sessions, preserves absent", () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    setState("permissions", "s2", { p2: { id: "p2" } as any });
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1" }],
      permissions: { s1: [{ id: "p3" }] }, // s1 perms replaced; s2 absent
    });
    expect(state.permissions.s1).toEqual({ p3: { id: "p3" } }); // replaced
    expect(state.permissions.s2).toEqual({ p2: { id: "p2" } }); // preserved
  });

  it("clears expandedBranches on epoch change in projected mode", () => {
    setState("epoch", "oldEpoch");
    setState("expandedBranches", "branch1", true);
    setState("expandedBranches", "branch2", true);
    applySnapshot({
      seq: 1,
      epoch: "newEpoch", // epoch transition
      projected: true,
      sessions: [],
    });
    expect(state.epochChanged).toBe(true);
    expect(state.epoch).toBe("newEpoch");
    expect(Object.keys(state.expandedBranches)).toHaveLength(0); // cleared
  });

  it("preserves expandedBranches when epoch is stable in projected mode", () => {
    setState("epoch", "stable");
    setState("expandedBranches", "branch1", true);
    applySnapshot({
      seq: 1,
      epoch: "stable", // no epoch change
      projected: true,
      sessions: [],
    });
    expect(state.expandedBranches.branch1).toBe(true); // preserved
  });

  it("advances cursor in projected mode", () => {
    setState("cursor", 5);
    applySnapshot({
      seq: 10,
      epoch: "e1",
      projected: true,
      sessions: [],
    });
    expect(state.cursor).toBe(10);
  });

  it("capability matrix: old server (no projected field) → wholesale-replace even with proj=1 on the wire", () => {
    // Simulates a new client (sends proj=1) talking to an OLD server that
    // ignores proj=1 and emits AUTHORITY_COMPLETE (no `projected` field).
    // The client must fall back to wholesale-replace.
    applySnapshot({
      seq: 1,
      epoch: "e1",
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    // Old server sends a complete snapshot without `projected` — s2 absent → deleted.
    applySnapshot({
      seq: 2,
      epoch: "e1",
      sessions: [{ id: "s1" }], // no projected field
    });
    expect(state.sessions.s2).toBeUndefined(); // wholesale-replace deleted it
  });

  it("does NOT touch messages/messagesLoaded (transcript orthogonality — Gate F)", () => {
    // Seed s2 as a session + its message stream (simulating an opened session
    // with loaded msgs).
    applySnapshot({
      seq: 0,
      epoch: "e1",
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    setState("messages", "s2", { order: ["m1"], byId: { m1: { id: "m1" } } });
    setState("messagesLoaded", "s2", true);
    // A projected snapshot that omits s2 entirely.
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      sessions: [{ id: "s1" }],
    });
    // s2's session is preserved (hidden), and its TRANSCRIPT is also untouched.
    expect(state.sessions.s2).toBeDefined(); // hidden, not deleted
    expect(state.messagesLoaded.s2).toBe(true); // transcript delivery flag intact
    expect(state.messages.s2).toBeDefined(); // transcript data intact
  });
});

// Phase 3 Gate B — structuralRevision monotonicity guard. The client tracks
// lastAppliedStructuralRevision: < → discard stale, == → idempotent skip,
// > → apply. Reset on epoch change. Undefined (old server / fresh client) →
// always apply. These tests exercise the AUTHORITY_COMPLETE path (projected
// absent) since structuralRevision is stamped on BOTH paths.
describe("applySnapshot — Phase 3 structuralRevision guard", () => {
  const EPOCH = "struct-rev-test-epoch";

  // Helper: build a minimal complete snapshot with the given revision + sessions.
  function snap(rev: number | undefined, sessions: { id: string }[], seq = 1): Snapshot {
    return {
      seq,
      epoch: EPOCH,
      sessions,
      structuralRevision: rev,
    };
  }

  it("applies when revision is undefined (old server / fresh client)", () => {
    setState("epoch", EPOCH);
    applySnapshot(snap(undefined, [{ id: "a" }, { id: "b" }]));
    expect(state.sessions.a).toBeDefined();
    expect(state.sessions.b).toBeDefined();
  });

  it("applies when revision > lastApplied (> newer)", () => {
    setState("epoch", EPOCH);
    applySnapshot(snap(1, [{ id: "a" }]));
    applySnapshot(snap(2, [{ id: "a" }, { id: "b" }]));
    expect(state.sessions.a).toBeDefined();
    expect(state.sessions.b).toBeDefined();
  });

  it("skips when revision === lastApplied (== idempotent)", () => {
    setState("epoch", EPOCH);
    applySnapshot(snap(1, [{ id: "a" }]));
    // Apply a second snapshot with same revision but different sessions.
    // The guard should skip it (idempotent) — state unchanged.
    applySnapshot(snap(1, [{ id: "a" }, { id: "b" }]));
    expect(state.sessions.a).toBeDefined();
    expect(state.sessions.b).toBeUndefined(); // NOT applied — idempotent skip
  });

  it("discards when revision < lastApplied (< stale)", () => {
    setState("epoch", EPOCH);
    applySnapshot(snap(5, [{ id: "a" }]));
    // A stale response with a lower revision must be discarded.
    applySnapshot(snap(3, [{ id: "a" }, { id: "b" }]));
    expect(state.sessions.a).toBeDefined();
    expect(state.sessions.b).toBeUndefined(); // NOT applied — stale discard
  });

  it("resets on epoch change (new epoch → always apply)", () => {
    setState("epoch", EPOCH);
    applySnapshot(snap(10, [{ id: "a" }]));
    // Epoch change → lastAppliedStructuralRevision resets → always apply,
    // even if the incoming revision is lower.
    applySnapshot({
      seq: 2,
      epoch: "new-epoch",
      sessions: [{ id: "a" }, { id: "c" }],
      structuralRevision: 1, // lower than 10, but epoch changed → apply
    });
    expect(state.sessions.a).toBeDefined();
    expect(state.sessions.c).toBeDefined(); // applied despite lower revision
  });

  it("guards projected snapshots too (projected path records revision)", () => {
    setState("epoch", EPOCH);
    // First: seed with a complete snapshot at revision 1.
    applySnapshot(snap(1, [{ id: "a" }]));
    // A projected snapshot at revision 1 with the SAME seq is a genuine
    // duplicate → idempotent skip (caught-up seq, not a full-rebuild cause).
    applySnapshot({
      seq: 1,
      epoch: EPOCH,
      sessions: [{ id: "a" }, { id: "b" }],
      projected: true,
      structuralRevision: 1, // same rev, same seq → genuine dup → skip
    });
    expect(state.sessions.b).toBeUndefined(); // NOT applied — idempotent skip
    // Third: a projected snapshot at revision 2 (>) — should be applied.
    applySnapshot({
      seq: 3,
      epoch: EPOCH,
      sessions: [{ id: "a" }, { id: "c" }],
      projected: true,
      structuralRevision: 2, // newer → apply
    });
    expect(state.sessions.c).toBeDefined(); // applied
  });
});

describe("applySnapshot — Phase 4 stubs merge/replace/prune", () => {
  const EPOCH = "ep4";
  const stub = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    kind: "collapsed-branch" as const,
    hasChildren: true,
    descendantCount: 5,
    aggregateState: "idle" as const,
    ...over,
  });

  it("upserts stubs on initial projected snapshot (full replace)", () => {
    setState("epoch", EPOCH);
    setState("branchStubs", { stale: stub("stale") });
    applySnapshot({
      seq: 1,
      epoch: EPOCH,
      sessions: [{ id: "active" }],
      projected: true,
      cause: "initial",
      structuralRevision: 1,
      stubs: [stub("r1"), stub("r2")],
    });
    expect(state.branchStubs.r1).toBeDefined();
    expect(state.branchStubs.r2).toBeDefined();
    // "stale" was cleared by the full replace.
    expect(state.branchStubs.stale).toBeUndefined();
  });

  it("replaces stubs on promotion (server re-projects full frontier)", () => {
    setState("epoch", EPOCH);
    // Seed stubs.
    setState("branchStubs", {
      old1: stub("old1"),
      old2: stub("old2"),
    });
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      sessions: [{ id: "promoted" }],
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      stubs: [stub("new1")],
    });
    // Promotion replaces the entire stub map.
    expect(state.branchStubs.new1).toBeDefined();
    expect(state.branchStubs.old1).toBeUndefined();
    expect(state.branchStubs.old2).toBeUndefined();
  });

  it("merges stubs on lazy-expand (partial branch expansion)", () => {
    setState("epoch", EPOCH);
    // Seed stubs from initial projection.
    setState("branchStubs", {
      root1: stub("root1"),
      root2: stub("root2"),
    });
    applySnapshot({
      seq: 3,
      epoch: EPOCH,
      sessions: [{ id: "child1" }, { id: "child2" }],
      projected: true,
      cause: "lazy-expand",
      structuralRevision: 3,
      stubs: [stub("grand1"), stub("grand2")],
    });
    // Merge: new stubs added, existing stubs preserved.
    expect(state.branchStubs.grand1).toBeDefined();
    expect(state.branchStubs.grand2).toBeDefined();
    expect(state.branchStubs.root1).toBeDefined(); // preserved
    expect(state.branchStubs.root2).toBeDefined(); // preserved
  });

  it("clears stubs on epoch change (server restart invalidates them)", () => {
    setState("epoch", "oldEpoch");
    setState("branchStubs", {
      r1: stub("r1"),
      r2: stub("r2"),
    });
    applySnapshot({
      seq: 5,
      epoch: "newEpoch",
      sessions: [{ id: "a" }],
      projected: true,
      structuralRevision: 1,
      stubs: [stub("r3")],
    });
    // Epoch change clears the stub map first, then upserts incoming.
    expect(state.branchStubs.r3).toBeDefined();
    expect(state.branchStubs.r1).toBeUndefined(); // cleared by epoch change
    expect(state.branchStubs.r2).toBeUndefined();
  });

  it("prunes stub on session.delete event", () => {
    setState("epoch", EPOCH);
    setState("branchStubs", {
      doomed: stub("doomed"),
      survivor: stub("survivor"),
    });
    applySessionEvent("session.delete", 10, { id: "doomed" });
    expect(state.branchStubs.doomed).toBeUndefined();
    expect(state.branchStubs.survivor).toBeDefined();
  });

  it("merges stubs when cause is absent (backward compatible)", () => {
    setState("epoch", EPOCH);
    setState("branchStubs", {
      existing: stub("existing"),
    });
    applySnapshot({
      seq: 7,
      epoch: EPOCH,
      sessions: [{ id: "a" }],
      projected: true,
      structuralRevision: 7,
      stubs: [stub("added")],
      // cause absent → merge path
    });
    expect(state.branchStubs.added).toBeDefined();
    expect(state.branchStubs.existing).toBeDefined(); // preserved (merge)
  });
});

describe("applySnapshot — Phase 6 cutoff tracking", () => {
  const EPOCH = "ep6";

  it("applies projected snapshot with cutoff fields without error", () => {
    setState("epoch", EPOCH);
    applySnapshot({
      seq: 1,
      epoch: EPOCH,
      sessions: [{ id: "a" }],
      projected: true,
      cause: "initial",
      structuralRevision: 1,
      cutoffVersion: 1,
      cutoffMs: 600000,
      stubs: [],
    });
    expect(state.sessions.a).toBeDefined();
  });

  it("applies projected snapshot with changed cutoffVersion", () => {
    setState("epoch", EPOCH);
    // First snapshot with cutoffVersion 1.
    applySnapshot({
      seq: 1,
      epoch: EPOCH,
      sessions: [{ id: "a" }],
      projected: true,
      cause: "initial",
      structuralRevision: 1,
      cutoffVersion: 1,
      cutoffMs: 600000,
    });
    // Second snapshot with bumped cutoffVersion + different cutoffMs.
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      sessions: [{ id: "a" }, { id: "b" }],
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      cutoffVersion: 2,
      cutoffMs: 300000, // 5min instead of 10min
    });
    // The cutoff change should NOT block the apply — the structuralRevision
    // guard handles ordering; cutoffVersion is diagnostic tracking only.
    expect(state.sessions.b).toBeDefined();
  });

  it("resets cutoff tracking on epoch change", () => {
    setState("epoch", "oldEpoch");
    // Seed with cutoffVersion 5.
    applySnapshot({
      seq: 10,
      epoch: "oldEpoch",
      sessions: [{ id: "a" }],
      projected: true,
      structuralRevision: 10,
      cutoffVersion: 5,
      cutoffMs: 600000,
    });
    // Epoch change: cutoffVersion 1 from the new server should apply
    // (lower than 5, but epoch change resets the guard).
    applySnapshot({
      seq: 1,
      epoch: "newEpoch",
      sessions: [{ id: "a" }, { id: "c" }],
      projected: true,
      structuralRevision: 1,
      cutoffVersion: 1,
      cutoffMs: 600000,
    });
    expect(state.sessions.c).toBeDefined(); // applied despite lower revision
  });

  it("applies projected snapshot without cutoff fields (old server)", () => {
    setState("epoch", EPOCH);
    // A projected snapshot from an old server that doesn't stamp cutoff
    // fields should still apply correctly (backward compatible).
    applySnapshot({
      seq: 1,
      epoch: EPOCH,
      sessions: [{ id: "a" }],
      projected: true,
      structuralRevision: 1,
      // cutoffVersion + cutoffMs absent
    });
    expect(state.sessions.a).toBeDefined();
  });
});

// Stub-demotion reconcile. When a session goes idle the server demotes it from
// the active closure: the next FULL projected snapshot (cause=initial/promotion/
// reconnect/resync, or an epoch change) emits it as a CollapsedBranchStub in
// snap.stubs AND omits it from snap.sessions. The client rebuilds branchStubs
// wholesale but the session preserve-absent rule left its stale payload in
// state.sessions — so both coexisted for the same id (the render-layer guard
// already hid the duplicate row). These cases pin the reconcile that prunes the
// stale state.sessions entry on the full-rebuild paths only, never on
// lazy-expand, never for an absent-but-not-stub session (Gate A), never for the
// open session, and never the per-session metadata maps (collapsed ≠ deleted).
describe("applySnapshot — stub-demotion reconcile prunes stale state.sessions", () => {
  // Minimal valid CollapsedBranchStub for a demoted session (matches the wire
  // shape from src/types.ts; parentID omitted since these are root stubs).
  const demoted = (id: string) => ({
    id,
    kind: "collapsed-branch" as const,
    hasChildren: true,
    descendantCount: 1,
    aggregateState: "idle" as const,
  });

  it("prunes a session the server demoted to a stub on a promotion snapshot", () => {
    const EPOCH = "stub-prune-ep1";
    setState("epoch", EPOCH);
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" }); // s2 will be demoted to a stub
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "s1" }], // s2 omitted from the active closure
      stubs: [demoted("s2")], // ...and emitted as a stub (demoted)
    });
    // s2 pruned from state.sessions — no stale materialized payload lingering
    // alongside its stub (the merge-layer invariant now matches the server).
    expect(state.sessions.s2).toBeUndefined();
    expect(state.sessions.s1).toBeDefined(); // active survivor remains
    expect(state.branchStubs.s2).toBeDefined(); // the demotion is recorded
  });

  it("does NOT prune on lazy-expand (partial branch expansion keeps stale sessions)", () => {
    const EPOCH = "stub-prune-ep2";
    setState("epoch", EPOCH);
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" });
    applySnapshot({
      seq: 3,
      epoch: EPOCH,
      projected: true,
      cause: "lazy-expand", // partial expansion — NOT a full rebuild
      structuralRevision: 3,
      sessions: [{ id: "s1" }],
      stubs: [demoted("s2")],
    });
    // s2 preserved — reconcile must NOT fire on lazy-expand (a partial snapshot
    // legitimately omits still-active sessions materialized elsewhere).
    expect(state.sessions.s2).toBeDefined();
    // The stub is still merged into the stub map.
    expect(state.branchStubs.s2).toBeDefined();
  });

  it("preserves a deep idle child collapsed under a stub (Gate A intact)", () => {
    const EPOCH = "stub-prune-ep3";
    setState("epoch", EPOCH);
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" }); // root, demoted → pruned
    // s3 is a DEEP child of s2 (parentID="s2"). When s2 is collapsed into a
    // stub, s3's subtree is NOT enumerated by the server frontier — the
    // frontier is exhaustive only one level deep under a MATERIALIZED (active)
    // parent. s2 is a stub (not materialized), so s3 must be PRESERVED (Gate A:
    // omission ≠ deletion where the frontier is not authoritative). [DEFER #1]
    setState("sessions", "s3", { id: "s3", parentID: "s2" });
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "s1" }],
      stubs: [demoted("s2")], // only s2 demoted; s3 hidden under s2's stub
    });
    expect(state.sessions.s2).toBeUndefined(); // demoted (stub present) → pruned
    expect(state.sessions.s3).toBeDefined(); // deep idle child → preserved (Gate A)
    expect(state.sessions.s1).toBeDefined();
  });

  it("preserves the currently-open session even when it is demoted to a stub", () => {
    const EPOCH = "stub-prune-ep4";
    setState("epoch", EPOCH);
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" });
    setSelectedIdRaw("s2"); // s2 is the viewed session — exempt from the prune
    try {
      applySnapshot({
        seq: 2,
        epoch: EPOCH,
        projected: true,
        cause: "promotion",
        structuralRevision: 2,
        sessions: [{ id: "s1" }],
        stubs: [demoted("s2")],
      });
      // s2 stays materialized — dropping its payload would blank
      // SessionInspector/ChatView mid-view. The render-layer guard already
      // hides its stub, so skipping the prune loses nothing.
      expect(state.sessions.s2).toBeDefined();
      expect(state.branchStubs.s2).toBeDefined(); // stub still recorded
    } finally {
      setSelectedIdRaw(null); // don't leak the selection into other tests
    }
  });

  it("does NOT prune per-session metadata when a session is demoted to a stub", () => {
    const EPOCH = "stub-prune-ep5";
    setState("epoch", EPOCH);
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" });
    setState("lastAgents", "s2", "build");
    setState("activity", "s2", "idle");
    setState("permissions", "s2", { p1: { id: "p1" } as any });
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "s1" }],
      stubs: [demoted("s2")],
    });
    // s2 pruned from sessions (collapsed into a stub), but its metadata
    // SURVIVES — the session is NOT deleted and may be re-materialized on a
    // later lazy-expand (this is the key difference from session.delete, which
    // DOES prune these maps; see applySessionEvent above).
    expect(state.sessions.s2).toBeUndefined();
    expect(state.lastAgents.s2).toBe("build");
    expect(state.activity.s2).toBe("idle");
    expect(state.permissions.s2).toEqual({ p1: { id: "p1" } });
  });

  it("prunes a demoted session on an epoch-change full rebuild too", () => {
    setState("epoch", "oldEpoch");
    setState("sessions", "s1", { id: "s1" });
    setState("sessions", "s2", { id: "s2" });
    applySnapshot({
      seq: 1,
      epoch: "newEpoch", // epoch transition → full rebuild (changed === true)
      projected: true,
      structuralRevision: 1,
      sessions: [{ id: "s1" }],
      stubs: [demoted("s2")],
    });
    // The reconcile fires on the epoch-change full-rebuild path as well.
    expect(state.sessions.s2).toBeUndefined();
    expect(state.sessions.s1).toBeDefined();
    expect(state.branchStubs.s2).toBeDefined();
    expect(state.epochChanged).toBe(true); // epoch transition latched
  });
});

// Theme 1 — reconnect/replay authority. Finding #1 (ring-gap snapshot at the
// SAME structuralRevision discarded wholesale → stale facets + cursor stall),
// Finding #2 / DEFER #5 (cursor-replay must re-establish the projected
// frontier), and DEFER #1 (ghost sessions after localStorage hydration).
describe("applySnapshot — Theme 1 reconnect/replay authority", () => {
  const demoted = (id: string) => ({
    id,
    kind: "collapsed-branch" as const,
    hasChildren: false,
    descendantCount: 0,
    aggregateState: "idle" as const,
  });

  // Finding #1 (CRITICAL): a ring-gap (4096 missed NON-structural events) →
  // reconnect → server sends a fresh snapshot at the SAME structuralRevision
  // (topology unchanged) but a newer seq with reconciled facets. The old guard
  // discarded it wholesale (== → skip), leaving stale facets AND a stalled
  // cursor while the server had advanced its baseline. Now: same-rev + newer-seq
  // merges authoritative facets + advances the cursor; topology is not regressed
  // (same rev ⟹ same topology ⟹ merge is non-regressing).
  it("Finding #1: same-revision newer-seq reconnect reconciles facets + advances cursor", () => {
    const EPOCH = "ring-gap-ep";
    setState("epoch", EPOCH);
    // Seed a projected full-rebuild at rev=10, seq=100 with stale facets.
    applySnapshot({
      seq: 100,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 10,
      sessions: [{ id: "a" }],
      activity: { a: "busy" },
      permissions: { a: [{ id: "p1" }] },
      stubs: [demoted("b")],
    });
    expect(state.activity.a).toBe("busy");
    expect(state.permissions.a).toEqual({ p1: { id: "p1" } });
    expect(state.cursor).toBe(100);

    // Ring-gap reconnect: same rev (topology unchanged), newer seq, reconciled
    // facets (a went idle, perms cleared, b still a stub).
    applySnapshot({
      seq: 5000,
      epoch: EPOCH,
      projected: true,
      cause: "reconnect",
      structuralRevision: 10, // SAME revision
      sessions: [{ id: "a" }],
      activity: { a: "idle" }, // busy → idle
      permissions: { a: [] }, // cleared
      stubs: [demoted("b")], // topology unchanged
    });
    // Facets reconciled (NOT wholesale-skipped):
    expect(state.activity.a).toBe("idle"); // would stay "busy" without the fix
    expect(state.permissions.a).toEqual({}); // would stay {p1} without the fix
    // Cursor advanced to the reconnect seq:
    expect(state.cursor).toBe(5000); // would stay 100 without the fix
    // Topology not regressed: a still materialized, b still a stub.
    expect(state.sessions.a).toBeDefined();
    expect(state.branchStubs.b).toBeDefined();
  });

  // Finding #2 / DEFER #5 (client half): a cause=reconnect snapshot MUST apply
  // even when its seq is already caught up (seq <= cursor) — this is what
  // reconstructs the ephemeral frontier stubs after a page reload where the
  // server's cursor-replay succeeded (no events to catch up) but the stubs were
  // lost (branchStubs is never persisted). Without the fullRebuild exemption the
  // caught-up idempotency skip would leave the stubs missing.
  it("Finding #2: cause=reconnect rebuilds frontier stubs even at a caught-up seq", () => {
    const EPOCH = "reconnect-stubs-ep";
    setState("epoch", EPOCH);
    // Initial projection establishes the frontier: a active, b a stub.
    applySnapshot({
      seq: 100,
      epoch: EPOCH,
      projected: true,
      cause: "initial",
      structuralRevision: 7,
      sessions: [{ id: "a" }],
      stubs: [demoted("b")],
    });
    expect(state.branchStubs.b).toBeDefined();
    expect(state.cursor).toBe(100);

    // Simulate a page reload: ephemeral branchStubs are lost (never persisted),
    // but cursor survives in localStorage.
    setState("branchStubs", reconcile({}));
    expect(state.branchStubs.b).toBeUndefined();

    // Server replay succeeds (no events to catch up) then emits a reconnect
    // snapshot at the SAME seq/rev to re-establish the frontier.
    applySnapshot({
      seq: 100, // caught-up seq (<= cursor)
      epoch: EPOCH,
      projected: true,
      cause: "reconnect", // fullRebuild → exempt from the caught-up skip
      structuralRevision: 7, // same revision
      sessions: [{ id: "a" }],
      stubs: [demoted("b")],
    });
    // Frontier stubs reconstructed (would stay missing without the exemption):
    expect(state.branchStubs.b).toBeDefined();
  });

  // DEFER #1: a ghost ROOT — a client root that's absent from BOTH snap.sessions
  // and stubs under a full-rebuild was deleted server-side (every server root is
  // either active-in-snap or an idle stub). It must be pruned so it doesn't
  // render after localStorage hydration when its session.delete fell outside the
  // replay ring.
  it("DEFER #1: prunes a ghost root absent from snap.sessions and stubs on full rebuild", () => {
    const EPOCH = "ghost-root-ep";
    setState("epoch", EPOCH);
    // Client state after hydration: alive root + a ghost root (server-deleted,
    // session.delete missed outside the replay ring).
    setState("sessions", "alive", { id: "alive" });
    setState("sessions", "ghost", { id: "ghost" });
    // Full-rebuild promotion: alive materialized; ghost absent from BOTH.
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "alive" }],
      stubs: [], // ghost is NOT a stub → it's a ghost
    });
    expect(state.sessions.alive).toBeDefined();
    expect(state.sessions.ghost).toBeUndefined(); // ghost root pruned
  });

  // DEFER #1: a ghost CHILD of a materialized parent. Under an active parent
  // the frontier is exhaustive one level deep — every non-active child is a
  // stub — so a child absent from both snap.sessions and stubs was deleted.
  it("DEFER #1: prunes a ghost child of a materialized parent", () => {
    const EPOCH = "ghost-child-ep";
    setState("epoch", EPOCH);
    // parent is active (materialized); ghostchild was deleted server-side.
    setState("sessions", "parent", { id: "parent" });
    setState("sessions", "ghostchild", { id: "ghostchild", parentID: "parent" });
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "parent" }],
      stubs: [], // ghostchild NOT a stub → ghost (parent materialized)
    });
    expect(state.sessions.parent).toBeDefined();
    expect(state.sessions.ghostchild).toBeUndefined(); // ghost child pruned
  });

  // DEFER #1: the open/viewed session is exempt from the ghost prune (dropping
  // its payload would blank the inspector mid-view; the render-layer guard hides
  // its stub). Mirrors the demotion-reconcile open-session exemption.
  it("DEFER #1: does NOT prune the open session even if it is a ghost", () => {
    const EPOCH = "ghost-open-ep";
    setState("epoch", EPOCH);
    setState("sessions", "alive", { id: "alive" });
    setState("sessions", "ghostopen", { id: "ghostopen" });
    setSelectedIdRaw("ghostopen"); // viewed → exempt
    try {
      applySnapshot({
        seq: 2,
        epoch: EPOCH,
        projected: true,
        cause: "promotion",
        structuralRevision: 2,
        sessions: [{ id: "alive" }],
        stubs: [],
      });
      expect(state.sessions.ghostopen).toBeDefined(); // exempt — still materialized
    } finally {
      setSelectedIdRaw(null);
    }
  });

  // DEFER #1: a child whose parent is itself hidden (a stub, not materialized)
  // is PRESERVED — the frontier is not authoritative there (deep idle subtree).
  // (Companion to the deep-child case in the stub-demotion describe block.)
  it("DEFER #1: preserves a child whose parent is a collapsed stub (not materialized)", () => {
    const EPOCH = "ghost-deep-ep";
    setState("epoch", EPOCH);
    setState("sessions", "root", { id: "root" });
    setState("sessions", "collapsed", { id: "collapsed", parentID: "root" }); // demoted → stub
    setState("sessions", "deep", { id: "deep", parentID: "collapsed" }); // under collapsed stub
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "root" }],
      stubs: [demoted("collapsed")], // collapsed is a stub, not materialized
    });
    expect(state.sessions.collapsed).toBeUndefined(); // demoted (stub present)
    expect(state.sessions.deep).toBeDefined(); // preserved — parent hidden, frontier not authoritative
  });

  // F1 advisory (commit-review 3-leaf consensus): isolate the PURE ring-gap
  // fall-through — same-rev + newer-seq + NO fullRebuild cause. The guard has
  // two independent escape hatches from the caught-up idempotency skip:
  // (a) fullRebuild cause set, (b) seq newer than cursor (caughtUp=false). This
  // locks branch (b) so a regression that dropped fullRebuild OR broke the seq
  // comparison is caught. (In production a projected snapshot reaching this
  // function always carries a fullRebuild cause; this is a guard-logic unit.)
  it("Finding #1: same-revision newer-seq merges even without a fullRebuild cause", () => {
    const EPOCH = "ring-gap-nocause-ep";
    setState("epoch", EPOCH);
    applySnapshot({
      seq: 100,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 10,
      sessions: [{ id: "a" }],
      activity: { a: "busy" },
    });
    expect(state.activity.a).toBe("busy");
    expect(state.cursor).toBe(100);

    // Same rev, newer seq, NO fullRebuild cause (cause absent → fullRebuild=false).
    // caughtUp is false (seq 5000 > cursor 100) → falls through via branch (b).
    applySnapshot({
      seq: 5000,
      epoch: EPOCH,
      projected: true,
      // cause intentionally absent → fullRebuild=false
      structuralRevision: 10, // SAME revision
      sessions: [{ id: "a" }],
      activity: { a: "idle" },
    });
    expect(state.activity.a).toBe("idle"); // merged, not wholesale-skipped
    expect(state.cursor).toBe(5000); // cursor advanced
  });
});

describe("applySnapshot — Theme 2 projected-clear facets", () => {
  // Finding #4 / DEFER #4: a projected snapshot's `sessions` array is the
  // active closure the server MATERIALIZED. For those sessions the server is
  // authoritative on every per-session facet — a facet ABSENT from a PRESENT
  // facet-map means CLEARED server-side, so a stale client value must clear.
  // This closes the same stale-facet class as stale-busy: a missed
  // permission.delete / question.delete / unread.clear / activity-verb-clear no
  // longer leaves a stale "needs input"/permission/verb lingering on a
  // materialized session. Hidden sessions (behind a stub) stay preserved (Gate A).
  const demoted = (id: string, parentID = "") => ({
    id,
    parentID,
    kind: "collapsed-branch" as const,
    hasChildren: false,
    descendantCount: 0,
    aggregateState: "idle" as const,
  });
  // A minimal projected snapshot materializing exactly `ids` with every facet
  // map PRESENT-but-empty (mirrors SnapshotProjected, which inits each map).
  // An absent facet here ⇒ cleared on the client for each materialized id.
  const projectedClear = (ids: string[], stubs: ReturnType<typeof demoted>[] = []) => ({
    seq: 2,
    epoch: state.epoch,
    projected: true as const,
    cause: "promotion" as const,
    structuralRevision: 2,
    sessions: ids.map((id) => ({ id })),
    stubs,
    permissions: {},
    questions: {},
    lastAgents: {},
    currentVerbs: {},
    unread: [],
  });

  it("Finding #4: clears stale permissions on a materialized session", () => {
    const EPOCH = "perm-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("permissions", "a", { p1: { id: "p1" } });
    expect(state.permissions.a).toEqual({ p1: { id: "p1" } });
    applySnapshot(projectedClear(["a"]));
    expect(state.permissions.a).toBeUndefined(); // cleared (would stay {p1} without the fix)
  });

  it("Finding #4: clears stale questions on a materialized session", () => {
    const EPOCH = "q-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("questions", "a", { q1: { id: "q1" } });
    applySnapshot(projectedClear(["a"]));
    expect(state.questions.a).toBeUndefined(); // cleared
  });

  it("DEFER #4: clears stale unread on a materialized session", () => {
    const EPOCH = "unread-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("unread", "a", true);
    expect(state.unread.a).toBe(true);
    applySnapshot(projectedClear(["a"]));
    expect(state.unread.a).toBeUndefined(); // cleared (would stay true without the fix)
  });

  it("Finding #4: clears stale currentVerbs on a materialized session", () => {
    const EPOCH = "verb-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("currentVerbs", "a", { tool: "bash", state: "running" });
    applySnapshot(projectedClear(["a"]));
    expect(state.currentVerbs.a).toBeUndefined(); // cleared
  });

  it("Finding #4: clears stale lastAgents on a materialized session", () => {
    const EPOCH = "agent-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("lastAgents", "a", "Claude");
    applySnapshot(projectedClear(["a"]));
    expect(state.lastAgents.a).toBeUndefined(); // cleared
  });

  it("Finding #4: preserves facets on a HIDDEN session behind a stub (Gate A)", () => {
    const EPOCH = "hidden-preserve-ep";
    setState("epoch", EPOCH);
    // a is materialized; b is a child collapsed behind a stub (hidden, not
    // materialized). Seed stale facets on b — they must survive because b is
    // NOT in the materialized set (the server didn't speak for b's facets).
    setState("sessions", "a", { id: "a" });
    setState("sessions", "b", { id: "b", parentID: "a" });
    setState("permissions", "b", { p1: { id: "p1" } });
    setState("questions", "b", { q1: { id: "q1" } });
    setState("unread", "b", true);
    setState("currentVerbs", "b", { tool: "bash", state: "running" });
    setState("lastAgents", "b", "Claude");
    // Materialize ONLY a; b is demoted to a stub.
    applySnapshot(projectedClear(["a"], [demoted("b", "a")]));
    // b's facets preserved (would be cleared by an over-aggressive fix):
    expect(state.permissions.b).toEqual({ p1: { id: "p1" } });
    expect(state.questions.b).toEqual({ q1: { id: "q1" } });
    expect(state.unread.b).toBe(true);
    expect(state.currentVerbs.b).toEqual({ tool: "bash", state: "running" });
    expect(state.lastAgents.b).toBe("Claude");
  });

  it("Finding #4: an ABSENT facet map (omitempty-dropped empty) clears materialized facets", () => {
    // A projected snapshot ALWAYS builds all facet maps server-side. When every
    // materialized session clears a facet, the map is empty → Go's omitempty
    // drops it on the wire → the client sees `undefined`. Treating absent-as-
    // empty (cleared) closes this gap; the old "defensive preserve" let the
    // stale facet linger indefinitely.
    const EPOCH = "absent-map-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("lastAgents", "a", "Claude");
    setState("permissions", "a", { p1: { id: "p1" } });
    setState("currentVerbs", "a", { tool: "bash", state: "running" });
    // Snapshot materializes a but carries NO lastAgents / permissions /
    // currentVerbs fields at all (simulating omitempty dropping empty maps).
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "a" }],
      questions: {},
      unread: [],
      // lastAgents / permissions / currentVerbs intentionally omitted entirely
    });
    expect(state.lastAgents.a).toBeUndefined(); // cleared (absent = omitempty-dropped empty)
    expect(state.permissions.a).toBeUndefined(); // cleared
    expect(state.currentVerbs.a).toBeUndefined(); // cleared
  });

  it("Finding #4: ALL facet maps absent simultaneously (bulk-clear) clears everything", () => {
    // The all-empty-map edge case: when the server clears every facet for every
    // materialized session, ALL maps are empty → ALL dropped by omitempty → the
    // client sees a snapshot with NO facet fields at all. Without treating
    // absent-as-empty, ALL stale facets would persist — the exact stale-facet
    // class this theme closes.
    const EPOCH = "bulk-clear-ep";
    setState("epoch", EPOCH);
    setState("sessions", "a", { id: "a" });
    setState("permissions", "a", { p1: { id: "p1" } });
    setState("questions", "a", { q1: { id: "q1" } });
    setState("unread", "a", true);
    setState("currentVerbs", "a", { tool: "bash", state: "running" });
    setState("lastAgents", "a", "Claude");
    // Snapshot materializes a but carries NO facet maps at all.
    applySnapshot({
      seq: 2,
      epoch: EPOCH,
      projected: true,
      cause: "promotion",
      structuralRevision: 2,
      sessions: [{ id: "a" }],
      // ALL facet maps intentionally omitted (omitempty simulation)
    });
    expect(state.permissions.a).toBeUndefined();
    expect(state.questions.a).toBeUndefined();
    expect(state.unread.a).toBeUndefined();
    expect(state.currentVerbs.a).toBeUndefined();
    expect(state.lastAgents.a).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Theme 3: anti-resurrection (branchRequestGen guard) + no-loop pagination.
// Finding #3: lazyExpandBranch must NOT resurrect a child deleted/reparented
//   while a branch-expand fetch was in flight.
// Finding #6: branch pagination must terminate (not restart at page 0 / loop)
//   when the cursor child was deleted/reparented.
// ---------------------------------------------------------------------------
describe("Theme 3 anti-resurrection (branchRequestGen)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bumps branchRequestGen on session.delete", () => {
    const gen0 = getBranchRequestGenForTesting();
    applySessionEvent("session.delete", 1, { id: "x" });
    expect(getBranchRequestGenForTesting()).toBe(gen0 + 1);
  });

  it("bumps branchRequestGen on session.upsert", () => {
    const gen0 = getBranchRequestGenForTesting();
    applySessionEvent("session.upsert", 1, { id: "y", parentID: "p" });
    expect(getBranchRequestGenForTesting()).toBe(gen0 + 1);
  });

  it("bumps branchRequestGen on a projected full-rebuild snapshot (promotion)", () => {
    const gen0 = getBranchRequestGenForTesting();
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      cause: "promotion",
      structuralRevision: 1,
      sessions: [{ id: "a" }],
    });
    expect(getBranchRequestGenForTesting()).toBe(gen0 + 1);
  });

  it("bumps branchRequestGen on AUTHORITY_COMPLETE (non-projected) snapshot", () => {
    const gen0 = getBranchRequestGenForTesting();
    applySnapshot({ seq: 1, sessions: [{ id: "a" }] });
    expect(getBranchRequestGenForTesting()).toBe(gen0 + 1);
  });

  it("does NOT bump branchRequestGen on a lazy-expand cause snapshot", () => {
    const gen0 = getBranchRequestGenForTesting();
    applySnapshot({
      seq: 1,
      epoch: "e1",
      projected: true,
      cause: "lazy-expand",
      structuralRevision: 1,
      sessions: [{ id: "a" }],
    });
    expect(getBranchRequestGenForTesting()).toBe(gen0);
  });

  it("lazyExpandBranch does NOT resurrect a session deleted mid-fetch (Finding #3)", async () => {
    // Seed: branch stub "B" with child session "a".
    setState("sessions", { B: { id: "B" }, a: { id: "a", parentID: "B" } });
    setState("branchStubs", {
      B: { id: "B", kind: "collapsed-branch", parentID: "", title: "B", hasChildren: true },
    });

    // Fetch mock: first call returns STALE data (includes deleted "a"); second
    // call (the retry under fresh gen) returns CLEAN data (no "a").
    const staleBody = JSON.stringify({
      seq: 100,
      projected: true,
      cause: "lazy-expand",
      sessions: [{ id: "a", parentID: "B" }],
      stubs: [],
    });
    const cleanBody = JSON.stringify({
      seq: 101,
      projected: true,
      cause: "lazy-expand",
      sessions: [],
      stubs: [],
    });

    let callCount = 0;
    let resolveFirst!: (r: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1) return firstPromise;
        return Promise.resolve(
          new Response(cleanBody, {
            status: 200,
            headers: { "X-VH-Branch-Cursor": "" },
          }),
        );
      }),
    );

    // Start lazy-expand (async — runs up to the first await fetch, then yields).
    const p = lazyExpandBranch("B");

    // Apply session.delete("a") BEFORE the stale response resolves. This bumps
    // branchRequestGen, so when the stale response lands it will be rejected.
    applySessionEvent("session.delete", 99, { id: "a" });
    expect(state.sessions.a).toBeUndefined(); // confirmed deleted

    // Resolve the stale fetch (contains the now-deleted "a").
    resolveFirst(
      new Response(staleBody, {
        status: 200,
        headers: { "X-VH-Branch-Cursor": "" },
      }),
    );
    await p;

    // "a" must NOT be resurrected: the stale response was rejected, the retry
    // fetched clean data. Without the branchRequestGen guard, "a" would be
    // merged back from the stale response (callCount would be 1, not 2).
    expect(state.sessions.a).toBeUndefined();
    expect(callCount).toBe(2);
  });

  it("lazyExpandBranch terminates on no cursor progress (Finding #6 client guard)", async () => {
    setState("sessions", { B: { id: "B" } });
    setState("branchStubs", {
      B: { id: "B", kind: "collapsed-branch", parentID: "", title: "B", hasChildren: true },
    });

    // Simulate a server stuck returning the same nextCursor (the old cursor-
    // not-found bug restarted at page 0 → same cursor forever). The no-progress
    // guard must break the loop instead of fetching indefinitely.
    const body = JSON.stringify({
      seq: 100,
      projected: true,
      cause: "lazy-expand",
      sessions: [{ id: "c1", parentID: "B" }],
      stubs: [],
    });
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "X-VH-Branch-Cursor": "c1" }, // same cursor forever
          }),
        );
      }),
    );

    await lazyExpandBranch("B");

    // Without the no-progress guard this would loop forever (test timeout).
    // With it, the second response's cursor === prevCursor → break.
    expect(callCount).toBe(2);
  });
});
