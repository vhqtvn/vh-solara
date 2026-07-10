// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { gzipSync } from "node:zlib";
import { applySnapshot, applySessionEvent, applySessionSnapshot, applyMessageEvent, decodeMessagesBatch } from "../../src/sync/stream";
import { state, setState } from "../../src/sync/store";
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
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
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
