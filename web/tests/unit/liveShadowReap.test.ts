// @vitest-environment jsdom
// C-F4 — live-path stage-1-only keyless-shadow reap (i-prime fix shape).
//
// The F3 eviction gate (evictIfOverCap in sync/history.ts) fires ONLY after a
// user-triggered Load-older page merge with added > 0. For the active session
// of a user who never pages back, window-blind out-of-window part.upsert
// traffic (compaction bursts, warm reconcile re-publishes) grew byId-only
// keyless shadows past the resident caps with NO reclaim path (the C-F4 gap
// from bcc578c; measured ingress ~18 MB / 8.4 h vs the 5 MiB cap).
//
// The fix: reconcileEvent calls reapShadowsIfOverCap (sync/history.ts) on
// MESSAGE-CLASS events only (message.upsert / messages.batch) — stage 1 only
// (shadows), never ordered eviction, sticky evictedHistory/hasOlder OR'd into
// the resident window.
//
// These tests drive the REAL dispatch (applyMessageEvent → reconcileEvent →
// projectMessageEvent → store) — the same live path Stream 2 delivers through
// — with NO page merge and NO fetch anywhere.
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applyMessageEvent } from "../../src/sync/reconcile";
import {
  MAX_RESIDENT_BYTES,
  MAX_RESIDENT_MESSAGES,
  reapShadowsIfOverCap,
} from "../../src/sync/history";
import { appendPartSuffix, approxResidentBytes, buildMessages, upsertPart } from "../../src/lib/reduce";
import { state, setState } from "../../src/sync/store";
import type { MessageInfo } from "../../src/types";

const SID = "s1";
// ~1.2 MiB of "g" per shadow part — 5 of them ≈ 6 MiB > the 5 MiB byte cap
// (mirrors the byte-cap scenario in messagePage.test.ts).
const FAT = "g".repeat(Math.ceil(1.2 * 1024 * 1024));
const FAT_SHADOWS = ["sh1", "sh2", "sh3", "sh4", "sh5"];

// ── helpers ────────────────────────────────────────────────────────────────
function item(id: string, created: number, text = "x") {
  return {
    info: { id, sessionID: SID, role: "user", time: { created } } as MessageInfo,
    parts: [{ id: `p-${id}`, sessionID: SID, messageID: id, type: "text", text }],
  };
}

// Fire a LIVE part.upsert for an out-of-window message through the REAL
// reconcile dispatch — the exact wire shape session-stream delivers. Distinct
// messageIDs create/extend distinct keyless shadows.
function firePartUpsert(messageID: string, partID: string, text: string, seq: number) {
  applyMessageEvent(
    "part.upsert",
    seq,
    { id: partID, sessionID: SID, messageID, type: "text", text },
    false,
  );
}

// Fire a LIVE message.upsert (payload is the FLAT MessageInfo) through the
// REAL reconcile dispatch.
function fireMessageUpsert(info: MessageInfo, seq: number) {
  applyMessageEvent("message.upsert", seq, info, false);
}

// Seed the active session: an ordered tail + resident window — the state an
// initial snapshot leaves behind. Then push resident bytes past the cap via
// out-of-window part.upserts on the live dispatch.
function seedOverCapShadows(ordered: any[] = [item("m1", 10), item("m2", 20)]) {
  setState("messages", SID, buildMessages(ordered));
  setState("messageWindows", SID, { hasOlder: false, oldestResidentID: ordered[0].info.id });
  let seq = 1;
  for (const shadowID of FAT_SHADOWS) {
    firePartUpsert(shadowID, `p-${shadowID}`, FAT, seq++);
  }
  // Preconditions: shadows are byId-only (never in order) and we are over cap.
  const sm = state.messages[SID]!;
  for (const shadowID of FAT_SHADOWS) {
    expect(sm.byId[shadowID]).toBeDefined();
    expect(sm.order).not.toContain(shadowID);
  }
  expect(approxResidentBytes(sm)).toBeGreaterThan(MAX_RESIDENT_BYTES);
  return seq;
}

// Reset every slice these tests touch (applySnapshot.test.ts pattern — Solid's
// setState MERGES objects, so reconcile({}) is the true reset).
beforeEach(() => {
  setState("messages", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("cursor", 0);
});

// ── the C-F4 gap: live-path reclaim WITHOUT any page merge ─────────────────
describe("live-path shadow reap (C-F4) — message-class triggers", () => {
  it("message.upsert on the live path reaps over-cap shadows — no Load-older anywhere", () => {
    let seq = seedOverCapShadows();

    // A single ordinary live message event (the terminal message.upsert of a
    // turn) is the trigger. Before the fix NOTHING reaps: evictIfOverCap only
    // runs inside a page merge, so these shadows persist forever on HEAD.
    fireMessageUpsert({ id: "m3", sessionID: SID, role: "assistant", time: { created: 30 } }, seq++);

    const sm = state.messages[SID]!;
    // All fat shadows were reaped on the live path.
    for (const shadowID of FAT_SHADOWS) {
      expect(sm.byId[shadowID]).toBeUndefined();
    }
    // Ordered history intact — including the just-upserted live tail.
    expect(sm.order).toEqual(["m1", "m2", "m3"]);
    // Resident bytes back under the cap.
    expect(approxResidentBytes(sm)).toBeLessThanOrEqual(MAX_RESIDENT_BYTES);
    // Sticky OR semantics: reaped data is server-resident + re-fetchable, so
    // the Load-older affordance re-appears (hasOlder was false pre-reap).
    const win = state.messageWindows[SID]!;
    expect(win.hasOlder).toBe(true);
    expect(win.evictedHistory).toBe(true);
    // oldestResidentID untouched (order[0] unchanged — order was never touched).
    expect(win.oldestResidentID).toBe("m1");
  });

  it("messages.batch on the live path triggers the same reap; flags OR over the fresh window", () => {
    let seq = seedOverCapShadows();

    // A cold-load batch whose own content is small and under cap. The batch
    // wholesale-resets messageWindows[SID] (deriveMessageWindow — server
    // has_older=false), THEN the live reap ORs the eviction signal over it.
    applyMessageEvent(
      "messages.batch",
      seq++,
      {
        sessionID: SID,
        messages: [item("m0", 5)],
        window: { oldest_loaded_id: "m0", has_older: false },
      },
      false,
    );

    const sm = state.messages[SID]!;
    for (const shadowID of FAT_SHADOWS) {
      expect(sm.byId[shadowID]).toBeUndefined();
    }
    // Batch content merged normally.
    expect(sm.order).toEqual(["m0", "m1", "m2"]);
    // The fresh window's has_older=false was OR'd to true by the reap.
    const win = state.messageWindows[SID]!;
    expect(win.hasOlder).toBe(true);
    expect(win.evictedHistory).toBe(true);
  });

  it("part.upsert-only traffic does NOT trigger the reap (token-stream hot path is exempt)", () => {
    // The gate exists so a full approxResidentBytes walk never runs per
    // streaming token. Drive the store over cap via part.upserts ONLY — then
    // keep streaming part-only events while over cap. Nothing may be reaped
    // and the window flags must stay untouched. (This is the overreach guard:
    // on HEAD it passes trivially; post-fix it must STILL pass.)
    let seq = seedOverCapShadows([item("m1", 10)]);

    // More part-only traffic while over cap (token-flood shape) — including
    // NEW out-of-window shadows and extends of existing ones.
    for (let i = 0; i < 20; i++) {
      firePartUpsert("sh1", `p-more-${i}`, "tok", seq++);
    }
    firePartUpsert("shNew", "p-shNew", FAT, seq++);

    const sm = state.messages[SID]!;
    expect(approxResidentBytes(sm)).toBeGreaterThan(MAX_RESIDENT_BYTES);
    // Every original shadow still held — part-only events reaped NOTHING.
    for (const shadowID of FAT_SHADOWS) {
      expect(sm.byId[shadowID]).toBeDefined();
    }
    expect(sm.byId["shNew"]).toBeDefined();
    expect(sm.order).toEqual(["m1"]); // ordered history untouched
    // Window flags untouched by part-only traffic.
    const win = state.messageWindows[SID]!;
    expect(win.hasOlder).toBe(false);
    expect(win.evictedHistory).toBeUndefined();
  });

  it("live reap NEVER evicts ordered messages even when they alone exceed the count cap", () => {
    // Stage-2 (ordered/visible) eviction stays page-merge-only. 502 ordered
    // messages ALONE are over MAX_RESIDENT_MESSAGES, + a fat shadow pushes
    // bytes over too. The live trigger fires but may only reap the shadow —
    // the ordered over-cap state persists until a real page merge.
    const items: any[] = [];
    for (let i = 1; i <= MAX_RESIDENT_MESSAGES + 2; i++) items.push(item(`m${i}`, i));
    const sm0 = buildMessages(items);
    upsertPart(sm0, { id: "p-sh", sessionID: SID, messageID: "sh", type: "text", text: FAT });
    setState("messages", SID, sm0);
    setState("messageWindows", SID, { hasOlder: false, oldestResidentID: "m1" });

    fireMessageUpsert({ id: "live", sessionID: SID, role: "assistant", time: { created: 9999 } }, 1);

    const sm = state.messages[SID]!;
    // Shadow reaped; ALL ordered messages + the new tail survive — still over
    // the count cap (503 > 500): no stage-2 ordered eviction on the live path.
    expect(sm.byId["sh"]).toBeUndefined();
    expect(sm.order.length).toBe(MAX_RESIDENT_MESSAGES + 3);
    expect(sm.order).toContain("m1");
    expect(sm.order).toContain(`m${MAX_RESIDENT_MESSAGES + 2}`);
    expect(sm.order).toContain("live");
  });

  it("under-cap traffic: message.upsert neither reaps nor flips eviction flags", () => {
    setState("messages", SID, buildMessages([item("m1", 10)]));
    setState("messageWindows", SID, { hasOlder: false, oldestResidentID: "m1" });
    // A small shadow + a live message event — all far under both caps.
    firePartUpsert("sh1", "p-sh1", "tiny", 1);
    fireMessageUpsert({ id: "m2", sessionID: SID, role: "assistant", time: { created: 20 } }, 2);

    const sm = state.messages[SID]!;
    expect(sm.byId["sh1"]).toBeDefined(); // under cap → held (281a2f2 semantics)
    expect(sm.order).toEqual(["m1", "m2"]);
    const win = state.messageWindows[SID]!;
    expect(win.hasOlder).toBe(false);
    expect(win.evictedHistory).toBeUndefined();
  });
});

// ── promotion after reap: the reap→promote race is benign ──────────────────
describe("promotion after live reap", () => {
  it("events for a reaped id re-land fresh: keyed upsert at its chronological slot, parts intact", () => {
    let seq = seedOverCapShadows();
    // Trigger the reap.
    fireMessageUpsert({ id: "m2x", sessionID: SID, role: "assistant", time: { created: 25 } }, seq++);
    expect(state.messages[SID]!.byId["sh2"]).toBeUndefined(); // reaped

    // A part for the REAPED id re-creates a keyless shadow; a later keyed
    // message.upsert (the upsertMessage promotion path, reduce.ts:22-43)
    // realizes it at its chronological slot with the held part intact.
    firePartUpsert("sh2", "p-sh2-new", "re-arrived", seq++);
    fireMessageUpsert({ id: "sh2", sessionID: SID, role: "assistant", time: { created: 15 } }, seq++);

    const sm = state.messages[SID]!;
    expect(sm.order).toEqual(["m1", "sh2", "m2", "m2x"]); // honest chronological slot
    expect(sm.byId["sh2"].parts["p-sh2-new"].text).toBe("re-arrived");
    // No phantom: exactly the keyed messages are resident — the other reaped
    // shadows did NOT resurrect.
    expect(Object.keys(sm.byId).sort()).toEqual(["m1", "m2", "m2x", "sh2"]);
  });

  it("message.upsert for a reaped id with NO preceding part takes the fresh-insert path", () => {
    let seq = seedOverCapShadows();
    fireMessageUpsert({ id: "m2x", sessionID: SID, role: "assistant", time: { created: 25 } }, seq++);
    expect(state.messages[SID]!.byId["sh3"]).toBeUndefined(); // reaped

    // Direct keyed upsert for the reaped id — fresh insert, no crash, no
    // phantom parts.
    fireMessageUpsert({ id: "sh3", sessionID: SID, role: "assistant", time: { created: 12 } }, seq++);

    const sm = state.messages[SID]!;
    expect(sm.order).toEqual(["m1", "sh3", "m2", "m2x"]); // created 12 slots between m1(10) and m2(20)
    expect(sm.byId["sh3"].partOrder).toEqual([]);
    expect(sm.byId["sh3"].parts).toEqual({});
  });
});

// ── the append→reaped-shadow boundary (study assumption, verified) ──────────
describe("part.append against a reaped shadow (boundary documentation)", () => {
  it("appendPartSuffix for a reaped id returns mismatch → cursorless re-snapshot cost, not data loss", () => {
    // Study assumption (medium confidence): appends target the keyed live
    // tail, never out-of-window shadows. If the assumption ever fails, this
    // pins the failure shape: the append finds no resident message →
    // "mismatch" → the transport's documented cursorless re-snapshot realigns
    // (a re-fetch cost, NOT silent data loss). No scope to fix here.
    let seq = seedOverCapShadows();
    fireMessageUpsert({ id: "m2x", sessionID: SID, role: "assistant", time: { created: 25 } }, seq++);
    const sm = state.messages[SID]!;
    expect(sm.byId["sh1"]).toBeUndefined(); // reaped

    const r = appendPartSuffix(sm, {
      sessionID: SID,
      messageID: "sh1",
      partID: "p-sh1",
      field: "text",
      start: 0,
      text: "suffix",
    });
    expect(r).toBe("mismatch");
  });
});

// ── helper-level unit (reapShadowsIfOverCap seam) ───────────────────────────
describe("reapShadowsIfOverCap (helper unit)", () => {
  it("returns false and mutates nothing when under both caps", () => {
    const sm0 = buildMessages([item("m1", 10)]);
    upsertPart(sm0, { id: "p-sh", sessionID: SID, messageID: "sh", type: "text", text: "small" });
    setState("messages", SID, sm0);
    setState("messageWindows", SID, { hasOlder: false, oldestResidentID: "m1" });
    expect(reapShadowsIfOverCap(SID)).toBe(false);
    expect(state.messages[SID]!.byId["sh"]).toBeDefined(); // held — no cap pressure
    expect(state.messageWindows[SID]!.hasOlder).toBe(false);
  });

  it("returns true and reaps when over cap; ORs the window flags", () => {
    setState("messages", SID, buildMessages([item("m1", 10)]));
    setState("messageWindows", SID, { hasOlder: false, oldestResidentID: "m1", loadingOlder: false });
    const sm0 = buildMessages([item("m1", 10)]);
    for (const shadowID of FAT_SHADOWS) {
      upsertPart(sm0, { id: `p-${shadowID}`, sessionID: SID, messageID: shadowID, type: "text", text: FAT });
    }
    setState("messages", SID, sm0);
    expect(reapShadowsIfOverCap(SID)).toBe(true);
    expect(state.messages[SID]!.byId["sh1"]).toBeUndefined();
    // Prior window fields (oldestResidentID, loadingOlder) preserved by the OR.
    const win = state.messageWindows[SID]!;
    expect(win.hasOlder).toBe(true);
    expect(win.evictedHistory).toBe(true);
    expect(win.oldestResidentID).toBe("m1");
    expect(win.loadingOlder).toBe(false);
  });

  it("reaps even when NO window state exists (flag write skipped, no phantom window)", () => {
    const sm0 = buildMessages([item("m1", 10)]);
    for (const shadowID of FAT_SHADOWS) {
      upsertPart(sm0, { id: `p-${shadowID}`, sessionID: SID, messageID: shadowID, type: "text", text: FAT });
    }
    setState("messages", SID, sm0); // NO messageWindows seed
    expect(reapShadowsIfOverCap(SID)).toBe(true);
    expect(state.messages[SID]!.byId["sh1"]).toBeUndefined();
    expect(state.messageWindows[SID]).toBeUndefined(); // not fabricated
  });

  it("over cap with ZERO shadows (ordered-only) → no-op returning false (stage 2 stays page-merge-only)", () => {
    // Ordered messages ALONE over the count cap with nothing reapable: the
    // live helper must not evict anything — ordered eviction belongs to
    // evictIfOverCap inside a page merge only.
    const items: any[] = [];
    for (let i = 1; i <= MAX_RESIDENT_MESSAGES + 1; i++) items.push(item(`m${i}`, i));
    setState("messages", SID, buildMessages(items));
    setState("messageWindows", SID, { hasOlder: false, oldestResidentID: "m1" });
    expect(reapShadowsIfOverCap(SID)).toBe(false);
    expect(state.messages[SID]!.order.length).toBe(MAX_RESIDENT_MESSAGES + 1);
    expect(state.messageWindows[SID]!.hasOlder).toBe(false); // no flag without a reap
  });

  it("missing session or empty sid → false, no crash", () => {
    expect(reapShadowsIfOverCap("no-such-session")).toBe(false);
    expect(reapShadowsIfOverCap("")).toBe(false);
  });
});
