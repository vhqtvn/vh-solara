// @vitest-environment jsdom
//
// session-cursor-property.test.ts — S0+S1 of the formal-verification theme
// (card task-2026-10-30t06-40-21-s0-s1-cursor-verification-calibration; the
// BINDING contract is tmp/agent-runs/formal-verify-scope/brief.md).
//
// TEST-ONLY slice: ZERO production files are modified. The module under test
// is the REAL session-stream machinery driven through MockEventSource (the
// session-cursor-persistence.test.ts harness pattern), plus the DISPOSABLE
// test-local copy ./session-cursor-mutants.ts (a NEW TEST FILE — a mechanical
// copy of web/src/sync/session-stream.ts carrying the six revert-mutants H1–H6;
// see its header and the drift-guard suite below). With no mutant armed the
// copy is behaviorally identical to production outside the marked sites.
//
// ── S0: the invariant contract (adjudicated) ────────────────────────────────
// For the remembered-cursor claim safety of the client session stream:
//
//   INVARIANT (identity-based, one direction): at every PRESERVING open whose
//   wire cursor is derived from the per-session memory (live receipt cursor
//   zeroed — i.e. a construction that follows a close), the sent cursor must
//   NOT cover a received, in-scope obligation whose content is neither applied
//   nor explicitly discharged:
//     ∀ obligation o of the session with disposition {open}: cursor < o.seq.
//   Under-advance is ALWAYS legal (server ring replay + prependMessagesIfAbsent
//   dedup converge). The live receipt cursor (sesCursor, advances at RECEIPT,
//   preferred when positive) is a DIFFERENT variable and is EXEMPT from this
//   check — see the brief §1 ("separate the live receipt cursor from
//   remembered applied memory").
//
//   Dispositions:
//   • applied      — the obligation's content is observed in the store (the
//                    oracle reads the store, never production bookkeeping).
//   • discharged   — SNAPSHOT FLOOR: a snapshot frame delivered on the current
//                    connection discharged every obligation of that session
//                    with seq ≤ snapshot.seq. Per the round-5b RECORDED
//                    BOUNDARY (session-stream.ts applySnap, coordinator
//                    adjudication), "applied" for the snapshot path means
//                    "ran through the store's established merge policy"
//                    (prependMessagesIfAbsent, live-wins for keyed
//                    non-completed residents) — NOT "every byte is resident".
//                    The oracle ADOPTS that boundary as its discharge axiom; it
//                    therefore does not (and by design cannot) detect the
//                    known keyed-noncompleted-resident merge-skip gap
//                    (reduce.ts:200-228 — separate store-policy card).
//   • open         — content not applied and not discharged. A project switch
//                    (switchProject wipes s.messages on EVERY dir change)
//                    re-opens EVERY obligation: the store no longer holds the
//                    content, so the only safe cursor for the wiped project's
//                    sessions is 0.
//
//   NOT part of the oracle (deliberate):
//   • no maximum-based predicate — "missing 200 then applied 201, cursor 201"
//     passes rememberedCursor ≤ maxAppliedContent while losing content; the
//     oracle tracks obligation IDENTITIES and rejects that shape.
//   • no contiguity demand — global sequence numbers are interest-FILTERED on
//     the wire; delivery ordinal ≠ global seq. Gaps in seq are not errors.
//   • no reading of pendingBatchSeqs / mismatchLatchedSids /
//     lastKnownSesCursor — those are production bookkeeping (and module-private
//     anyway). The oracle observes (a) what the schedule driver DELIVERED (its
//     own ledger, registered BEFORE the frame reaches production), (b) the
//     store's content, and (c) the URL cursor of each new EventSource
//     construction — the wire-level consequence of the memory. Structural
//     independence, not just nominal.
//
// ── S1: calibration shape ───────────────────────────────────────────────────
// Six pinned canonical schedules (hand-minimized reconstructions of the six
// historical red-first tests, each labeled same-task vs separate-task) kill
// their mutant BY THE INTENDED invariant violation (attribution asserted),
// while the control copy (no mutant armed) and the REAL production module pass
// the same schedules. A deterministic seeded sweep (in-repo mulberry32 PRNG —
// no new dependencies) runs generated schedules across all variants; the
// baseline (real + control) must stay violation-free on every seed (asserted);
// per-mutant sweep kill counts are a recorded calibration datum.
//
// H2/H3 windows need macrotask-spanning gzip64 decodes: those canonicals run
// on REAL timers mirroring the F9 / F9-2b discipline (microtask-only pumps
// inside the window, the existing holdNth decode-order stub for H3).
//
// Env hooks (both inert by default):
//   VH_CAL_REPORT=1  → the sweep writes its differential kill table to
//                      ../tmp/calibration-sweep.json (repo tmp/, scratch).
//   VH_TRACE=<label> → per-op trace (ledger + cascade state) for the run
//                      whose label matches, to ../tmp/trace.log (scratch).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { CursorMutant } from "./session-cursor-mutants";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class MockEventSource {
  static CLOSED = CLOSED;
  static OPEN = OPEN;
  static CONNECTING = CONNECTING;

  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (arr) arr.push(fn);
    else this.listeners.set(type, [fn]);
  }
  close(): void {
    this.readyState = CLOSED;
  }
  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const urlCursor = (es: MockEventSource): number => {
  const m = /(?:^|\?|&)cursor=(\d+)/.exec(es.url);
  return m ? Number(m[1]) : 0;
};

const SID = "s1";
const PROJ = "/test";

// Pumps (fake timers do not fake microtasks; real-timer gzip decodes settle
// across macrotasks — the existing file's discipline).
async function flushMicro(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
const waitTick = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 0));
async function settleReal(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await waitTick();
    await flushMicro(5);
  }
}

function msgFixture(mid: string, role: "user" | "assistant" = "user"): any {
  return {
    info: { id: mid, sessionID: SID, role, time: { created: 2 } },
    parts: [],
  };
}
const gzip64BatchMsg = (mid: string): { sessionID: string; encoding: "gzip64"; data: string } => ({
  sessionID: SID,
  encoding: "gzip64",
  data: Buffer.from(gzipSync(Buffer.from(JSON.stringify({ messages: [msgFixture(mid)] })))).toString(
    "base64",
  ),
});

// ── S0: the independent obligation oracle ───────────────────────────────────

type Disposition = "pending" | "applied" | "open" | "discharged";

interface Obligation {
  sid: string;
  seq: number;
  kind: string;
  disp: Disposition;
  // The oracle's OWN observation of the store (registered at delivery time,
  // evaluated at settle time). Never reads production bookkeeping.
  observe: () => boolean;
  note: string;
}

export interface Violation {
  atOp: string;
  sid: string;
  cursor: number;
  offending: { seq: number; kind: string; note: string };
  attribution: string;
}

function attributionOf(o: Obligation): string {
  if (o.note === "store-wiped") return "project-invalidation";
  if (o.kind === "part.append:mismatch") return "mismatch-latch";
  if (o.kind === "messages.batch") return "decode-window";
  return `other:${o.kind}`;
}

// ObligationOracle — the S0 contract as code. Standalone-unit-testable (the
// qualification suite drives it directly, without any production module).
class ObligationOracle {
  obls: Obligation[] = [];
  floor = 0; // highest APPLIED snapshot seq (the round-5b discharge axiom)

  deliver(sid: string, seq: number, kind: string, observe: () => boolean, note = ""): void {
    this.obls.push({ sid, seq, kind, disp: "pending", observe, note });
  }
  // A snapshot that applied THROUGH THE MERGE POLICY on the current connection
  // (the driver only delivers snapshots on the current connection; a stale or
  // gate-discarded one observes false and never reaches here as a floor).
  snapshotApplied(sid: string, seq: number): void {
    if (seq > this.floor) this.floor = seq;
    for (const o of this.obls) {
      if (o.sid === sid && o.seq <= seq && o.disp !== "applied") o.disp = "discharged";
    }
  }
  // Project switch: s.messages is wiped on EVERY dir change while session ids
  // stay addressable → every obligation's content left the store.
  wipe(): void {
    for (const o of this.obls) {
      o.disp = "open";
      o.note = "store-wiped";
    }
    this.floor = 0;
  }
  classifyPending(): void {
    for (const o of this.obls) {
      if (o.disp === "pending") o.disp = o.observe() ? "applied" : "open";
    }
  }
  openObligations(sid: string): Obligation[] {
    return this.obls.filter((o) => o.sid === sid && (o.disp === "open" || o.disp === "pending"));
  }
  // THE invariant check: cursor must sit strictly below every OPEN obligation.
  // Under-advance is legal; over-advance past an undisposed obligation is not.
  checkMemoryOpen(sid: string, cursor: number, atOp: string): Violation[] {
    const out: Violation[] = [];
    for (const o of this.openObligations(sid)) {
      if (cursor >= o.seq) {
        out.push({
          atOp,
          sid,
          cursor,
          offending: { seq: o.seq, kind: o.kind, note: o.note },
          attribution: attributionOf(o),
        });
      }
    }
    return out;
  }
}

// ── S1: the schedule driver over the real machinery ─────────────────────────

type Variant = "real" | "control" | "H1" | "H2" | "H3" | "H4" | "H5" | "H6";
const MUTANTS: Variant[] = ["H1", "H2", "H3", "H4", "H5", "H6"];

type SesModule = typeof import("../../src/sync/session-stream");

interface SesApis {
  open(id: string, force?: boolean): void;
  close(): void;
  suspend(): void;
  resume(): void;
  resetCursors(): void;
  reopenPreserving(): void;
}

interface Ctx {
  store: typeof import("../../src/sync/store");
  actions: typeof import("../../src/sync/actions");
  cascade: typeof import("../../src/sync/cascade");
  mut: typeof import("./session-cursor-mutants");
  real: SesModule;
  apis: SesApis;
  target: SesModule;
}

let lastCtx: Ctx | null = null;

async function boot(variant: Variant): Promise<Ctx> {
  vi.resetModules();
  instances = [];
  const store = await import("../../src/sync/store");
  const actions = await import("../../src/sync/actions");
  const cascade = await import("../../src/sync/cascade");
  const mut = await import("./session-cursor-mutants");
  const real = await import("../../src/sync/session-stream");
  mut._armCursorMutantForTest(
    variant === "control" || variant === "real" ? null : (variant as CursorMutant),
  );
  const target: SesModule = variant === "real" ? real : (mut as unknown as SesModule);
  const apis: SesApis = {
    open: (id, force) => target.openSessionStream(id, force, "selection-change", "calibration"),
    close: () => target.closeSessionStream(),
    suspend: () => target.suspendSessionStreamForVisibility(),
    resume: () => target.resumeSessionStreamForVisibility(),
    resetCursors: () => target.resetLastKnownSesCursors(),
    reopenPreserving: () =>
      target.reopenSessionStreamPreservingCursor("watchdog", "sentinel-timeout"),
  };
  store.setProjectDirRaw(PROJ);
  store.setSelectedIdRaw(SID);
  const ctx: Ctx = { store, actions, cascade, mut, real, apis, target };
  lastCtx = ctx;
  return ctx;
}

type Op =
  | { t: "open"; force?: boolean }
  | { t: "close" }
  | { t: "suspend" }
  | { t: "resume" }
  | { t: "switch"; dir: string }
  | { t: "select"; sid: string }
  | { t: "snapshot"; seq: number; extraMsg?: string }
  | { t: "upsertMsg"; seq: number; mid: string }
  | { t: "upsertPart"; seq: number }
  | { t: "appendGood"; seq: number; text: string }
  | { t: "appendBad"; seq: number }
  | { t: "batch"; seq: number; mid: string; gzip?: boolean }
  | { t: "armResumePass" }
  | { t: "burstBadGood"; lo: number } // same-task: mismatched + applicable suffix, ONE flush
  | { t: "badThenUpsert"; lo: number } // same-task: buffered mismatch drained by an upsert
  | { t: "gzipBatchThenAppend"; lo: number; mid: string; text: string; noAutoSettle?: boolean }
  | { t: "twoBatches"; lo: number; hi: number; midA: string; midB: string }
  | { t: "releaseHold" };

class Driver {
  oracle = new ObligationOracle();
  violations: Violation[] = [];
  memoryObservations: Array<{ cursor: number; atOp: string }> = [];
  currentES: MockEventSource | null = null;
  seen = 0;
  live = 0; // live-receipt-cursor model: max delivered seq on the current conn
  suspended = false;
  passArmed = false;
  p1Resident = false;
  p1Text = "";
  appendModelSafe = true; // false once an append's apply-model can no longer be trusted
  ordByES = new Map<MockEventSource, number>();
  releaseHold: (() => void) | null = null;

  constructor(
    public ctx: Ctx,
    public variant: Variant,
    public label: string,
    public realTimers: boolean,
  ) {}

  byId(mid: string): any {
    return (this.ctx.store.state.messages[SID]?.byId as any)?.[mid];
  }
  partText(): string | undefined {
    const p = (this.byId("m1")?.parts as any)?.p1;
    return typeof p?.text === "string" ? p.text : undefined;
  }

  private fire(kind: string, payload: unknown, seq: number): void {
    const es = this.currentES;
    if (!es) throw new Error(`${this.label}: fire(${kind}@${seq}) with no current ES`);
    const ord = (this.ordByES.get(es) ?? 0) + 1;
    this.ordByES.set(es, ord);
    es.fire(kind, payload, `${seq}.${ord}`);
    if (seq > this.live) this.live = seq;
  }
  private deliver(kind: string, event: string, payload: unknown, seq: number, observe: () => boolean, note = ""): void {
    // Schedule-driver view: the obligation is registered BEFORE the frame is
    // handed to production. `kind` is the ORACLE's obligation label; `event`
    // is the real SSE event name production listens for.
    this.oracle.deliver(SID, seq, kind, observe, note);
    this.fire(event, payload, seq);
  }
  private deliverSnapshot(seq: number, extraMsg?: string): void {
    const parts = this.p1Resident
      ? [{ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: this.p1Text }]
      : [];
    const msgs = [
      { info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } }, parts },
    ];
    if (extraMsg) msgs.push(msgFixture(extraMsg));
    const probe = extraMsg ?? "m1";
    this.deliver(
      "snapshot",
      "snapshot",
      { seq, gate: { [SID]: { messagesLoaded: true } }, messages: { [SID]: msgs } },
      seq,
      () => Boolean(this.byId(probe)),
    );
  }

  private wipe(): void {
    this.oracle.wipe();
    this.p1Resident = false;
    this.p1Text = "";
    this.appendModelSafe = true;
  }

  async settle(): Promise<void> {
    if (this.realTimers) await settleReal(8);
    else await flushMicro(6);
    this.oracle.classifyPending();
    for (const o of this.oracle.obls) {
      if (o.kind === "snapshot" && o.disp === "applied") {
        this.oracle.snapshotApplied(SID, o.seq);
        o.disp = "discharged"; // the snapshot frame itself is consumed by its floor
      }
      if (o.kind === "part.append:apply" && o.disp === "open") this.appendModelSafe = false;
    }
  }

  // Observe new EventSource constructions (the wire-level observable of the
  // memory) and run the invariant check at memory-observation opens.
  scanNew(atOp: string): void {
    const sess = sessionESes();
    for (; this.seen < sess.length; this.seen++) {
      const es = sess[this.seen];
      this.currentES = es;
      this.ordByES.set(es, 0);
      const cursor = urlCursor(es);
      // Memory observation: the live receipt cursor model is 0, so the URL
      // cursor can only come from the per-session memory. (Forced/fresh opens
      // send 0 and pass trivially; resume-reveals with a positive live cursor
      // are EXEMPT — the live cursor is receipt-based, preferred when
      // positive, and owned by the server-side fallback contract.)
      if (this.live === 0) {
        this.memoryObservations.push({ cursor, atOp });
        this.violations.push(...this.oracle.checkMemoryOpen(SID, cursor, atOp));
      }
    }
  }

  async exec(op: Op): Promise<void> {
    const canFire = this.currentES !== null && !this.suspended;
    switch (op.t) {
      case "open": {
        if (this.currentES && !this.suspended && !op.force) break; // module early-return
        this.ctx.apis.open(SID, op.force === true);
        this.suspended = false;
        this.live = 0; // openSessionStream's closeSessionStream zeroes the live cursor
        break;
      }
      case "close": {
        if (this.currentES) {
          this.ctx.apis.close();
          this.live = 0;
          this.suspended = false;
          this.currentES = null;
        }
        break;
      }
      case "suspend": {
        if (this.currentES && !this.suspended) {
          this.ctx.apis.suspend();
          this.suspended = true;
          this.currentES = null; // live cursor model PRESERVED (the reveal sends it)
        }
        break;
      }
      case "resume": {
        if (this.suspended) {
          this.ctx.apis.resume();
          this.suspended = false;
        }
        break;
      }
      case "switch": {
        // Replicates the actions.ts switchProject wiring over the TARGET
        // module (the copy cannot be reached by real actions.ts): the boundary
        // reset (actions.ts:98) precedes the teardown; the real switchProject
        // then wipes s.messages on every dir change. For the "real" variant
        // the internal call inside actions.switchProject does the same reset.
        this.ctx.apis.resetCursors();
        if (this.currentES) {
          this.ctx.apis.close();
          this.currentES = null;
          this.live = 0;
          this.suspended = false;
        }
        this.ctx.actions.switchProject(op.dir);
        this.wipe();
        break;
      }
      case "select":
        this.ctx.store.setSelectedIdRaw(op.sid);
        break;
      case "snapshot":
        if (canFire) this.deliverSnapshot(op.seq, op.extraMsg);
        break;
      case "upsertMsg":
        if (canFire)
          this.deliver(
            "message.upsert",
            "message.upsert",
            // FLAT message shape — message.upsert's payload IS the message row
            // (the {info,parts} wrapper is the snapshot/batch items shape).
            { id: op.mid, sessionID: SID, role: "user", time: { created: 2 } },
            op.seq,
            () => Boolean(this.byId(op.mid)),
          );
        break;
      case "upsertPart":
        if (canFire) {
          this.deliver(
            "part.upsert",
            "part.upsert",
            { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
            op.seq,
            () => Boolean((this.byId("m1")?.parts as any)?.p1),
          );
          this.p1Resident = true;
          this.p1Text = "";
        }
        break;
      case "appendGood": {
        if (!(canFire && this.p1Resident && this.appendModelSafe)) break;
        const target = this.p1Text + op.text; // ASCII-only fixtures: bytes == chars
        this.deliver(
          "part.append:apply",
          "part.append",
          { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: this.p1Text.length, text: op.text },
          op.seq,
          () => {
            const t = this.partText();
            return typeof t === "string" && t.startsWith(target);
          },
        );
        this.p1Text = target;
        break;
      }
      case "appendBad":
        if (canFire)
          this.deliver(
            "part.append:mismatch",
            "part.append",
            { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
            op.seq,
            () => false, // target part absent by construction: content can never apply
            "mismatch",
          );
        break;
      case "batch": {
        if (!canFire) break;
        const payload = op.gzip
          ? gzip64BatchMsg(op.mid)
          : { sessionID: SID, messages: [msgFixture(op.mid)] };
        this.deliver("messages.batch", "messages.batch", payload, op.seq, () =>
          Boolean(this.byId(op.mid)),
        );
        break;
      }
      case "armResumePass": {
        // The round-4 window-maker verbatim: a pass holding a PENDING
        // resume-mode session step (its reopen can never converge under fake
        // timers → recoveries in this window COALESCE, no direct runs).
        if (canFire && !this.passArmed) {
          this.ctx.cascade.requestRecovery(
            "sentinel-timeout",
            () => this.ctx.apis.reopenPreserving(),
            { session: "resume" },
          );
          this.passArmed = true;
        }
        break;
      }
      case "burstBadGood":
        if (canFire && this.p1Resident && this.appendModelSafe) {
          this.exec({ t: "appendBad", seq: op.lo });
          this.exec({ t: "appendGood", seq: op.lo + 1, text: "abc" });
        }
        break;
      case "badThenUpsert":
        if (canFire) {
          this.exec({ t: "appendBad", seq: op.lo });
          // 50-gap mirrors the round-4b shape (mismatch@200, upsert@250): the
          // tail claim's seq must clearly exceed the mismatched frame's.
          this.exec({ t: "upsertMsg", seq: op.lo + 50, mid: `${this.label}-bu` });
        }
        break;
      // SAME-TASK gzip batch + applicable append, microtask-only pump inside
      // the op (the F9 window: the flush runs while the native decode is
      // still in flight across macrotasks). The caller settles/suspends.
      case "gzipBatchThenAppend": {
        if (!canFire) break;
        this.exec({ t: "batch", seq: op.lo, mid: op.mid, gzip: true });
        this.exec({ t: "appendGood", seq: op.lo + 1, text: op.text });
        await flushMicro(2);
        break;
      }
      // SAME-TASK held(gzip) earlier batch + native(gzip) later batch (the
      // F9-2b window; requires opts.holdNth = 1).
      case "twoBatches": {
        if (!canFire) break;
        this.exec({ t: "batch", seq: op.lo, mid: op.midA, gzip: true });
        this.exec({ t: "batch", seq: op.hi, mid: op.midB, gzip: true });
        break;
      }
      case "releaseHold":
        this.releaseHold?.();
        break;
    }
  }
}

interface RunResult {
  variant: Variant;
  label: string;
  violations: Violation[];
  memoryObservations: Array<{ cursor: number; atOp: string }>;
  constructions: number;
  ctx: Ctx;
  driver: Driver;
}

async function runSchedule(opts: {
  variant: Variant;
  timers: "fake" | "real";
  ops: Op[];
  label?: string;
  holdNth?: number;
}): Promise<RunResult> {
  if (opts.timers === "real") vi.useRealTimers();
  else vi.useFakeTimers();
  const ctx = await boot(opts.variant);
  const d = new Driver(ctx, opts.variant, opts.label ?? opts.variant, opts.timers === "real");
  if (opts.holdNth) d.releaseHold = stubHoldNthBatchDecode(opts.holdNth);
  for (let i = 0; i < opts.ops.length; i++) {
    const op = opts.ops[i];
    await d.exec(op);
    const noAuto = op.t === "gzipBatchThenAppend" && op.noAutoSettle === true;
    if (!noAuto) await d.settle();
    d.scanNew(`#${i}:${op.t}`);
    if (process.env.VH_TRACE === (opts.label ?? opts.variant)) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        "../tmp/trace.log",
        `#${i}:${op.t} live=${d.live} es=${sessionESes().length} cas=${JSON.stringify(ctx.cascade._getCascadeStateForTest())} obs=[${d.memoryObservations.map((m) => m.cursor).join(",")}] obls=${d.oracle.obls.map((o) => `${o.seq}:${o.kind}:${o.disp}`).join(" ")}\n`,
      );
    }
  }
  return {
    variant: opts.variant,
    label: opts.label ?? opts.variant,
    violations: d.violations,
    memoryObservations: d.memoryObservations,
    constructions: sessionESes().length,
    ctx,
    driver: d,
  };
}

// holdNth decode-order stub — replicated from session-cursor-persistence.test.ts
// (the F9-2b discipline): the Nth constructed DecompressionStream buffers its
// readable until release; every other instance proxies the native stream.
function stubHoldNthBatchDecode(holdNth: number): () => void {
  const RealMaybe = (globalThis as { DecompressionStream?: new (fmt: string) => unknown })
    .DecompressionStream;
  if (!RealMaybe) throw new Error("DecompressionStream global unavailable in test env");
  const Real = RealMaybe;
  let released = false;
  const waiters: Array<() => void> = [];
  let n = 0;
  class HoldNth {
    private real: InstanceType<typeof Real>;
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(fmt: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.real = new (Real as any)(fmt) as InstanceType<typeof Real>;
      if (++n === holdNth) {
        this.readable = new ReadableStream<Uint8Array>({
          start: (controller) => {
            void (async () => {
              if (!released) await new Promise<void>((r) => waiters.push(r));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const reader = (this.real as any).readable.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value as Uint8Array);
              }
              controller.close();
            })();
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = (this.real as any).writable.getWriter();
        this.writable = new WritableStream<Uint8Array>({
          write: (chunk) => w.write(chunk),
          close: () => w.close(),
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.readable = (this.real as any).readable as ReadableStream<Uint8Array>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.writable = (this.real as any).writable as WritableStream<Uint8Array>;
      }
    }
  }
  vi.stubGlobal("DecompressionStream", HoldNth);
  return () => {
    released = true;
    for (const r of waiters) r();
  };
}

// ── S1: deterministic seeded schedule generation (no new deps) ──────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genSchedule(seed: number): Op[] {
  const rnd = mulberry32(seed);
  const ops: Op[] = [{ t: "open" }, { t: "snapshot", seq: 100 }];
  let seq = 100;
  let n = 0;
  const nextSeq = () => (seq += 1 + Math.floor(rnd() * 3)); // filtered seq gaps are legal
  const mid = () => `s${seed}m${n++}`;
  for (let i = 0; i < 34; i++) {
    const r = rnd();
    if (r < 0.22) ops.push({ t: "appendGood", seq: nextSeq(), text: "abc".slice(0, 1 + Math.floor(rnd() * 3)) });
    else if (r < 0.30) ops.push({ t: "appendBad", seq: nextSeq() });
    else if (r < 0.44) ops.push({ t: "upsertMsg", seq: nextSeq(), mid: mid() });
    else if (r < 0.50) ops.push({ t: "upsertPart", seq: nextSeq() });
    else if (r < 0.56) ops.push({ t: "batch", seq: nextSeq(), mid: mid() });
    else if (r < 0.62) ops.push({ t: "snapshot", seq: nextSeq(), extraMsg: mid() });
    else if (r < 0.68) ops.push({ t: "close" });
    else if (r < 0.78) ops.push({ t: "open" });
    else if (r < 0.83) ops.push({ t: "suspend" });
    else if (r < 0.88) ops.push({ t: "resume" });
    else if (r < 0.91) ops.push({ t: "armResumePass" });
    else if (r < 0.955) ops.push({ t: "burstBadGood", lo: nextSeq() });
    else if (r < 0.98) ops.push({ t: "badThenUpsert", lo: nextSeq() });
    else {
      ops.push(
        { t: "switch", dir: "" },
        { t: "switch", dir: PROJ },
        { t: "select", sid: SID },
        { t: "open" },
        { t: "snapshot", seq: nextSeq() },
      );
    }
  }
  ops.push({ t: "close" }, { t: "open" }); // trailing memory observation
  return ops;
}

// ── harness lifecycle ────────────────────────────────────────────────────────

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  try {
    lastCtx?.apis.close();
    lastCtx?.real.closeSessionStream();
  } catch {
    /* teardown must never throw across module registries */
  }
  lastCtx = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ═════════════════════════════════════════════════════════════════════════════
// S0 — oracle qualification (standalone; no production module involved)
// ═════════════════════════════════════════════════════════════════════════════

describe("S0 oracle qualification — identity-based obligation tracking", () => {
  it("REJECTS the missing-200-then-applied-201 shape (a max-based oracle would pass it)", () => {
    const o = new ObligationOracle();
    o.deliver("s1", 200, "message.upsert", () => false); // received, never applied
    o.deliver("s1", 201, "part.append:apply", () => true); // applied
    o.classifyPending();
    const v = o.checkMemoryOpen("s1", 201, "obs");
    // A maximum-based predicate (rememberedCursor <= maxAppliedContent) passes
    // here: maxApplied = 201 and cursor = 201. The identity-based oracle flags
    // it — cursor 201 covers the OPEN obligation 200.
    expect(v).toHaveLength(1);
    expect(v[0].offending.seq).toBe(200);
    expect(v[0].cursor).toBe(201);
  });

  it("ACCEPTS legitimate filtered sequence gaps (delivery ordinal ≠ global seq; no contiguity demand)", () => {
    const o = new ObligationOracle();
    o.deliver("s1", 100, "snapshot", () => true);
    o.deliver("s1", 105, "message.upsert", () => true); // 101–104 interest-filtered
    o.deliver("s1", 110, "message.upsert", () => true);
    o.classifyPending();
    expect(o.checkMemoryOpen("s1", 110, "obs")).toEqual([]);
  });

  it("treats legal under-advance as PASSING even while newer content applied (non-vacuity, oracle side)", () => {
    const o = new ObligationOracle();
    o.deliver("s1", 200, "messages.batch", () => false); // unresolved/discarded
    o.deliver("s1", 201, "part.append:apply", () => true); // content applied at 201
    o.classifyPending();
    expect(o.checkMemoryOpen("s1", 150, "obs")).toEqual([]); // under-advance legal
    expect(o.checkMemoryOpen("s1", 201, "obs")).toHaveLength(1); // over-advance is not
  });

  it("SNAPSHOT discharge follows the round-5b recorded boundary: application through the merge policy, not installed bytes", () => {
    const o = new ObligationOracle();
    o.deliver("s1", 200, "part.append:mismatch", () => false, "mismatch");
    o.classifyPending();
    // A snapshot APPLIES at 300 (through merge policy — even if the merge
    // SKIPPED some carried content, per the adjudicated boundary): every
    // obligation ≤ 300 is discharged and the floor rises to 300.
    o.snapshotApplied("s1", 300);
    expect(o.checkMemoryOpen("s1", 300, "obs")).toEqual([]);
    // Post-clear incremental claims above the floor are legitimate again.
    o.deliver("s1", 350, "part.append:apply", () => true);
    o.classifyPending();
    expect(o.checkMemoryOpen("s1", 350, "obs")).toEqual([]);
  });

  it("a project switch re-opens EVERY obligation (the store wipe) — a surviving cursor is a violation", () => {
    const o = new ObligationOracle();
    o.deliver("s1", 100, "snapshot", () => true);
    o.classifyPending();
    o.snapshotApplied("s1", 100);
    expect(o.checkMemoryOpen("s1", 100, "obs")).toEqual([]); // pre-wipe: legal
    o.wipe(); // switchProject wiped s.messages
    const v = o.checkMemoryOpen("s1", 100, "obs"); // stale cursor 100 against wiped store
    expect(v).toHaveLength(1);
    expect(v[0].attribution).toBe("project-invalidation");
    expect(o.checkMemoryOpen("s1", 0, "obs")).toEqual([]); // cursorless re-select: correct
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — drift guard: the disposable copy stays faithful to production
// ═════════════════════════════════════════════════════════════════════════════

describe("S1 drift guard — disposable-copy fidelity", () => {
  const MARKERS = ["H1", "H6", "H3", "H5", "H2H4"] as const;

  it("every MUT-SYNC-ORIGINAL snippet exists VERBATIM in production session-stream.ts", () => {
    const prod = readFileSync("src/sync/session-stream.ts", "utf8");
    const copy = readFileSync("tests/unit/session-cursor-mutants.ts", "utf8");
    for (const id of MARKERS) {
      const begin = `// MUT-SYNC-ORIGINAL ${id} BEGIN`;
      const end = `// MUT-SYNC-ORIGINAL ${id} END`;
      const bi = copy.indexOf(begin);
      expect(bi, `marker ${id} BEGIN present in copy`).toBeGreaterThanOrEqual(0);
      const ei = copy.indexOf(end, bi);
      expect(ei, `marker ${id} END present in copy`).toBeGreaterThan(bi);
      const block = copy.slice(bi + begin.length, ei);
      const snippet = block
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("// "))
        .map((l) => l.slice(3))
        .join("\n");
      expect(snippet.length, `marker ${id} snippet non-empty`).toBeGreaterThan(0);
      expect(
        prod.includes(snippet),
        `marker ${id}: production no longer contains the pinned original snippet — the disposable copy is STALE; regenerate it from production per its header's mutation map (this card: tmp/agent-runs/formal-verify-scope/brief.md S1 mutation-authorization boundary)`,
      ).toBe(true);
      // The copy itself must still carry the production branch (armed=null ≡
      // production outside the mutant branches) — line-level (the retained
      // branch sits one indent deeper inside its mutant if/else).
      const snippetLines = snippet.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      for (const line of snippetLines) {
        expect(
          copy.includes(line),
          `marker ${id}: copy retains the production line "${line}"`,
        ).toBe(true);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — canonical mutant kills (pinned minimized schedules)
// ═════════════════════════════════════════════════════════════════════════════

// Shared postlude: close + unforced reopen is the memory observation (the
// close zeroes the live cursor, so the reopen's URL cursor IS the memory).
const UNMASK: Op[] = [{ t: "close" }, { t: "open" }];

describe("S1 canonical kills — each mutant dies BY ITS INTENDED invariant violation", () => {
  it("H1 (lazy project invalidation): zero-open excursion A→''→A re-select sends the stale cursor [separate-task schedule]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 }, // m1 applies; memory → 100
      { t: "switch", dir: "" }, // zero-open excursion leg 1 (closes, wipes)
      { t: "switch", dir: PROJ }, // leg 2 (wipes again; NO open ran under "")
      { t: "select", sid: SID },
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "fake", ops, label: "H1-ctrl" });
    expect(ctrl.violations).toEqual([]);
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(0); // cursorless re-select
    const mut = await runSchedule({ variant: "H1", timers: "fake", ops, label: "H1" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(100); // the stale remembered cursor
    expect(mut.violations[0].offending.seq).toBe(100);
    expect(mut.violations[0].attribution).toBe("project-invalidation");
    const real = await runSchedule({ variant: "real", timers: "fake", ops, label: "H1-real" });
    expect(real.violations).toEqual([]); // real module: the boundary reset holds
  }, 20_000);

  it("H2 (append flush vs unresolved batch decode): the flush claims past the in-flight batch [same-task window, real timers]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 }, // m1 resident
      { t: "upsertPart", seq: 150 }, // p1 "" → memory 150 after settle
      { t: "gzipBatchThenAppend", lo: 200, mid: "m2", text: "abc", noAutoSettle: true },
      { t: "suspend" }, // sesGen bump discards the in-flight decode
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "real", ops, label: "H2-ctrl" });
    expect(ctrl.violations).toEqual([]);
    // Store/reopen observations: the suffix APPLIED, the batch NEVER landed,
    // and the control memory under-advanced below the unresolved batch.
    expect(ctrl.driver.partText()).toBe("abc");
    expect(ctrl.driver.byId("m2")).toBeUndefined();
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(150);
    const mut = await runSchedule({ variant: "H2", timers: "real", ops, label: "H2" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(201); // the flush claim covered the batch
    expect(mut.violations[0].offending.seq).toBe(200);
    expect(mut.violations[0].offending.kind).toBe("messages.batch");
    expect(mut.violations[0].attribution).toBe("decode-window");
    const real = await runSchedule({ variant: "real", timers: "real", ops, label: "H2-real" });
    expect(real.violations).toEqual([]);
  }, 30_000);

  it("H3 (overwriteable latest-batch tracking): the later batch claims past the held earlier one [same-task batches, held decode, real timers]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 },
      { t: "twoBatches", lo: 200, hi: 300, midA: "m2", midB: "m3" }, // 200 HELD, 300 native
      { t: "suspend" }, // discard the held 200
      { t: "releaseHold" },
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "real", ops, holdNth: 1, label: "H3-ctrl" });
    expect(ctrl.violations).toEqual([]);
    expect(ctrl.driver.byId("m3")).toBeTruthy(); // later batch applied
    expect(ctrl.driver.byId("m2")).toBeUndefined(); // held batch discarded
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(199); // min(unresolved)−1
    const mut = await runSchedule({ variant: "H3", timers: "real", ops, holdNth: 1, label: "H3" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(300); // the later batch's uncapped claim
    expect(mut.violations[0].offending.seq).toBe(200);
    expect(mut.violations[0].offending.kind).toBe("messages.batch");
    expect(mut.violations[0].attribution).toBe("decode-window");
    const real = await runSchedule({ variant: "real", timers: "real", ops, holdNth: 1, label: "H3-real" });
    expect(real.violations).toEqual([]);
  }, 30_000);

  it("H4 (same-flush mismatch covering): the applicable suffix's claim covers the mismatched frame [same-task burst]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 },
      { t: "upsertPart", seq: 150 }, // memory 150
      { t: "burstBadGood", lo: 200 }, // mismatch@200 + applicable@201, ONE flush
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "fake", ops, label: "H4-ctrl" });
    expect(ctrl.violations).toEqual([]);
    expect(ctrl.driver.partText()).toBe("abc"); // the suffix APPLIED at 201
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(150); // claim voided (mismatch)
    const mut = await runSchedule({ variant: "H4", timers: "fake", ops, label: "H4" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(201);
    expect(mut.violations[0].offending.seq).toBe(200);
    expect(mut.violations[0].offending.kind).toBe("part.append:mismatch");
    expect(mut.violations[0].attribution).toBe("mismatch-latch");
    const real = await runSchedule({ variant: "real", timers: "fake", ops, label: "H4-real" });
    expect(real.violations).toEqual([]);
  }, 20_000);

  it("H5 (flush-local mismatch protection): a LATER CLEAN flush claims past the subsume-window mismatch — NO repair snapshot, NO epoch change [separate-task]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 },
      { t: "upsertPart", seq: 150 }, // memory 150
      { t: "armResumePass" }, // pending resume-mode step → recoveries COALESCE
      { t: "appendBad", seq: 200 }, // own flush: mismatch; recovery SUBSUMED (no reopen)
      { t: "appendGood", seq: 250, text: "abc" }, // LATER clean flush applies
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "fake", ops, label: "H5-ctrl" });
    expect(ctrl.violations).toEqual([]);
    // No repair snapshot ever arrived (schedule has none after seq 100), no
    // epoch change (no switch), and the pass never converged (fake timers).
    expect(ctrl.driver.partText()).toBe("abc");
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(150); // latch holds the memory
    const mut = await runSchedule({ variant: "H5", timers: "fake", ops, label: "H5" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(250);
    expect(mut.violations[0].offending.seq).toBe(200);
    expect(mut.violations[0].offending.kind).toBe("part.append:mismatch");
    expect(mut.violations[0].attribution).toBe("mismatch-latch");
    const real = await runSchedule({ variant: "real", timers: "fake", ops, label: "H5-real" });
    expect(real.violations).toEqual([]);
  }, 20_000);

  it("H6 (ungated listener-tail claim): the drain-time mismatch's triggering upsert tail-claims past it — NO repair snapshot, NO epoch change [same-task burst]", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 },
      { t: "upsertPart", seq: 150 }, // memory 150
      { t: "armResumePass" }, // subsume window: no direct, no sesGen bump
      { t: "badThenUpsert", lo: 200 }, // buffered mismatch drained by upsert@250
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "fake", ops, label: "H6-ctrl" });
    expect(ctrl.violations).toEqual([]);
    // The triggering frame APPLIED on the unchanged generation (the E2 corner)
    // — only its CLAIM was voided by the uniform latch gate.
    expect(ctrl.driver.byId(`${"H6-ctrl"}-bu`)).toBeTruthy();
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(150);
    const mut = await runSchedule({ variant: "H6", timers: "fake", ops, label: "H6" });
    expect(mut.violations).toHaveLength(1);
    expect(mut.violations[0].cursor).toBe(250); // the TAIL claim covered the mismatch
    expect(mut.violations[0].offending.seq).toBe(200);
    expect(mut.violations[0].offending.kind).toBe("part.append:mismatch");
    expect(mut.violations[0].attribution).toBe("mismatch-latch");
    const real = await runSchedule({ variant: "real", timers: "fake", ops, label: "H6-real" });
    expect(real.violations).toEqual([]);
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — non-vacuity witness on the real machinery
// ═════════════════════════════════════════════════════════════════════════════

describe("S1 non-vacuity witness — real content applies while the memory correctly under-advances", () => {
  it("the oracle PASSES control under-advance (150 < applied 201) and FLAGS the H2 mutant on the SAME schedule", async () => {
    const ops: Op[] = [
      { t: "open" },
      { t: "snapshot", seq: 100 },
      { t: "upsertPart", seq: 150 },
      { t: "gzipBatchThenAppend", lo: 200, mid: "m2", text: "abc", noAutoSettle: true },
      { t: "suspend" },
      ...UNMASK,
    ];
    const ctrl = await runSchedule({ variant: "control", timers: "real", ops, label: "nv-ctrl" });
    // Real content applied ABOVE the remembered memory (the suffix at 201 is
    // resident) while the memory correctly under-advanced to 150 — the oracle
    // accepts this (under-advance is legal), so it is not demanding
    // cursor == maxApplied (which would be the WRONG oracle).
    expect(ctrl.driver.partText()).toBe("abc");
    expect(ctrl.memoryObservations[ctrl.memoryObservations.length - 1]?.cursor).toBe(150);
    expect(ctrl.violations).toEqual([]);
    const mut = await runSchedule({ variant: "H2", timers: "real", ops, label: "nv-H2" });
    expect(mut.violations).toHaveLength(1); // non-vacuous: same schedule, mutant flagged
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — seeded differential sweep (calibration measurement)
// ═════════════════════════════════════════════════════════════════════════════

describe("S1 seeded sweep — baseline stays clean; mutant kill counts are the calibration datum", () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it(
    "every generated schedule passes on real + control; differential kills recorded per mutant",
    async () => {
      const table: Record<string, number> = {};
      const examples: Record<string, string> = {};
      for (const v of ["real", "control", ...MUTANTS] as Variant[]) {
        let kills = 0;
        for (const s of SEEDS) {
          const r = await runSchedule({
            variant: v,
            timers: "fake",
            ops: genSchedule(s),
            label: `${v}#seed${s}`,
          });
          if (v === "real" || v === "control") {
            expect(
              r.violations,
              `${v} seed ${s} must be violation-free: ${JSON.stringify(r.violations.slice(0, 2))}`,
            ).toEqual([]);
          }
          if (r.violations.length > 0) {
            kills++;
            if (!examples[v]) {
              examples[v] = `${r.violations[0].attribution}@${r.violations[0].offending.seq}→cursor${r.violations[0].cursor}`;
            }
          }
        }
        table[v] = kills;
      }
      // H2/H3 decode windows need macrotask-spanning gzip decodes; the sweep's
      // raw microtask batches cannot open them (canonical kills cover both).
      // No hard assertion on mutant counts — they are the measured datum.
      if (process.env.VH_CAL_REPORT) {
        // Calibration export (env-gated): the differential kill table for the
        // decision checkpoint, written under repo tmp/ (scratch by contract).
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          "../tmp/calibration-sweep.json",
          `${JSON.stringify({ seeds: SEEDS, table, examples }, null, 2)}\n`,
        );
      }
    },
    240_000,
  );
});
