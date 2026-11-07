// @vitest-environment jsdom
//
// session-cursor-bridge.test.ts — slice 2 of the whole-data-flow
// verification pilot (card task-2026-11-07t04-03-03-o12-gots-bridge-ob1-ob2).
// THE BRIDGE, TS HALF.
//
// The module under test is the REAL web/src/sync/session-stream.ts (no
// mutants, no copies) driven through a MockEventSource whose fired payloads
// are the REAL WIRE BYTES from the committed Go-generated fixtures under
// ./go-bridge-fixtures/ (captured from the actual /vh/stream handler by
// pkg/web/stream_bridge_fixture_test.go). Every frame's `data` string is
// passed through VERBATIM — the module's own JSON.parse/decode path runs
// (synthetic frame objects that skip decode are the brief's consumer-bypass
// kill criterion; the byte-fidelity canary below proves the parser gates
// application).
//
// Obligations exercised (tmp/agent-runs/formal-verify-fullflow/
// o11-obligation-map.md §4):
//   OB1 — the sent cursor= at every EventSource construction sits strictly
//   below every received, undisposed obligation of the session. Obligations
//   are registered at the PRODUCER boundary (the fixture bytes — registered
//   at parse time, BEFORE any frame is fired), never from the consumer's
//   cursor or bookkeeping. Dispositions are observed independently via the
//   store's content (message frames and content-bearing snapshots — SOME
//   newly-introduced id resident) or, for a snapshot whose every id is
//   already resident (fully merge-skipped; no content witness exists), the
//   NEXT reconnect's URL cursor — never pendingBatchSeqs/mismatchLatchedSids/
//   lastKnownSesCursor (module-private production bookkeeping).
//   Under-advance is ALWAYS legal; the oracle never demands cursor ==
//   maxApplied (a hypothetical cursor COVERING an open obligation is flagged
//   — the standalone negative control below).
//   OB2 — the server branch (replay vs fresh, and WHY) is cross-checked
//   against the fixture manifest's journal expectations, and the CLIENT
//   consequence of each branch is observed: replay re-serves exactly
//   seq > cursor (repair), fallback fresh-snapshot applies and DISCHARGES
//   the stranded obligations (the no-stranding recipe), with the NEXT
//   reconnect claiming the repair point.
//
// THE THREE CHAINS (fixture seqs are pinned by the manifest; the asserts
// derive cursor values from the OBSERVED URLs, never as inputs):
//   R (replay repair + legitimate under-advance): R1 prefix delivered
//      [snapshot@4, m2@5, p1up@6] with the tail append@7 WITHHELD (a real
//      disconnect shape — the harness delivers a prefix of the connection's
//      bytes, keeping delivery ordinals contiguous so the module's own
//      gap-detection never fires for the wrong reason). Reconnect MUST send
//      cursor=6 (the ACTUAL remembered claim — asserted from the URL);
//      6 < 7 keeps the withheld obligation uncovered (OB1, no false
//      positive on legitimate under-advance); R2 replays exactly seq>6 and
//      the append applies — nothing stranded.
//   C (compatibility fallback via the REAL kill-switch): R1 prefix
//      [snapshot@4, m2@5], p1up@6+append@7 withheld; the part_delta
//      kill-switch (the production rollback path) makes the reconnect a
//      LEGACY connection — URL carries cursor=5 and NO part_delta param;
//      C3 (generated without part_delta) serves the §4.3 fresh-snapshot
//      fallback; the missed part content arrives as FULL TEXT via the
//      snapshot; the floor rises to 7 and both open obligations discharge.
//   E (ring eviction + fallback discharge): E1 prefix [snapshot@4] with the
//      live m2@5 withheld; reconnect sends the floor-only cursor=4;
//      E2's ring_eviction fallback snapshot@10 applies → floor 10 → the
//      withheld obligation DISCHARGES; the NEXT reconnect claims the repair
//      point (cursor=10) with zero open obligations — no stranding.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
// lastUrlCursor — the most recent reconnect's URL cursor: the WIRE-deferred
// snapshot witness's observable (updated inside openAndObserve; harness-level
// state read off the mocked EventSource's URL — never a production export).
let lastUrlCursor = 0;
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const urlCursor = (es: MockEventSource): number => {
  const m = /(?:^|\?|&)cursor=(\d+)/.exec(es.url);
  return m ? Number(m[1]) : 0;
};

const SID = "s1";
const PROJ = "/bridge";
const EPOCH_TOK = "ep-0000000000000000000aaaaa";

// ── fixture loading: bytes → frames (the producer boundary) ──────────────────

interface FixtureFrame {
  id: string;
  event: string;
  data: string;
}

interface Fixture {
  name: string;
  request: string;
  journal: string;
  frames: FixtureFrame[];
}

const resolveFromHere = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

// parseFixture — a faithful SSE block parser over the fixture FILE bytes:
// `:`-comment blocks and the generator's `: bridge-fixture:` header carry no
// `event:` line and are skipped (exactly what an EventSource does); complete
// blocks yield {id, event, data} with the data line VERBATIM.
function parseFixture(text: string): Fixture {
  const lines = text.split("\n");
  const header: Record<string, string> = {};
  for (const l of lines) {
    const m = /^: (bridge-fixture|request|journal): (.*)$/.exec(l);
    if (m) header[m[1]] = m[2];
  }
  const frames: FixtureFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!/^event: /m.test(block)) continue;
    const f: FixtureFrame = { id: "", event: "", data: "" };
    for (const line of block.split("\n")) {
      if (/^id: /.test(line)) f.id = line.slice(4).trim();
      else if (/^event: /.test(line)) f.event = line.slice(7).trim();
      else if (/^data: /.test(line)) f.data += line.slice(6);
    }
    if (f.event) frames.push(f);
  }
  if (!header["bridge-fixture"] || !header["journal"]) {
    throw new Error(`fixture missing generator header: ${text.slice(0, 120)}`);
  }
  return {
    name: header["bridge-fixture"],
    request: header["request"] ?? "",
    journal: header["journal"],
    frames,
  };
}

function loadFixture(file: string): Fixture {
  return parseFixture(readFileSync(resolveFromHere(`./go-bridge-fixtures/${file}`), "utf8"));
}

interface ManifestFrame {
  event: string;
  id: string;
}
interface ManifestScenario {
  file: string;
  chain: string;
  request: string;
  journal: string;
  clientDisposition: string;
  frames: ManifestFrame[];
}
interface Manifest {
  generatedBy: string;
  normalizations: string[];
  scenarios: ManifestScenario[];
}

function loadManifest(): Manifest {
  return JSON.parse(
    readFileSync(resolveFromHere("./go-bridge-fixtures/manifest.json"), "utf8"),
  ) as Manifest;
}

// frameSeq — the STORE seq component of a compound SSE id (the producer-side
// obligation identity). Message-class frames are ALWAYS id-bearing on this
// wire; a missing id on one is a fixture corruption.
function frameSeq(f: FixtureFrame): number {
  const dot = f.id.indexOf(".");
  const head = dot < 0 ? f.id : f.id.slice(0, dot);
  const n = Number(head);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`message-class frame has no usable id: ${f.event} ${f.id}`);
  }
  return n;
}

// ── the independent obligation oracle (S0 contract, compact form) ───────────

type Disposition = "pending" | "applied" | "open" | "discharged";

interface Obligation {
  seq: number;
  kind: string;
  disp: Disposition;
  observe: () => boolean;
  note: string;
}

interface Violation {
  atOp: string;
  sid: string;
  cursor: number;
  offending: { seq: number; kind: string; note: string };
}

class ObligationOracle {
  obls: Obligation[] = [];
  floor = 0; // highest APPLIED snapshot seq (the round-5b discharge axiom)

  deliver(seq: number, kind: string, observe: () => boolean, note = ""): void {
    this.obls.push({ seq, kind, disp: "pending", observe, note });
  }
  snapshotApplied(seq: number): void {
    if (seq > this.floor) this.floor = seq;
    for (const o of this.obls) {
      if (o.seq <= seq && o.disp !== "applied") o.disp = "discharged";
    }
  }
  // classify: pending obligations take their first disposition, and OPEN
  // obligations are RE-TESTED at every settle — an obligation left open by an
  // earlier leg (the withheld append classified while its content was absent)
  // flips to applied once a later leg's delivery (the replay re-serve, or a
  // discharging snapshot floor... which marks discharged directly) actually
  // lands the content. Without the re-test a repaired obligation would stay
  // "open" forever — the anti-pattern a one-shot oracle must not encode.
  // discharged/applied are terminal and never revisited.
  classifyPending(): void {
    for (const o of this.obls) {
      if (o.disp === "pending" || o.disp === "open") {
        o.disp = o.observe() ? "applied" : "open";
      }
    }
  }
  // settle — classify pending/open obligations against their witnesses, then
  // apply the round-5b discharge axiom: every snapshot whose witness HAS
  // FIRED raises the floor and discharges every obligation ≤ floor. Called
  // at every observation point: post-feed settlement (settleAsync) AND
  // reconnect (openAndObserve — the wire-deferred witness's observable, the
  // URL cursor, moves exactly there).
  settle(): void {
    this.classifyPending();
    for (const o of this.obls) {
      if (o.kind === "snapshot" && o.disp === "applied") {
        this.snapshotApplied(o.seq);
      }
    }
  }
  openObligations(): Obligation[] {
    return this.obls.filter((o) => o.disp === "open" || o.disp === "pending");
  }
  // THE invariant: cursor must sit strictly below every OPEN obligation.
  checkMemoryOpen(cursor: number, atOp: string): Violation[] {
    const out: Violation[] = [];
    for (const o of this.openObligations()) {
      if (cursor >= o.seq) {
        out.push({
          atOp,
          sid: SID,
          cursor,
          offending: { seq: o.seq, kind: o.kind, note: o.note },
        });
      }
    }
    return out;
  }
}

// ── harness: boot the REAL module, feed REAL bytes ───────────────────────────

type SesModule = typeof import("../../src/sync/session-stream");
type StoreModule = typeof import("../../src/sync/store");

interface Ctx {
  store: StoreModule;
  ses: SesModule;
  byId(mid: string): any;
  partP1(): { text?: string } | undefined;
}

let ctx: Ctx | null = null;

async function boot(): Promise<Ctx> {
  vi.resetModules();
  instances = [];
  lastUrlCursor = 0;
  const store = await import("../../src/sync/store");
  const ses = await import("../../src/sync/session-stream");
  store.setProjectDirRaw(PROJ);
  store.setSelectedIdRaw(SID);
  const c: Ctx = {
    store,
    ses,
    byId: (mid) => (store.state.messages[SID] as any)?.byId?.[mid],
    partP1: () => (store.state.messages[SID] as any)?.byId?.m1?.parts?.p1,
  };
  ctx = c;
  return c;
}

async function flushMicro(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// feedFrames fires a fixture's frames IN FILE ORDER, data verbatim. `upto`
// delivers only the first `upto` frames (a connection that dies mid-stream —
// the prefix keeps delivery ordinals contiguous so the module's own
// seq-gap detection never fires for a harness reason).
function feedFrames(es: MockEventSource, frames: FixtureFrame[], upto = frames.length): void {
  for (let i = 0; i < upto; i++) {
    es.fire(frames[i].event, frames[i].data, frames[i].id);
  }
}

// registerProducer — the PRODUCER-boundary ledger: every message-class frame
// in the fixture (delivered OR withheld) is an obligation, registered BEFORE
// any byte is fired. A frame re-served on a later connection (replay of a
// previously-withheld seq) is NOT re-registered — obligation identity is
// (seq, kind); the replayed delivery resolves the ORIGINAL obligation.
// Observers read the store's content only.
function registerProducer(oracle: ObligationOracle, frames: FixtureFrame[], upto = frames.length): void {
  for (let i = 0; i < upto; i++) {
    const f = frames[i];
    switch (f.event) {
      case "snapshot":
      case "message.upsert":
      case "part.upsert":
      case "part.append": {
        // Message-class frames are ALWAYS id-bearing on this wire; a missing
        // id on one is a fixture corruption.
        const seq = frameSeq(f);
        const key = `${seq}:${f.event}`;
        if (oracle.obls.some((o) => `${o.seq}:${o.kind}` === key)) continue;
        switch (f.event) {
          case "snapshot": {
            // TWO-CLASS SNAPSHOT WITNESS (F3 oracle honesty). The pre-F3
            // `() => true` observer marked every registered snapshot applied
            // at settle — raising the discharge floor without observing
            // anything. The honest witness is built from the frame's OWN
            // bytes plus a registration-time store fingerprint (which ids
            // are resident at the PRODUCER boundary, BEFORE any byte of
            // this connection fired):
            //
            //   CONTENT class — the snapshot carries ≥1 message id NOT
            //   resident at registration (the "newly" set). observe = SOME
            //   newly id now resident. prependMessagesIfAbsent inserts
            //   absent ids wholesale (reduce.ts:230-238), so delivery+apply
            //   makes them resident. SOME, not ALL: the claim auto-scopes
            //   to the round-5b adjudicated applied-through-merge boundary —
            //   it never demands residency for content inside the keyed-
            //   resident merge-skip zone (reduce.ts:202-228) and never
            //   claims part-installation inside a protected resident.
            //
            //   WIRE-DEFERRED class — newly is empty (a snapshot whose every
            //   id is already resident — C3 — or a messageless snapshot): NO
            //   store-content witness exists (the apply's only observable
            //   delta is the module's own cursor memory), so the obligation
            //   defers to the WIRE: observe = the next reconnect's URL
            //   cursor ≥ seq — the module claims the snapshot seq as its
            //   resume point iff it actually applied. DOCUMENTED
            //   APPROXIMATION: a cursor ≥ seq could in principle rise past
            //   seq by a non-snapshot route; in this scenario set that is
            //   impossible (the only advance routes are this snapshot's own
            //   floor-raise and incremental claims — and the negative
            //   control delivers nothing). NEVER a `() => true` fallback.
            const snap = JSON.parse(f.data) as any;
            const newly: string[] = [];
            for (const it of (snap.messages?.[SID] ?? []) as any[]) {
              const mid = it?.info?.id;
              if (typeof mid === "string" && !ctx?.byId(mid)) newly.push(mid);
            }
            if (newly.length > 0) {
              oracle.deliver(
                seq,
                "snapshot",
                () => newly.some((mid) => Boolean(ctx?.byId(mid))),
                `snap-content:${newly.join(",")}`,
              );
            } else {
              oracle.deliver(seq, "snapshot", () => lastUrlCursor >= seq, "snap-wire");
            }
            break;
          }
          case "message.upsert": {
            const mid = (JSON.parse(f.data) as any).id as string;
            oracle.deliver(seq, "message.upsert", () => Boolean(ctx?.byId(mid)), `m:${mid}`);
            break;
          }
          case "part.upsert":
            oracle.deliver(seq, "part.upsert", () => Boolean(ctx?.partP1()), "p:p1");
            break;
          case "part.append":
            oracle.deliver(
              seq,
              "part.append",
              () => {
                const t = ctx?.partP1()?.text;
                return typeof t === "string" && t.startsWith("a");
              },
              "a:p1",
            );
            break;
        }
        break;
      }
      default:
        break; // structural / bootstrap frames: no client-side obligation
    }
  }
}

// settle — let the module's listeners run, then settle the oracle (classify
// + the round-5b floor-raise/discharge axiom — see ObligationOracle.settle).
async function settleAsync(oracle: ObligationOracle): Promise<void> {
  await flushMicro(12);
  oracle.settle();
}

// openAndObserve — close, reopen, and return the NEW ES with its observed
// URL cursor (the wire-level observable of the module's ACTUAL remembered
// claim — never an input). Runs the OB1 invariant check when the observation
// is memory-based (fresh boot or post-close: live receipt cursor zeroed).
function openAndObserve(
  c: Ctx,
  oracle: ObligationOracle,
  atOp: string,
): { es: MockEventSource; cursor: number; violations: Violation[] } {
  c.ses.closeSessionStream();
  c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
  const all = sessionESes();
  const es = all[all.length - 1];
  const cursor = urlCursor(es);
  // The URL cursor is the wire-deferred snapshot witness's observable, and
  // it just moved — re-settle BEFORE the invariant check, so a snapshot
  // whose apply is qualified by THIS cursor (chain C's fully merge-skipped
  // fallback) is no longer counted open against its own repair point.
  lastUrlCursor = cursor;
  oracle.settle();
  const violations = oracle.checkMemoryOpen(cursor, atOp);
  // The invariant check result is consumed by callers via expect on the
  // returned violations — keep it explicit:
  return { es, cursor, violations };
}

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
    ctx?.ses.closeSessionStream();
    ctx?.ses._setPartDeltaEnabledForTest(true);
  } catch {
    /* teardown must never throw across module registries */
  }
  ctx = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ═════════════════════════════════════════════════════════════════════════════
// Fixture ↔ manifest cross-check (the two sides of the bridge agree)
// ═════════════════════════════════════════════════════════════════════════════

describe("go-bridge fixtures ↔ manifest contract", () => {
  it("every fixture's parsed frames and journal line equal the manifest's machine contract", () => {
    const manifest = loadManifest();
    expect(manifest.scenarios.length).toBe(7);
    for (const sc of manifest.scenarios) {
      const fx = loadFixture(sc.file);
      expect(fx.journal, `${sc.file} journal header`).toBe(sc.journal);
      expect(
        fx.frames.map((f) => ({ event: f.event, id: f.id })),
        `${sc.file} frames`,
      ).toEqual(sc.frames);
    }
  });

  it("the five-way fallback_reason discriminator appears across the matrix (incl. genuine ring_eviction + compatibility_fallback)", () => {
    const manifest = loadManifest();
    const reasons = manifest.scenarios.map((sc) => {
      const m = /fallback_reason=(\w+)/.exec(sc.journal);
      if (!m) throw new Error(`journal without fallback_reason: ${sc.journal}`);
      return m[1];
    });
    expect(reasons).toEqual(
      expect.arrayContaining([
        "cursorless",
        "none",
        "compatibility_fallback",
        "ring_eviction",
        "stale_cursor_exceeds_head",
      ]),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Oracle negative control (standalone — no production module)
// ═════════════════════════════════════════════════════════════════════════════

describe("oracle negative control — a covering cursor IS flagged", () => {
  it("flags cursor=7 covering the open obligation@7 that chain R's real schedule keeps at 6", () => {
    const o = new ObligationOracle();
    o.deliver(7, "part.append", () => false, "a:p1"); // withheld: never applies
    o.classifyPending();
    expect(o.checkMemoryOpen(6, "ctrl")).toEqual([]); // 6 < 7: legal (chain R's shape)
    const v = o.checkMemoryOpen(7, "ctrl"); // a hypothetical over-claim
    expect(v).toHaveLength(1);
    expect(v[0].offending.seq).toBe(7);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAIN R — replay repair + legitimate under-advance (OB1 both halves)
// ═════════════════════════════════════════════════════════════════════════════

describe("chain R — withheld tail, reconnect with the ACTUAL remembered cursor, replay repair", () => {
  it("serves exactly seq>cursor on replay and repairs the withheld obligation (no stranding, no false positive)", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const r2 = loadFixture("R2-replay-in-range.sse");

    // Leg 1: cursorless open; feed R1's prefix — snapshot@4, m2@5, p1up@6 —
    // WITHHOLDING the tail append@7 (file order keeps ordinals contiguous).
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    expect(es1.url).not.toMatch(/cursor=/); // cursorless first open
    // PRODUCER boundary: the ledger registers EVERY message-class frame in
    // the FILE (the withheld tail included); only the DELIVERY is a prefix.
    registerProducer(oracle, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 1);
    await settleAsync(oracle);

    // The delivered prefix applied: m1 (from the snapshot), m2, and p1 are
    // resident; the withheld append's content is NOT applied (p1.text is
    // still the server-seeded "" — the delta's "a" never arrived).
    expect(c.byId("m1")).toBeTruthy();
    expect(c.byId("m2")).toBeTruthy();
    expect(c.partP1()).toBeTruthy();
    expect(c.partP1()?.text).toBe("");
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([7]); // only the withheld append
    expect(oracle.floor).toBe(4);

    // Leg 2: reconnect. The URL cursor is the module's ACTUAL memory (the
    // snapshot floor + the two incremental claims) — read from the URL,
    // never asserted as an input. OB1: 6 must sit strictly below 7.
    const { es: es2, cursor, violations } = openAndObserve(c, oracle, "R:reconnect");
    expect(cursor).toBe(6);
    expect(violations).toEqual([]); // legitimate under-advance passes — no false positive
    // The real SPA's negotiated shape (F1 epoch pairing rides along).
    expect(es2.url).toContain("&part_delta=1");
    expect(es2.url).toContain(`&epoch=${EPOCH_TOK}`);

    // The Go side generated R2 for EXACTLY this cursor — cross-check the
    // manifest's request line and journal (OB2 server half).
    const manifest = loadManifest();
    const r2md = manifest.scenarios.find((s) => s.file === "R2-replay-in-range.sse")!;
    expect(r2md.request).toContain(`cursor=${cursor}`);
    expect(r2md.journal).toContain("path=replay");
    expect(r2md.journal).toContain("fallback_reason=none");

    // Feed the replay bytes: every replayed frame's globalSeq > cursor (the
    // OB1 server-half wire property, observed on the TS side from real ids).
    for (const f of r2.frames) {
      if (f.id) {
        const seq = frameSeq(f);
        expect(seq).toBeGreaterThan(cursor);
      }
    }
    registerProducer(oracle, r2.frames);
    feedFrames(es2, r2.frames);
    await settleAsync(oracle);

    // The withheld obligation is REPAIRED from replay — nothing stranded.
    expect(c.partP1()?.text).toBe("a");
    expect(oracle.openObligations()).toEqual([]);
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAIN C — compatibility fallback through the REAL kill-switch
// ═════════════════════════════════════════════════════════════════════════════

describe("chain C — legacy (no part_delta) reconnect takes the §4.3 snapshot fallback", () => {
  it("the fallback snapshot applies, carries the missed content as full text, and discharges the open obligations", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const c3 = loadFixture("C3-compat-fallback.sse");

    // Leg 1: prefix [snapshot@4, m2@5]; withhold p1up@6 + append@7.
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 2);
    await settleAsync(oracle);
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([6, 7]);

    // Leg 2: the production kill-switch drops the part_delta opt-in — the
    // reconnect is a LEGACY connection whose replay range contains
    // part.append (the §4.3 shape the Go side flipped to a fresh snapshot).
    c.ses._setPartDeltaEnabledForTest(false);
    const { es: es2, cursor, violations } = openAndObserve(c, oracle, "C:reconnect");
    expect(cursor).toBe(5);
    expect(violations).toEqual([]); // 5 < 6,7 — the withheld pair stays uncovered
    expect(es2.url).not.toContain("part_delta");

    const manifest = loadManifest();
    const c3md = manifest.scenarios.find((s) => s.file === "C3-compat-fallback.sse")!;
    expect(c3md.request).toContain(`cursor=${cursor}`);
    expect(c3md.journal).toContain("path=fresh");
    expect(c3md.journal).toContain("fallback_reason=compatibility_fallback");

    registerProducer(oracle, c3.frames);
    feedFrames(es2, c3.frames);
    await settleAsync(oracle);

    // The fallback snapshot applies THROUGH THE MERGE POLICY (the round-5b
    // recorded boundary the oracle adopts as its discharge axiom). In THIS
    // chain both of C3's message ids (m1, m2) were already resident at
    // registration — m2 landed via the leg-1 delta m2@5.2, NOT via the
    // snapshot — so the snapshot's apply is fully merge-skipped and the
    // honest witness is WIRE-DEFERRED (no store-content witness exists; see
    // registerProducer): its observation point is the post-repair reconnect
    // below, where the module's own URL cursor claims seq 7. The floor/open
    // asserts therefore moved AFTER that observation — at settle-time they
    // rested on the unconditional `() => true` predicate F3 removed (the
    // sanctioned reorder; nothing else in the chain was weakened). NOTE —
    // the part-level repair inside m1 does NOT land: m1 is a keyed
    // non-completed RESIDENT, so prependMessagesIfAbsent protects its body
    // and the snapshot's m1 (with parts [p1 "a"]) is merge-skipped — the
    // known, deliberately out-of-scope store-policy gap (reduce.ts
    // keyed-resident merge-skip). This test asserts the ADJUDICATED
    // boundary (applied = ran through merge policy, not every byte
    // resident), not byte-residency.
    expect(c.byId("m2")).toBeTruthy(); // landed via the leg-1 delta, not the snapshot
    expect(c.byId("m1")).toBeTruthy(); // resident body protected (live-wins)
    expect(c.partP1()).toBeUndefined(); // merge-skipped — the documented gap

    // The NEXT reconnect claims the repair point — and (F3) it is THE
    // observation point for C3's wire-deferred witness: openAndObserve
    // settles with lastUrlCursor=7, the witness fires, the floor rises to 7
    // and discharges both open obligations.
    const { es: es3, cursor: cursor3, violations: violations3 } = openAndObserve(c, oracle, "C:post-repair");
    expect(cursor3).toBe(7);
    expect(violations3).toEqual([]);
    expect(es3.url).not.toContain("part_delta"); // kill-switch still in effect
    expect(oracle.openObligations()).toEqual([]);
    expect(oracle.floor).toBe(7);
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAIN E — ring eviction: the fallback fresh snapshot DISCHARGES the stranded
// obligation and the next reconnect resumes from the repair point (the brief's
// no-stranding recipe end-to-end on real bytes)
// ═════════════════════════════════════════════════════════════════════════════

describe("chain E — ring_eviction fallback discharge + resume from repair point", () => {
  it("fallback snapshot discharges the withheld obligation; the next reconnect claims the snapshot seq with zero open", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const e1 = loadFixture("E1-initial-cursorless.sse");
    const e2 = loadFixture("E2-ring-eviction.sse");

    // Leg 1: prefix [snapshot@4] — the live m2@5 was missed (withheld tail).
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, e1.frames);
    feedFrames(es1, e1.frames, e1.frames.length - 1);
    await settleAsync(oracle);
    expect(c.byId("m1")).toBeTruthy();
    expect(c.byId("m2")).toBeUndefined(); // withheld — content absent
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([5]);

    // Leg 2: floor-only reconnect (the REAL remembered claim after the
    // disconnect: no incremental content was received). The Go side aged the
    // cursor past the retained window → ring_eviction → fresh snapshot.
    const { es: es2, cursor, violations } = openAndObserve(c, oracle, "E:reconnect");
    expect(cursor).toBe(4);
    expect(violations).toEqual([]); // 4 < 5 — the missed m2 stays uncovered
    const manifest = loadManifest();
    const e2md = manifest.scenarios.find((s) => s.file === "E2-ring-eviction.sse")!;
    expect(e2md.request).toContain(`cursor=${cursor}`);
    expect(e2md.journal).toContain("path=fresh");
    expect(e2md.journal).toContain("fallback_reason=ring_eviction");

    // The fallback snapshot applies: the missed range's ABSENT messages
    // (m2..m5 — all withheld by the disconnect) land via prepend, and the
    // floor discharges the stranded m2@5 — nothing left open. The part-level
    // repair inside m1 is merge-skipped (keyed non-completed resident — the
    // documented out-of-scope gap; see the chain-C note) so p1 stays absent;
    // the assertion here is the adjudicated applied-through-merge boundary.
    registerProducer(oracle, e2.frames);
    feedFrames(es2, e2.frames);
    await settleAsync(oracle);
    expect(c.byId("m2")).toBeTruthy();
    expect(c.byId("m3")).toBeTruthy();
    expect(c.byId("m5")).toBeTruthy();
    expect(c.byId("m1")).toBeTruthy(); // resident body protected (live-wins)
    expect(c.partP1()).toBeUndefined(); // merge-skipped — the documented gap
    expect(oracle.openObligations()).toEqual([]);
    expect(oracle.floor).toBe(10);

    // THE NEXT RECONNECT claims the repair point — the fallback's snapshot
    // seq became the client's own resume cursor (applySnap's floor-raise).
    const { cursor: cursor3, violations: violations3 } = openAndObserve(c, oracle, "E:post-repair");
    expect(cursor3).toBe(10);
    expect(violations3).toEqual([]);
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROL (F3) — the snapshot obligation registered but WITHHELD.
// The pre-F3 oracle registered snapshots with an unconditional `() => true`
// observer: settlement marked every registered snapshot APPLIED and raised
// the discharge floor without observing anything — exactly the lie this
// control withholds. Same fixtures as chain E; the divergence is purely
// delivery: the fallback snapshot's bytes are never fired on the connection
// that requested them (the connection died before the first frame — the
// `feedFrames(..., 0)` prefix-withholding idiom; the snapshot stanza is
// frame 0 in every committed scenario, so "before the snapshot" is
// unambiguous).
// ═════════════════════════════════════════════════════════════════════════════

describe("negative control — a WITHHELD fallback snapshot raises neither floor nor discharge", () => {
  it("E2 registered-but-undelivered keeps floor 4 and m2@5 open; feeding the same bytes later applies genuinely", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const e1 = loadFixture("E1-initial-cursorless.sse");
    const e2 = loadFixture("E2-ring-eviction.sse");

    // Leg 1 — chain E's prefix exactly: E1's snapshot@4 delivered (m2@5
    // withheld). The content witness fires on m1's residency: floor 4.
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, e1.frames);
    feedFrames(es1, e1.frames, e1.frames.length - 1);
    await settleAsync(oracle);
    expect(c.byId("m1")).toBeTruthy();
    expect(c.byId("m2")).toBeUndefined(); // withheld — content absent
    expect(oracle.floor).toBe(4);
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([5]);

    // Leg 2 (the probe) — reconnect: the URL carries the floor-only
    // cursor=4 (E2's manifest request line pins this exact shape), the
    // producer ledger registers E2's obligations BEFORE any feeding — and
    // then NOTHING is delivered on es2. An honest oracle must keep BOTH the
    // withheld m2@5 AND the undelivered snapshot@10 open, and the floor at
    // the last genuinely-applied snapshot.
    const { es: es2, cursor } = openAndObserve(c, oracle, "NC:withheld-reconnect");
    expect(cursor).toBe(4);
    const manifest = loadManifest();
    const e2md = manifest.scenarios.find((s) => s.file === "E2-ring-eviction.sse")!;
    expect(e2md.request).toContain(`cursor=${cursor}`);
    registerProducer(oracle, e2.frames); // snapshot@10 obligation registered BEFORE any feeding
    feedFrames(es2, e2.frames, 0); // deliver NOTHING — the withheld snapshot
    await settleAsync(oracle);
    // These two asserts are the RED-FIRST receipt: under the pre-F3
    // `() => true` snapshot observer this settle reported floor 10 and
    // open [] — m2@5 FALSELY discharged by a snapshot whose bytes never
    // arrived.
    expect(oracle.floor).toBe(4);
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([5, 10]);
    expect(c.byId("m3")).toBeUndefined(); // E2-exclusive content never landed

    // Leg 3 — the NEXT reconnect still sends the PRE-snapshot cursor=4.
    // HONESTY NOTE: this assert PASSES on the pre-change tree too — the
    // module's own cursor memory was always honest (it never applied the
    // undelivered snapshot); it was the ORACLE that lied. The red-first
    // receipt rests on the leg-2 settle asserts above, not on this URL.
    const { es: es3, cursor: cursor3, violations } = openAndObserve(c, oracle, "NC:post-withhold");
    expect(cursor3).toBe(4);
    expect(violations).toEqual([]); // 4 < 5,10 — the withheld pair stays uncovered

    // Leg 4 (sensitivity the other way) — feed the UNCHANGED e2.frames on
    // es3 through the real decoder: the content witness NOW genuinely
    // fires (m2..m5 install wholesale), the floor rises to 10, and m2@5
    // discharges on the real apply — the withheld/delivered contrast in
    // one scenario. No re-registration: obligation identity is (seq,kind);
    // this delivery resolves the ORIGINAL leg-2 registration.
    feedFrames(es3, e2.frames);
    await settleAsync(oracle);
    expect(oracle.floor).toBe(10);
    expect(oracle.openObligations()).toEqual([]);
    expect(c.byId("m2")).toBeTruthy(); // genuinely discharged — content resident
    expect(c.byId("m3")).toBeTruthy();
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// Byte-fidelity canary — the decode path gates application (consumer-bypass
// kill criterion: a corrupted data line must NOT apply)
// ═════════════════════════════════════════════════════════════════════════════

describe("byte-fidelity canary — real bytes through the real decoder", () => {
  it("a single corrupted byte in the snapshot's data line prevents application entirely", async () => {
    const c = await boot();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    // Corrupt the snapshot frame's JSON: `"seq":4` → `"seq":@4` (invalid
    // JSON — a scratch mutation of the IN-MEMORY copy; the committed
    // fixture is untouched).
    const snapIdx = r1.frames.findIndex((f) => f.event === "snapshot");
    const corrupted = r1.frames.map((f, i) =>
      i === snapIdx ? { ...f, data: f.data.replace('"seq":4', '"seq":@4') } : f,
    );
    if (corrupted[snapIdx].data === r1.frames[snapIdx].data) {
      throw new Error("canary: corruption marker did not apply — fixture shape changed");
    }

    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    // Deliver ONLY through the corrupted snapshot frame: the claim under
    // test is that the SNAPSHOT's own bytes gate its application. (Delivering
    // the later valid frames would let part.upsert synthesize a placeholder
    // m1 — a different mechanism than the snapshot path.)
    feedFrames(es1, corrupted, snapIdx + 1);
    await flushMicro(12);

    // The malformed snapshot was logged + dropped: NOTHING landed in the
    // store (the bytes — not a synthetic object — are what the decoder
    // consumed), and no cursor was claimed.
    expect(c.byId("m1")).toBeUndefined();
    const { cursor } = openAndObserve(c, new ObligationOracle(), "canary");
    expect(cursor).toBe(0);
  }, 20_000);
});
