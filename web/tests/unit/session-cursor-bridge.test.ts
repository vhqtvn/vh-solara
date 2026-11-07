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
//   below every received, undisposed obligation OF THE URL's DECLARED EPOCH
//   (OB5: obligation identities and floors are EPOCH-SCOPED — the store's
//   seq space resets every daemon lifetime, so a numeric comparison across
//   lifetimes is meaningless; a dead epoch's obligations take the explicit
//   terminal disposition "expired" when a foreign-epoch snapshot applies,
//   and are never laundered as discharged by the new epoch's floor).
//   Obligations are registered at the PRODUCER boundary (the fixture bytes —
//   registered at parse time, BEFORE any frame is fired), never from the
//   consumer's cursor or bookkeeping. The obligation's epoch is read from
//   the fixture's SNAPSHOT JSON (`snap.epoch` — it is on the wire; OB5
//   scope Q1 sanctions this read) or, for snapshotless fixtures (replay
//   bodies), passed explicitly by the chain (the fixture's store life).
//   Dispositions are observed independently via the store's content
//   (message frames and content-bearing snapshots — SOME newly-introduced
//   id resident) or, for a snapshot whose every id is already resident
//   (fully merge-skipped; no content witness exists), the NEXT reconnect's
//   URL cursor+epoch PAIR (epoch-matched) — never pendingBatchSeqs/
//   mismatchLatchedSids/lastKnownSesCursor (module-private production
//   bookkeeping).
//   Under-advance is ALWAYS legal; the oracle never demands cursor ==
//   maxApplied (a hypothetical cursor COVERING an open obligation of its
//   own epoch is flagged — the standalone negative control below).
//   OB2 — the server branch (replay vs fresh, and WHY) is cross-checked
//   against the fixture manifest's journal expectations, and the CLIENT
//   consequence of each branch is observed: replay re-serves exactly
//   seq > cursor (repair), fallback fresh-snapshot applies and DISCHARGES
//   the stranded obligations WITHIN the snapshot's own epoch (the
//   no-stranding recipe), with the NEXT reconnect claiming the repair
//   point PAIRED with the epoch it belongs to.
//
// THE FOUR CHAINS + K (fixture seqs are pinned by the manifest; the asserts
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
//   K (OB5 epoch handshake, DISTINCT lifetime epochs): K1 epoch-preserved
//      resume — the reconnect URL carries &epoch= ALONGSIDE cursor= and a
//      MATCHING handshake stays replay (pairing holds in one life). K2
//      epoch-change crux — the reconnect URL carries the DEAD-store pair
//      (cursor=6&epoch=ep-A, observed); the store-B fixture generated for
//      EXACTLY that pairing journals epoch_mismatch and serves a fresh
//      snapshot; obligations re-seed under epoch B, epoch A's withheld
//      obligation EXPIRES (never discharged — B's bytes provably omit it);
//      the NEXT reconnect claims B's snapshot seq PAIRED with B's epoch.
//      K3 perturbation — the dead-epoch cursor, if a perturbed send-site
//      paired it with ep-B, COVERED an open epoch-B obligation (K3B's
//      withheld live tail): flagged by checkMemoryOpen AND by the URL
//      pairing assert. K3 also carries the RED-FIRST receipt: the
//      pre-OB5 (unscoped) oracle run on the same schedules produces the
//      documented FALSE GREEN (cross-epoch floor discharge + registration
//      dedupe swallow).
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
// lastUrlCursor/lastUrlEpoch — the most recent reconnect's URL cursor and
// declared epoch: the WIRE-deferred snapshot witness's observables (updated
// inside openAndObserve; harness-level state read off the mocked
// EventSource's URL — never a production export). OB5: the witness is
// EPOCH-SCOPED — it fires only when the URL's declared epoch IS the
// obligation's epoch and its cursor ≥ seq; a NEW-epoch URL cursor never
// satisfies an OLD-epoch deferred snapshot (the numeric comparison across
// lifetimes the unscoped oracle made).
let lastUrlCursor = 0;
let lastUrlEpoch = "";
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const cursorOfUrl = (url: string): number => {
  const m = /(?:^|\?|&)cursor=(\d+)/.exec(url);
  return m ? Number(m[1]) : 0;
};
const epochOfUrl = (url: string): string => {
  const m = /(?:^|\?|&)epoch=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : "";
};
const urlCursor = (es: MockEventSource): number => cursorOfUrl(es.url);
const urlEpoch = (es: MockEventSource): string => epochOfUrl(es.url);

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

// fixtureEpoch — the store-lifetime epoch token a fixture's bytes carry
// (read from the FIRST snapshot frame's JSON `epoch` field — it is ON THE
// WIRE; OB5 scope Q1 sanctions reading it, the same read the production
// decoder makes). Snapshotless fixtures (replay bodies — R2/K1) carry no
// epoch of their own: their frames follow the CONNECTION's snapshot, so the
// chain passes the store life's epoch explicitly.
function fixtureEpoch(frames: FixtureFrame[]): string {
  for (const f of frames) {
    if (f.event === "snapshot") {
      const snap = JSON.parse(f.data) as any;
      if (typeof snap.epoch !== "string" || snap.epoch === "") {
        throw new Error(`snapshot frame carries no epoch: id=${f.id}`);
      }
      return snap.epoch;
    }
  }
  return "";
}

// ── the independent obligation oracle (S0 contract, compact form) ───────────
//
// OB5 EPOCH SCOPING: the store's seq space resets at every daemon lifetime
// (a documented invariant — pkg/state/store.go's Snapshot doc), so every
// struct below is scoped by the store-lifetime epoch read from the wire:
// obligation identity is (epoch, seq, kind); the discharge floor is
// PER-EPOCH; the wire-deferred witness matches the URL's declared epoch;
// and when a snapshot of a NEW lifetime applies (the establishment of a new
// store life in the oracle), the OLD epoch's still-open obligations take
// the explicit terminal disposition "expired" — recorded and inspectable,
// never silently "discharged" by the new epoch's floor (the floor axiom "a
// snapshot at seq N subsumes ≤N" is valid only WITHIN the snapshot's own
// lifetime; that is the whole point of the epoch handshake).

type Disposition = "pending" | "applied" | "open" | "discharged" | "expired";

interface Obligation {
  epoch: string;
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
  offending: { epoch: string; seq: number; kind: string; note: string };
}

class ObligationOracle {
  obls: Obligation[] = [];
  floors = new Map<string, number>(); // per-epoch: highest APPLIED snapshot seq (the round-5b discharge axiom)
  activeEpoch = ""; // the newest store lifetime an applied snapshot established
  // establishedEpochs — the EDGE memory of the LIFETIME RULE below: the
  // epochs whose serving lifetime a FIRST-applied snapshot already
  // established. settle() REPLAYS every historically-applied snapshot on
  // every call (an "applied" disposition is terminal), so the lifetime
  // transition must key on FIRST ESTABLISHMENT, not on activeEpoch
  // inequality — a replayed OLD-epoch snapshot visit must never re-fire it.
  // EPOCH-keyed rather than (epoch,seq)-keyed by design: the rule is a
  // property of the LIFETIME ("a snapshot applying under E establishes E"),
  // not of an individual snapshot seq — a second snapshot of an
  // already-established epoch (chain E's snapshot@10 after snapshot@4)
  // re-fires nothing. (settle-idempotence micro-slice, the OB5 review's
  // b-F1/b-F2/c-F1 defer.)
  establishedEpochs = new Set<string>();

  deliver(epoch: string, seq: number, kind: string, observe: () => boolean, note = ""): void {
    this.obls.push({ epoch, seq, kind, disp: "pending", observe, note });
  }
  floorOf(epoch: string): number {
    return this.floors.get(epoch) ?? 0;
  }
  snapshotApplied(epoch: string, seq: number): void {
    if (seq > this.floorOf(epoch)) this.floors.set(epoch, seq);
    // OB5 LIFETIME RULE (EDGE-TRIGGERED): a snapshot applying under epoch E
    // establishes E as the serving lifetime — ONCE, at the FIRST settle that
    // observes one of E's snapshots applied (the establishedEpochs edge
    // memory). Every still-open/pending obligation of a DIFFERENT epoch
    // belongs to a DEAD store — its content will never arrive through this
    // lifetime's bytes, so it takes the explicit terminal disposition
    // "expired": visible in obls, excluded from open, and never laundered as
    // "discharged" (E's floor discharges SAME-epoch obligations only — the
    // numeric sweep across lifetimes was the pre-OB5 false green; see the
    // UnscopedObligationOracle receipt). Edge-triggering is what makes the
    // rule survive REPEATED observation: settle() replays every
    // historically-applied snapshot, and under the old activeEpoch-inequality
    // trigger the replayed visit of a DEAD epoch's snapshot re-fired this
    // rule in reverse — expiring the CURRENT epoch's open obligations (the
    // settle-idempotence regression above).
    if (!this.establishedEpochs.has(epoch)) {
      this.establishedEpochs.add(epoch);
      for (const o of this.obls) {
        if (o.epoch !== epoch && (o.disp === "pending" || o.disp === "open")) {
          o.disp = "expired";
        }
      }
      this.activeEpoch = epoch;
    }
    // The discharge sweep stays LEVEL-triggered (idempotent + monotone): a
    // replayed visit re-derives the same floor and the same same-epoch ≤seq
    // discharges — a no-op. "expired" is TERMINAL here too: a dead epoch's
    // obligation is never resurrected as "discharged" by a later settle.
    for (const o of this.obls) {
      if (
        o.epoch === epoch &&
        o.seq <= seq &&
        o.disp !== "applied" &&
        o.disp !== "expired"
      ) {
        o.disp = "discharged";
      }
    }
  }
  // classify: pending obligations take their first disposition, and OPEN
  // obligations are RE-TESTED at every settle — an obligation left open by an
  // earlier leg (the withheld append classified while its content was absent)
  // flips to applied once a later leg's delivery (the replay re-serve, or a
  // discharging snapshot floor... which marks discharged directly) actually
  // lands the content. Without the re-test a repaired obligation would stay
  // "open" forever — the anti-pattern a one-shot oracle must not encode.
  // discharged/applied/expired are terminal and never revisited.
  classifyPending(): void {
    for (const o of this.obls) {
      if (o.disp === "pending" || o.disp === "open") {
        o.disp = o.observe() ? "applied" : "open";
      }
    }
  }
  // settle — classify pending/open obligations against their witnesses, then
  // apply the round-5b discharge axiom PER EPOCH: every snapshot whose
  // witness HAS FIRED raises its own epoch's floor and discharges that
  // epoch's obligations ≤ floor (establishing the floor's epoch as the
  // active lifetime — see the LIFETIME RULE above). Called at every
  // observation point: post-feed settlement (settleAsync) AND reconnect
  // (openAndObserve — the wire-deferred witness's observables, the URL
  // cursor+epoch, move exactly there).
  //
  // INVARIANT (settle IDEMPOTENCE — single-epoch-per-settle; the OB5
  // review's dropped advisory a-F2, folded): settle() REPLAYS every
  // historically-applied snapshot on every call ("applied" is terminal, so
  // each visit re-fires snapshotApplied forever), yet the oracle's verdicts
  // must depend only on the OBSERVATION state, never on how many times it
  // was settled. The load-bearing half is the EDGE-TRIGGERED lifetime rule:
  // within a single settle() the loop may visit snapshots of several epochs
  // (registration order), but establishment only ever ADVANCES the active
  // lifetime (a first-applied epoch) — a replayed settle can never regress
  // activeEpoch to a dead epoch, never expires an obligation of the current
  // epoch, and never resurrects a terminally-disposed one. Floors are
  // monotone, discharges/expiries are terminal: any number of settles over
  // the same observation state yields identical obls/floors/activeEpoch
  // (proven by the settle-idempotence regression below). The committed
  // chains settle once per observation point; nothing breaks at two.
  settle(): void {
    this.classifyPending();
    for (const o of this.obls) {
      if (o.kind === "snapshot" && o.disp === "applied") {
        this.snapshotApplied(o.epoch, o.seq);
      }
    }
  }
  openObligations(): Obligation[] {
    return this.obls.filter((o) => o.disp === "open" || o.disp === "pending");
  }
  // THE invariant (OB5-scoped): a connection's cursor must sit strictly
  // below every OPEN obligation OF THE EPOCH ITS URL DECLARES. Obligations
  // of other epochs are not compared (numerically meaningless across
  // lifetimes); dead-epoch stragglers are disposed by the LIFETIME RULE,
  // not by this check.
  checkMemoryOpen(cursor: number, atOp: string, epoch: string): Violation[] {
    const out: Violation[] = [];
    for (const o of this.openObligations()) {
      if (o.epoch === epoch && cursor >= o.seq) {
        out.push({
          atOp,
          sid: SID,
          cursor,
          offending: { epoch: o.epoch, seq: o.seq, kind: o.kind, note: o.note },
        });
      }
    }
    return out;
  }
}

// ── the PRE-OB5 oracle (red-first receipt subject — NOT for live asserts) ───
//
// The oracle exactly as it stood at 211d24f (post-F3, pre-epoch-scoping):
// obligation identity (seq, kind) with NO epoch, ONE numeric floor, and a
// cross-epoch-blind dedupe / discharge / wire witness. Preserved
// verbatim-in-shape as the subject of the OB5 RED-FIRST receipt (chain K):
// driving K2/K3B's exact registration+feeding schedule through it produces
// the documented FALSE GREEN —
//   (a) CROSS-EPOCH FLOOR DISCHARGE: epoch B's snapshotApplied(seq) sweeps
//       EVERY obligation ≤ seq regardless of lifetime, so B's snapshot@7
//       "discharges" epoch A's withheld append@7 whose content B's bytes
//       provably omit (open=[] — green while content is absent);
//   (b) DEDUPE SWALLOW: the (seq,kind) registration key silently drops
//       epoch B's frames whose (seq,kind) epoch A already used — with
//       mirrored seq layouts (K3B) the ENTIRE second lifetime registers
//       nothing.
// The scoped ObligationOracle above is the live one; this class exists only
// to be observed failing honestly. Do not extend it.
class UnscopedObligationOracle {
  obls: { seq: number; kind: string; disp: Disposition; observe: () => boolean; note: string }[] = [];
  floor = 0; // single numeric floor — the OB5 defect

  deliver(seq: number, kind: string, observe: () => boolean, note = ""): void {
    this.obls.push({ seq, kind, disp: "pending", observe, note });
  }
  snapshotApplied(seq: number): void {
    if (seq > this.floor) this.floor = seq;
    for (const o of this.obls) {
      if (o.seq <= seq && o.disp !== "applied") o.disp = "discharged";
    }
  }
  classifyPending(): void {
    for (const o of this.obls) {
      if (o.disp === "pending" || o.disp === "open") {
        o.disp = o.observe() ? "applied" : "open";
      }
    }
  }
  settle(): void {
    this.classifyPending();
    for (const o of this.obls) {
      if (o.kind === "snapshot" && o.disp === "applied") this.snapshotApplied(o.seq);
    }
  }
  openObligations() {
    return this.obls.filter((o) => o.disp === "open" || o.disp === "pending");
  }
  checkMemoryOpen(cursor: number, atOp: string): { atOp: string; cursor: number; seq: number; kind: string }[] {
    const out: { atOp: string; cursor: number; seq: number; kind: string }[] = [];
    for (const o of this.openObligations()) {
      if (cursor >= o.seq) out.push({ atOp, cursor, seq: o.seq, kind: o.kind });
    }
    return out;
  }
}

// registerProducerUnscoped — the pre-OB5 registration (the dedupe key and
// wire witness WITHOUT epoch). Observers are the same generalized ones the
// scoped registrar builds (they were epoch-free already); only the identity
// key and the wire witness's unscoped comparison reproduce the defect.
function registerProducerUnscoped(
  oracle: UnscopedObligationOracle,
  frames: FixtureFrame[],
  upto = frames.length,
): number {
  const before = oracle.obls.length;
  for (let i = 0; i < upto; i++) {
    const f = frames[i];
    switch (f.event) {
      case "snapshot":
      case "message.upsert":
      case "part.upsert":
      case "part.append": {
        const seq = frameSeq(f);
        const key = `${seq}:${f.event}`;
        if (oracle.obls.some((o) => `${o.seq}:${o.kind}` === key)) continue; // ← the swallow
        if (f.event === "snapshot") {
          const snap = JSON.parse(f.data) as any;
          const newly: string[] = [];
          for (const it of (snap.messages?.[SID] ?? []) as any[]) {
            const mid = it?.info?.id;
            if (typeof mid === "string" && !ctx?.byId(mid)) newly.push(mid);
          }
          if (newly.length > 0) {
            oracle.deliver(seq, "snapshot", () => newly.some((mid) => Boolean(ctx?.byId(mid))), `snap-content:${newly.join(",")}`);
          } else {
            oracle.deliver(seq, "snapshot", () => lastUrlCursor >= seq, "snap-wire"); // ← unscoped comparison
          }
        } else if (f.event === "message.upsert") {
          const mid = (JSON.parse(f.data) as any).id as string;
          oracle.deliver(seq, "message.upsert", () => Boolean(ctx?.byId(mid)), `m:${mid}`);
        } else if (f.event === "part.upsert") {
          const pj = JSON.parse(f.data) as any;
          oracle.deliver(seq, "part.upsert", () => Boolean(ctx?.byId(pj.messageID)?.parts?.[pj.id]), `p:${pj.id}`);
        } else {
          const pj = JSON.parse(f.data) as any;
          oracle.deliver(
            seq,
            "part.append",
            () => {
              const p = ctx?.byId(pj.messageID)?.parts?.[pj.partID];
              return typeof p?.text === "string" && p.text.startsWith(pj.text ?? "");
            },
            `a:${pj.partID}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return oracle.obls.length - before; // registrations that actually landed
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
  lastUrlEpoch = "";
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
// any byte is fired, stamped with the fixture's store-lifetime epoch (read
// from the snapshot JSON — on the wire — or passed by the chain for a
// snapshotless replay body). A frame re-served on a later connection (replay
// of a previously-withheld seq) is NOT re-registered within one epoch —
// obligation identity is (epoch, seq, kind); the replayed delivery resolves
// the ORIGINAL obligation. ACROSS epochs nothing dedupes: epoch B's
// snapshot@4 and epoch A's snapshot@4 are two obligations of two lifetimes
// (the pre-OB5 (seq,kind) dedupe silently swallowed the second — see the
// UnscopedObligationOracle red receipt).
//
// Observers read TWO observables, matched to the witness class (F3):
//   - CONTENT class — the store's content (a newly-introduced id, message
//     id, or part now resident);
//   - WIRE-DEFERRED class — the NEXT reconnect's URL cursor+epoch PAIR read
//     off the mocked EventSource's URL (harness state — never production
//     bookkeeping). (F3 defer 3, folded by OB5: the old header's "Observers
//     read the store's content only" stopped being true when F3 added the
//     wire class; both observables are now named here.)
function registerProducer(
  oracle: ObligationOracle,
  frames: FixtureFrame[],
  upto = frames.length,
  epochOverride?: string,
): void {
  const life = epochOverride ?? fixtureEpoch(frames);
  if (!life) {
    throw new Error("registerProducer: no epoch — snapshotless fixture needs an explicit store-life epoch");
  }
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
        const key = `${life}:${seq}:${f.event}`;
        if (oracle.obls.some((o) => `${o.epoch}:${o.seq}:${o.kind}` === key)) continue;
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
            //   claims seq as its resume point WITH THE OBLIGATION'S OWN
            //   EPOCH DECLARED (OB5 scoping — a foreign-epoch URL never
            //   satisfies it). DOCUMENTED APPROXIMATION: a matching-epoch
            //   cursor ≥ seq could in principle rise past seq by a
            //   non-snapshot route; in this scenario set that is impossible
            //   (the only advance routes are this snapshot's own floor-raise
            //   and incremental claims — and the negative control delivers
            //   nothing). NEVER a `() => true` fallback.
            //
            //   F3 DEFER 2 (advisory, folded by OB5) — ALTERNATE RESIDENCY:
            //   the class split keys on REGISTRATION-time residency. A
            //   snapshot whose "newly" id became resident via a DIFFERENT
            //   route than this snapshot's own apply (e.g. a live frame for
            //   the same id delivered on an earlier connection of the same
            //   scenario) classifies content-class even though this
            //   snapshot's delivery contributed nothing — its witness then
            //   cannot distinguish the two routes. NOT producible by any
            //   committed schedule (every scenario's newly-ids appear only
            //   in that scenario's own snapshot frames); recorded so a
            //   future multi-delivery fixture knows the split is
            //   registration-time, not delivery-time.
            const snap = JSON.parse(f.data) as any;
            const newly: string[] = [];
            for (const it of (snap.messages?.[SID] ?? []) as any[]) {
              const mid = it?.info?.id;
              if (typeof mid === "string" && !ctx?.byId(mid)) newly.push(mid);
            }
            if (newly.length > 0) {
              oracle.deliver(
                life,
                seq,
                "snapshot",
                () => newly.some((mid) => Boolean(ctx?.byId(mid))),
                `snap-content:${newly.join(",")}`,
              );
            } else {
              oracle.deliver(
                life,
                seq,
                "snapshot",
                () => lastUrlEpoch === life && lastUrlCursor >= seq,
                "snap-wire",
              );
            }
            break;
          }
          case "message.upsert": {
            const mid = (JSON.parse(f.data) as any).id as string;
            oracle.deliver(life, seq, "message.upsert", () => Boolean(ctx?.byId(mid)), `m:${mid}`);
            break;
          }
          case "part.upsert": {
            const pj = JSON.parse(f.data) as any;
            oracle.deliver(
              life,
              seq,
              "part.upsert",
              () => Boolean(ctx?.byId(pj.messageID)?.parts?.[pj.id]),
              `p:${pj.id}@${pj.messageID}`,
            );
            break;
          }
          case "part.append": {
            const pj = JSON.parse(f.data) as any;
            oracle.deliver(
              life,
              seq,
              "part.append",
              () => {
                const p = ctx?.byId(pj.messageID)?.parts?.[pj.partID];
                return typeof p?.text === "string" && p.text.startsWith(pj.text ?? "");
              },
              `a:${pj.partID}@${pj.messageID}`,
            );
            break;
          }
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
// URL cursor AND declared epoch (the wire-level observables of the module's
// ACTUAL remembered claim and its store-lifetime pairing — never inputs).
// Runs the OB1 invariant check scoped to the URL's declared epoch (fresh
// boot or post-close: live receipt cursor zeroed).
function openAndObserve(
  c: Ctx,
  oracle: ObligationOracle,
  atOp: string,
): { es: MockEventSource; cursor: number; epoch: string; violations: Violation[] } {
  c.ses.closeSessionStream();
  c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
  const all = sessionESes();
  const es = all[all.length - 1];
  const cursor = urlCursor(es);
  const epoch = urlEpoch(es);
  // The URL cursor+epoch are the wire-deferred snapshot witness's
  // observables, and they just moved — re-settle BEFORE the invariant
  // check, so a snapshot whose apply is qualified by THIS cursor (chain C's
  // fully merge-skipped fallback) is no longer counted open against its own
  // repair point.
  lastUrlCursor = cursor;
  lastUrlEpoch = epoch;
  oracle.settle();
  const violations = oracle.checkMemoryOpen(cursor, atOp, epoch);
  // The invariant check result is consumed by callers via expect on the
  // returned violations — keep it explicit:
  return { es, cursor, epoch, violations };
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
    expect(manifest.scenarios.length).toBe(10);
    for (const sc of manifest.scenarios) {
      const fx = loadFixture(sc.file);
      expect(fx.journal, `${sc.file} journal header`).toBe(sc.journal);
      expect(
        fx.frames.map((f) => ({ event: f.event, id: f.id })),
        `${sc.file} frames`,
      ).toEqual(sc.frames);
    }
  });

  it("the six-way fallback_reason discriminator appears across the matrix (incl. genuine ring_eviction + compatibility_fallback + OB5 epoch_mismatch)", () => {
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
        "epoch_mismatch",
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
    const ep = "ep-ctrl";
    o.deliver(ep, 7, "part.append", () => false, "a:p1"); // withheld: never applies
    o.classifyPending();
    expect(o.checkMemoryOpen(6, "ctrl", ep)).toEqual([]); // 6 < 7: legal (chain R's shape)
    const v = o.checkMemoryOpen(7, "ctrl", ep); // a hypothetical over-claim
    expect(v).toHaveLength(1);
    expect(v[0].offending.seq).toBe(7);
    expect(v[0].offending.epoch).toBe(ep);
    // OB5: an obligation of a DIFFERENT epoch is never compared against
    // this connection's cursor (the seq spaces of two lifetimes are
    // unrelated — a foreign-epoch covering cursor is not an OB1 violation).
    expect(o.checkMemoryOpen(99, "ctrl", "ep-other")).toEqual([]);
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
    const epochA = fixtureEpoch(r1.frames); // the store life every R/C fixture shares
    expect(epochA).toBe(EPOCH_TOK);

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
    expect(oracle.floorOf(epochA)).toBe(4);

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
    // R2's body is snapshotless (replay): register under the SAME store
    // life's epoch (read from R1's snapshot — R2 carries none of its own).
    registerProducer(oracle, r2.frames, r2.frames.length, epochA);
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
    expect(oracle.floorOf(EPOCH_TOK)).toBe(7);
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
    expect(oracle.floorOf(EPOCH_TOK)).toBe(10);

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
    expect(oracle.floorOf(EPOCH_TOK)).toBe(4);
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
    expect(oracle.floorOf(EPOCH_TOK)).toBe(4);
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
    expect(oracle.floorOf(EPOCH_TOK)).toBe(10);
    expect(oracle.openObligations()).toEqual([]);
    expect(c.byId("m2")).toBeTruthy(); // genuinely discharged — content resident
    expect(c.byId("m3")).toBeTruthy();
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAIN K (OB5) — the epoch handshake end-to-end on real bytes: DISTINCT
// lifetime epochs, never collapsed to one token. HONESTY NOTE: production
// code is expected GREEN throughout — the red-first receipt in K2/K3 is the
// ORACLE's false green (the pre-OB5 unscoped oracle), not a production
// defect; the server/client epoch code is landed and component-tested
// (stream_epoch_handshake_test.go, epochHandshakeLifecycle.test.ts). OB5 is
// bridge coverage: real Go emission carrying REAL per-store-lifetime epochs
// → real TS decode → producer-stamp transition → the actual next URL's
// cursor+epoch pairing.
// ═════════════════════════════════════════════════════════════════════════════

describe("chain K1 — epoch-PRESERVED resume: cursor+epoch paired, same-store handshake stays replay", () => {
  it("a matching epoch on the reconnect URL does not flip the replay branch; the withheld tail repairs in the same epoch", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const k1 = loadFixture("K1-epoch-preserved-replay.sse");
    const epochA = fixtureEpoch(r1.frames);
    expect(epochA).toBe(EPOCH_TOK);

    // Leg 1 — chain R's exact prefix: [snapshot@4, m2@5, p1up@6], the tail
    // append@7 withheld.
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 1);
    await settleAsync(oracle);
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([7]);
    expect(oracle.floorOf(epochA)).toBe(4);

    // Leg 2 — reconnect: the URL carries the cursor AND the epoch PAIRED
    // (both observed, never inputs). The Go side generated K1 for EXACTLY
    // this pairing (manifest request line pins cursor=<n>&epoch=<ep-A>).
    const { es: es2, cursor, epoch, violations } = openAndObserve(c, oracle, "K1:reconnect");
    expect(cursor).toBe(6);
    expect(epoch).toBe(epochA); // the pairing: A's cursor declared with A's epoch
    expect(es2.url).toContain(`cursor=${cursor}&`);
    expect(es2.url).toContain(`&epoch=${epochA}`);
    expect(violations).toEqual([]); // 6 < 7 within epoch A

    const manifest = loadManifest();
    const k1md = manifest.scenarios.find((s) => s.file === "K1-epoch-preserved-replay.sse")!;
    expect(k1md.request).toContain(`cursor=${cursor}&`);
    expect(k1md.request).toContain(`&epoch=${epochA}`);
    expect(k1md.journal).toContain("path=replay"); // a MATCHING handshake must not flip the branch
    expect(k1md.journal).toContain("fallback_reason=none");

    // Feed the replay: repairs within the SAME epoch; floor per-epoch-A
    // unchanged (replay ships no snapshot); zero open; zero violations.
    registerProducer(oracle, k1.frames, k1.frames.length, epochA);
    feedFrames(es2, k1.frames);
    await settleAsync(oracle);
    expect(c.partP1()?.text).toBe("a");
    expect(oracle.openObligations()).toEqual([]);
    expect(oracle.floorOf(epochA)).toBe(4);
  }, 20_000);
});

describe("chain K2 — epoch-CHANGE crux: dead pairing → epoch_mismatch fresh snapshot, obligations re-seeded under the NEW epoch", () => {
  it("the dead cursor neither strands content nor over-claims B's seq space; A's withheld obligation EXPIRES (never discharged)", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    // The pre-OB5 oracle runs the SAME schedule in parallel — the red-first
    // receipt's subject (see the asserts after leg 2).
    const legacy = new UnscopedObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const k2 = loadFixture("K2-epoch-change-fresh.sse");
    const epochA = fixtureEpoch(r1.frames);
    const epochB = fixtureEpoch(k2.frames);
    // DISTINCT-LIFETIME epochs must never collapse to one token.
    expect(epochA).toBe(EPOCH_TOK);
    expect(epochB).not.toBe(epochA);
    expect(epochB).toBe("ep-0000000000000000000bbbbb");

    // Leg 1 — chain R's prefix: [snapshot@4, m2@5, p1up@6], append@7
    // withheld (epoch A's open obligation).
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, r1.frames);
    registerProducerUnscoped(legacy, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 1);
    await settleAsync(oracle);
    legacy.settle();
    expect(oracle.openObligations().map((o) => o.seq)).toEqual([7]);
    expect(legacy.openObligations().map((o) => o.seq)).toEqual([7]);

    // Leg 2 — the module's reconnect URL carries the DEAD-STORE pairing:
    // cursor=6 (A's seq space) declared with epoch=ep-A. Both oracles see
    // the same honest picture here (6 < 7 in epoch A).
    const { es: es2, cursor: deadCursor, epoch, violations } = openAndObserve(c, oracle, "K2:reconnect");
    expect(deadCursor).toBe(6);
    expect(epoch).toBe(epochA);
    expect(es2.url).toContain(`cursor=${deadCursor}&`);
    expect(es2.url).toContain(`&epoch=${epochA}`);
    expect(violations).toEqual([]);

    // The Go side generated K2 for EXACTLY this dead pairing — a SECOND
    // store life whose handler computed the mismatch against its own epoch.
    const manifest = loadManifest();
    const k2md = manifest.scenarios.find((s) => s.file === "K2-epoch-change-fresh.sse")!;
    expect(k2md.request).toContain(`cursor=${deadCursor}&`);
    expect(k2md.request).toContain(`&epoch=${epochA}`); // the DEAD pairing is pinned in the manifest
    expect(k2md.journal).toContain("path=fresh");
    expect(k2md.journal).toContain("fallback_reason=epoch_mismatch");
    expect(k2md.journal).toContain("had_cursor=true");

    // Feed store B's bytes (fresh snapshot@7, B-exclusive n1..n3): the
    // producer boundary registers under epoch B — NO identity collision
    // with epoch A's (seq,kind) pairs (the unscoped dedupe swallowed these
    // in the K3 geometry; here the pairs simply differ).
    registerProducer(oracle, k2.frames);
    registerProducerUnscoped(legacy, k2.frames);
    feedFrames(es2, k2.frames);
    await settleAsync(oracle);
    legacy.settle();

    // SCOPED (honest): B's snapshot APPLIES — content witness on the
    // B-exclusive ids; the floor map holds BOTH lifetimes; epoch A's
    // withheld append@7 takes the EXPLICIT terminal disposition "expired"
    // (recorded, not open, and NOT discharged — B's bytes provably omit its
    // content: p1.text is still "" — the m1 body is a protected resident
    // and the snapshot's repair is merge-skipped).
    expect(c.byId("n1")).toBeTruthy();
    expect(c.byId("n2")).toBeTruthy();
    expect(c.byId("n3")).toBeTruthy();
    expect(c.partP1()?.text).toBe(""); // A's append content never arrived through B
    const expired = oracle.obls.find((o) => o.epoch === epochA && o.seq === 7)!;
    expect(expired.disp).toBe("expired");
    expect(expired.disp).not.toBe("discharged");
    expect(oracle.floorOf(epochA)).toBe(4);
    expect(oracle.floorOf(epochB)).toBe(7);
    expect(oracle.openObligations()).toEqual([]);

    // ── RED-FIRST RECEIPT (a): the pre-OB5 oracle's FALSE GREEN ─────────
    // The SAME schedule through the unscoped oracle: B's snapshot@7 applied
    // → the single floor sweeps ≤7 REGARDLESS of lifetime → A's withheld
    // append@7 is reported "discharged" and nothing is open — GREEN while
    // the append's content is provably absent (asserted above: p1.text "").
    // This is the exact lie the epoch-scoped floor exists to kill.
    const legacyAppend = legacy.obls.find((o) => o.seq === 7 && o.kind === "part.append")!;
    expect(legacyAppend.disp).toBe("discharged"); // ← the false discharge
    expect(legacy.openObligations()).toEqual([]); // ← the false green
    expect(legacy.floor).toBe(7); // one numeric floor, laundering A's space

    // Leg 3 — the NEXT reconnect claims the NEW epoch's repair point: B's
    // snapshot seq PAIRED with B's epoch — never the dead cursor under ep-B
    // (that pairing is the laundering hole rounds 6-9 closed; K3 proves the
    // matrix would catch it) and never A's epoch again (a stale producer
    // stamp would emit epoch=ep-A here).
    const { es: es3, cursor: cursor3, epoch: epoch3, violations: violations3 } = openAndObserve(c, oracle, "K2:post-epoch-change");
    expect(cursor3).toBe(7); // B's snapshot seq — the new epoch's repair point
    expect(epoch3).toBe(epochB);
    expect(es3.url).toContain(`cursor=${cursor3}&`);
    expect(es3.url).toContain(`&epoch=${epochB}`);
    expect(es3.url).not.toContain(`cursor=${deadCursor}&`); // the dead-epoch cursor is gone
    expect(violations3).toEqual([]); // epoch B holds zero open obligations
  }, 20_000);
});

describe("chain K3 — red-first receipt (b) + the dead-cursor perturbation the matrix MUST catch", () => {
  it("K3B's withheld epoch-B tail leaves an open obligation the dead A-cursor COVERS: both detectors fire on the perturbed pair", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const legacy = new UnscopedObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const k3b = loadFixture("K3B-epoch-change-low-live.sse");
    const epochA = fixtureEpoch(r1.frames);
    const epochB = fixtureEpoch(k3b.frames);
    expect(epochB).not.toBe(epochA); // distinct lifetimes, never collapsed

    // Leg 1 — R1's prefix (append@7 withheld under epoch A).
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, r1.frames);
    registerProducerUnscoped(legacy, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 1);
    await settleAsync(oracle);
    legacy.settle();

    // Leg 2 — the DEAD-STORE pairing on the wire (cursor=6&epoch=ep-A),
    // served by K3B's LOW second life: epoch_mismatch fresh snapshot@4 +
    // live tail n1@5/q1up@6. The TS side delivers the prefix and WITHHOLDS
    // q1up@6 — a real disconnect shape leaving epoch B an OPEN obligation
    // at seq 6 (a seq the dead A-cursor numerically covers: the geometry
    // this fixture exists for).
    const { es: es2, cursor: deadCursor, epoch } = openAndObserve(c, oracle, "K3:reconnect");
    expect(deadCursor).toBe(6);
    expect(epoch).toBe(epochA);
    const manifest = loadManifest();
    const k3md = manifest.scenarios.find((s) => s.file === "K3B-epoch-change-low-live.sse")!;
    expect(k3md.request).toContain(`cursor=${deadCursor}&`);
    expect(k3md.request).toContain(`&epoch=${epochA}`);
    expect(k3md.journal).toContain("fallback_reason=epoch_mismatch");

    // ── RED-FIRST RECEIPT (b): the unscoped DEDUPE SWALLOW ──────────────
    // K3B's seq layout MIRRORS A's (snapshot@4, message@5, part@6 — the
    // store's seq space reset, exactly the documented invariant). The
    // pre-OB5 registration key (seq,kind) already holds ALL THREE pairs
    // from epoch A, so the ENTIRE second lifetime registers NOTHING —
    // silently: no error, no obligation, no witness for B's delivery.
    const legacyBefore = legacy.obls.length;
    const landed = registerProducerUnscoped(legacy, k3b.frames);
    expect(landed).toBe(0); // ← the swallow: 3 frames, 0 registrations
    expect(legacy.obls.length).toBe(legacyBefore);
    const scopedBefore = oracle.obls.length;
    registerProducer(oracle, k3b.frames);
    expect(oracle.obls.length).toBe(scopedBefore + 3); // epoch-scoped: all three land under epoch B

    feedFrames(es2, k3b.frames, k3b.frames.length - 1); // deliver snapshot@4 + n1@5; WITHHOLD q1up@6
    await settleAsync(oracle);
    legacy.settle();

    // Scoped: n1 applied; B's snapshot@4 is WIRE-DEFERRED (its only id m1
    // was already resident — no content witness exists); q1up@6 open under
    // epoch B; A's append@7 still open (no B snapshot has APPLIED yet — the
    // wire witness has not fired).
    expect(c.byId("n1")).toBeTruthy();
    const openB = oracle.openObligations().filter((o) => o.epoch === epochB);
    expect(openB.map((o) => `${o.seq}:${o.kind}`)).toEqual(["4:snapshot", "6:part.upsert"]);
    expect(oracle.openObligations().some((o) => o.epoch === epochA && o.seq === 7)).toBe(true);

    // Leg 3 (honest module) — the reconnect claims epoch B's repair point:
    // cursor=5 (snapshot floor + n1) PAIRED with ep-B. The wire witness
    // fires HERE (lastUrlCursor=5 ≥ 4 with epoch B): B's snapshot@4
    // applies, the LIFETIME RULE expires A's append@7, and the invariant
    // holds (5 < 6).
    const { es: es3, cursor: cursor3, epoch: epoch3, violations } = openAndObserve(c, oracle, "K3:post-epoch-change");
    expect(cursor3).toBe(5);
    expect(epoch3).toBe(epochB);
    expect(es3.url).toContain(`cursor=${cursor3}&`);
    expect(es3.url).toContain(`&epoch=${epochB}`);
    expect(violations).toEqual([]);
    expect(oracle.floorOf(epochB)).toBe(4);
    const expired = oracle.obls.find((o) => o.epoch === epochA && o.seq === 7)!;
    expect(expired.disp).toBe("expired"); // the dead epoch's obligation: explicit, terminal
    expect(oracle.openObligations().map((o) => `${o.epoch}:${o.seq}`)).toEqual([`${epochB}:6`]);

    // ── THE PERTURBATION: a faithful client defect the matrix MUST catch ─
    // The send-site treating the DEAD-epoch cursor as valid would emit
    // cursor=<deadCursor=6> PAIRED with the NEW epoch's declaration
    // (cursor=6&epoch=ep-B) — a MATCHING handshake the server cannot
    // reject, and an over-claim of epoch B's space (6 COVERS B's open
    // q1up@6; B's snapshot floor is only 4). Both detectors fire:
    //
    // Detector 1 (OB1 invariant, EXECUTED on the real oracle state and the
    // real observed dead-cursor value): the covering cursor is flagged.
    const flagged = oracle.checkMemoryOpen(deadCursor, "K3:perturbed-dead-cursor", epochB);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].cursor).toBe(6);
    expect(flagged[0].offending.seq).toBe(6);
    expect(flagged[0].offending.epoch).toBe(epochB);
    expect(flagged[0].offending.kind).toBe("part.upsert");
    //
    // Detector 2 (the URL pairing assert, EXECUTED on the perturbed URL —
    // the real es3 URL grammar with the dead cursor restored): the leg-3
    // binding "cursor names epoch B's repair point (5)" FAILS on it.
    const perturbedUrl = es3.url.replace(`cursor=${cursor3}`, `cursor=${deadCursor}`);
    expect(perturbedUrl).toContain(`cursor=${deadCursor}&`); // the perturbation took…
    expect(perturbedUrl).toContain(`&epoch=${epochB}`); // …paired with ep-B (the laundering shape)
    expect(cursorOfUrl(perturbedUrl)).not.toBe(cursor3); // the pairing assert `toBe(5)` rejects it — detected
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// settle() IDEMPOTENCE — the OB5 review's three-leaf deferred finding
// (b-F1/b-F2/c-F1, fired by the OB5 commit's own path_touched trigger),
// red-first. Oracle-only (no module, no fixtures — the defect is the ORACLE's
// repeated-observation behavior, tool hardening not production): K3's exact
// disposition timeline is reproduced with boolean-flag observers standing in
// for the chain's witness classes (A's snapshot content witness fires at leg
// 1; B's snapshot wire witness fires at leg 3; the two withheld obligations
// never fire). Registration is PHASED exactly like the chain — epoch B's
// obligations are registered only AFTER leg 1's settle (A's snapshot already
// applied) — because the A-establishment at leg 1 would otherwise expire B's
// not-yet-legitimate obligations for a reason no chain schedule exhibits.
// The applied-but-inert middle obligations of the real chain (A's m2@5/
// p1up@6, B's n1@5) are omitted: they are neither snapshots (no replay in
// settle's loop) nor ever open (no expiry target) — the two mechanisms the
// double-settle exercises. The RED mechanism: settle() REPLAYS every
// historically-applied snapshot (an "applied" disposition is terminal), and
// the pre-fix LIFETIME RULE fired on `activeEpoch !== epoch` — so the second
// settle's REPLAYED A-snapshot@4 visit (first in registration order) flips
// activeEpoch to A and expires B's open q1up@6; the later B-snapshot replay
// flips activeEpoch back to B (the pointer self-heals) but the terminal
// "expired" does not — the perturbation detector then goes blind exactly
// where K3 planted it.
// ═════════════════════════════════════════════════════════════════════════════

describe("settle idempotence — a SECOND settle after the K3 epoch transition changes nothing", () => {
  it("re-settling the K3 leg-3 state keeps activeEpoch=B, q1up@6 OPEN, and the perturbed dead-cursor still flagged", () => {
    const epA = "ep-a";
    const epB = "ep-b";
    const oracle = new ObligationOracle();
    let aSnapSeen = false; // A:snapshot@4 content witness (fires at leg 1)
    let bSnapSeen = false; // B:snapshot@4 wire witness (fires at leg 3)

    // Leg 1 — K3's R1-prefix settle: A's snapshot applies (content witness),
    // the withheld append@7 stays open; epoch A established, floorA=4.
    oracle.deliver(epA, 4, "snapshot", () => aSnapSeen, "A snap-content");
    oracle.deliver(epA, 7, "part.append", () => false, "A a:p1 withheld");
    aSnapSeen = true;
    oracle.settle();
    expect(oracle.activeEpoch).toBe(epA);
    expect(oracle.floorOf(epA)).toBe(4);
    expect(oracle.openObligations().map((o) => `${o.epoch}:${o.seq}`)).toEqual([`${epA}:7`]);

    // Leg 2 — K3's reconnect + partial-feed settles (settle runs TWICE here,
    // as in the chain: openAndObserve's and settleAsync's): B's snapshot
    // registers WIRE-DEFERRED (witness not yet fired) and q1up@6 is
    // withheld — both open under epoch B; A's append@7 still open (nothing
    // has established B yet, so no expiry fires on either settle).
    oracle.deliver(epB, 4, "snapshot", () => bSnapSeen, "B snap-wire");
    oracle.deliver(epB, 6, "part.upsert", () => false, "B p:q1 withheld");
    oracle.settle();
    oracle.settle();
    expect(oracle.openObligations().map((o) => `${o.epoch}:${o.seq}`)).toEqual([
      `${epA}:7`,
      `${epB}:4`,
      `${epB}:6`,
    ]);

    // Leg 3 — the wire observation fires B's snapshot witness (K3's
    // openAndObserve settle): B establishes, the LIFETIME RULE expires A's
    // append@7, q1up@6 stays open — the chain's committed end state.
    bSnapSeen = true;
    oracle.settle();
    expect(oracle.activeEpoch).toBe(epB);
    expect(oracle.floorOf(epB)).toBe(4);
    expect(oracle.obls.find((o) => o.epoch === epA && o.seq === 7)!.disp).toBe("expired");
    expect(oracle.openObligations().map((o) => `${o.epoch}:${o.seq}`)).toEqual([`${epB}:6`]);

    // THE REGRESSION — settle() AGAIN over the SAME observation state.
    oracle.settle();
    // (a) the active lifetime does not regress to the dead epoch A …
    expect(oracle.activeEpoch).toBe(epB);
    // (b) … so B's open q1up@6 was not expired by the replayed A-visit …
    const q = oracle.obls.find((o) => o.epoch === epB && o.seq === 6)!;
    expect(q.disp).toBe("open");
    expect(oracle.openObligations().map((o) => `${o.epoch}:${o.seq}`)).toEqual([`${epB}:6`]);
    // (c) … and the perturbed dead-cursor covering check STILL fires (K3's
    // detector 1, re-executed on the post-re-settle state: cursor=6 paired
    // with ep-B covers B's open q1up@6 — the exact shape the matrix exists
    // to catch).
    const flagged = oracle.checkMemoryOpen(6, "idem:perturbed-dead-cursor", epB);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].cursor).toBe(6);
    expect(flagged[0].offending.seq).toBe(6);
    expect(flagged[0].offending.epoch).toBe(epB);
    expect(flagged[0].offending.kind).toBe("part.upsert");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F3 DEFER 1 (folded by OB5; trigger path_touched(session-cursor-bridge.test.ts))
// — wire-class negative-control pin: a WIRE-DEFERRED snapshot obligation
// that is registered but NEVER DELIVERED must raise neither the floor nor
// the next reconnect cursor. (A `()=>true` regression confined to the wire
// branch passed the F3 suite — this pin closes it.)
// ═════════════════════════════════════════════════════════════════════════════

describe("F3 defer 1 — wire-class negative control: C3 registered-but-undelivered", () => {
  it("C3's wire-deferred snapshot@7 never delivered: floor stays <7 and the NEXT reconnect cursor stays <7", async () => {
    const c = await boot();
    const oracle = new ObligationOracle();
    const r1 = loadFixture("R1-initial-cursorless.sse");
    const c3 = loadFixture("C3-compat-fallback.sse");
    const epochA = fixtureEpoch(r1.frames);

    // Leg 1 — chain C's exact prefix: [snapshot@4, m2@5]; p1up@6+append@7
    // withheld.
    c.ses.openSessionStream(SID, false, "selection-change", "bridge-test");
    const es1 = sessionESes()[0];
    registerProducer(oracle, r1.frames);
    feedFrames(es1, r1.frames, r1.frames.length - 2);
    await settleAsync(oracle);
    expect(oracle.floorOf(epochA)).toBe(4);

    // Leg 2 (the probe) — the kill-switch legacy reconnect (cursor=5, no
    // part_delta). C3's snapshot@7 is WIRE-DEFERRED class (m1+m2 both
    // already resident — no content witness exists), registered at the
    // producer boundary BEFORE any feeding… and then NOTHING is delivered
    // (the connection died before the first frame). The honest wire witness
    // cannot fire until a matching-epoch URL cursor claims ≥7 — which this
    // schedule never observes.
    c.ses._setPartDeltaEnabledForTest(false);
    const { es: es2, cursor } = openAndObserve(c, oracle, "C-wire-NC");
    expect(cursor).toBe(5);
    registerProducer(oracle, c3.frames);
    feedFrames(es2, c3.frames, 0); // deliver NOTHING — the withheld fallback snapshot
    await settleAsync(oracle);
    expect(oracle.floorOf(epochA)).toBeLessThan(7); // stays 4 — a ()=>true wire branch would print 7 here
    expect(oracle.openObligations().map((o) => `${o.seq}:${o.kind}`)).toEqual([
      "6:part.upsert",
      "7:part.append",
      "7:snapshot",
    ]);

    // Leg 3 — the NEXT reconnect still claims the PRE-snapshot cursor (<7):
    // the module never applied C3's bytes. (Honesty note: the module was
    // always honest here — the pin's teeth are the oracle-side floor above.)
    const { cursor: cursor3, violations } = openAndObserve(c, oracle, "C-wire-NC:post");
    expect(cursor3).toBeLessThan(7);
    expect(cursor3).toBe(5);
    expect(violations).toEqual([]); // 5 < 6,7 — the withheld set stays uncovered
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
