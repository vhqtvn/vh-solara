// stream-open-diag — PWA warm-resume stream diagnostics (2026-10-28 card
// task-2026-10-28t15-08-16-pwa-resume-diagnostics-capture-instrumentation).
//
// LOGGING ONLY. This module OBSERVES stream opens + EventSource lifecycle; it
// never influences transport control flow. It is the runtime tracker sitting
// on top of the existing default-OFF diaglog ring (see ./diaglog): it creates
// one StreamOpenEntry per tree/session EventSource construction, completes
// that SAME record's content-progress stamps as frames land, and emits bounded
// StreamLifeEntry records for onopen/onerror so a NATIVE auto-reconnect
// (onerror readyState=CONNECTING with no new stream-open) is distinguishable
// from a JS-owned open — the A3-vs-A4/A5/A6 discriminator from the S0
// taxonomy (tmp/agent-runs/pwa-resume-surge/s0-research.md gate (a)).
//
// Guarantees (mirror diaglog's posture):
//  - Default OFF per project: when diaglog capture is off, note*StreamOpen
//    allocates NOTHING and keeps no current record, so every stamp/lifecycle
//    helper is a single null check. Zero work on the hot path.
//  - Bounded: entries land in the capped diaglog ring (200 entries / 10 min,
//    oldest dropped); es-life emissions are additionally rate-bounded per
//    connection generation (first onerror always, then ≤1 per 30 s).
//  - No render path, no timers of its own, no reactive reads in stamp paths.
//
// Retrieval (capture protocol — see
// tmp/agent-runs/pwa-resume-surge/capture-1/README.md): enable capture in the
// pane's hidden Diagnostic-log dialog (server-admin menu), reproduce, then
// "Copy all" from the same dialog; counts also mirror into
// window.__vhSyncDiag().streamOpens.
import { isEmbedded } from "../embedded";
import { projectDir } from "./store";
import {
  captureDiagEntry,
  diagLogEnabled,
  touchDiagPersist,
  type StreamLifeEntry,
  type StreamOpenEntry,
  type StreamOpenReason,
} from "./diaglog";
import { countStreamOpen } from "./recovery-reasons";

export type { StreamOpenReason };
export { STREAM_OPEN_REASONS } from "./diaglog";

// Bounded es-life rate: after the FIRST onerror of a connection generation
// (always logged), further onerror events are logged at most once per this
// window. A frozen-then-thawed pane's native retry storm cannot flood the ring.
export const STREAM_LIFE_LOG_GAP_MS = 30_000;

export type StreamKind = "tree" | "session";

export interface StreamOpenInfo {
  /** Connection generation AFTER the open's bump (treeGen / sesGen). */
  generation: number;
  reason: StreamOpenReason;
  detail?: string;
  /** Session id (session stream only). */
  sessionId?: string;
  /** Resume cursor SENT on the open URL (0 = none). */
  cursor: number;
  /** Whether the URL carried a meaningful (>0) cursor. */
  hadCursor: boolean;
}

// Per-stream tracker: the current connection's open record + the lifecycle
// bounding state for its generation. Replaced wholesale by the next open.
interface StreamTracker {
  rec: StreamOpenEntry | null;
  gen: number;
  errCount: number;
  lastErrLogTs: number;
}
const trackers: Record<StreamKind, StreamTracker> = {
  tree: { rec: null, gen: -1, errCount: 0, lastErrLogTs: 0 },
  session: { rec: null, gen: -1, errCount: 0, lastErrLogTs: 0 },
};

function noteOpen(stream: StreamKind, info: StreamOpenInfo): void {
  const t = trackers[stream];
  // Reset bounding state for the new generation even when capture is off, so
  // a later enable mid-connection cannot mis-attribute attempts.
  t.gen = info.generation;
  t.errCount = 0;
  t.lastErrLogTs = 0;
  t.rec = null;
  // The __vhSyncDiag mirror is ALWAYS on (near-free Map increments) — the
  // burst census must exist even when the bounded ring was never enabled.
  countStreamOpen(stream, info.reason);
  if (!diagLogEnabled()) return; // default-off: no allocation, no ring write
  const rec: StreamOpenEntry = {
    kind: "stream-open",
    ts: Date.now(),
    stream,
    reason: info.reason,
    detail: info.detail,
    pane: isEmbedded() ? "hosted" : "standalone",
    project: projectDir(),
    sessionId: info.sessionId,
    generation: info.generation,
    cursor: info.cursor,
    hadCursor: info.hadCursor,
    fallbackArmed: false,
  };
  t.rec = rec;
  captureDiagEntry(rec);
}

/** Record one tree-stream EventSource construction. */
export function noteTreeStreamOpen(info: StreamOpenInfo): void {
  noteOpen("tree", info);
}
/** Record one session-stream EventSource construction. */
export function noteSessionStreamOpen(info: StreamOpenInfo): void {
  noteOpen("session", info);
}

// --- stamp completion (mutate the SAME record; first write wins) ------------
//
// All helpers are generation-guarded: a stamp only lands on the record whose
// connection is still current, so a superseded connection's late frames
// cannot pollute the replacement's record.

type StampField = "openTs" | "firstFrameTs" | "firstSnapshotTs" | "snapshotAppliedTs" | "replayDoneTs";

function stamp(stream: StreamKind, gen: number, field: StampField): void {
  const t = trackers[stream];
  const rec = t.rec;
  if (!rec || rec.generation !== gen || rec[field] !== undefined) return;
  rec[field] = Date.now();
  touchDiagPersist();
}

/** Tree-stream stamp (gen = the connection's captured treeGen). */
export function noteTreeStamp(gen: number, field: StampField): void {
  stamp("tree", gen, field);
}
/** Session-stream stamp (gen = the connection's captured sesGen). */
export function noteSessionStamp(gen: number, field: StampField): void {
  stamp("session", gen, field);
}

/**
 * Tree snapshot-APPLIED stamp for the three tree apply sites (coherent
 * tryInstall + the two independent applies). All three run only under a
 * current-generation guard, so callers pass the generation they hold
 * (owner.generation / the listener's captured gen / treeGen).
 */
export function noteTreeSnapshotAppliedIfCurrent(gen: number): void {
  stamp("tree", gen, "snapshotAppliedTs");
}

/** Mark the current session-stream record as having ARMED the silence fallback. */
export function noteSessionFallbackArmed(gen: number): void {
  const rec = trackers.session.rec;
  if (!rec || rec.generation !== gen) return;
  if (rec.fallbackArmed) return;
  rec.fallbackArmed = true;
  touchDiagPersist();
}

// --- EventSource lifecycle observability (bounded) ---------------------------

function noteLife(
  stream: StreamKind,
  gen: number,
  phase: "onopen" | "onerror",
  readyState: number,
): void {
  const t = trackers[stream];
  if (t.gen !== gen) return; // superseded instance: not attributable
  if (!diagLogEnabled()) return; // bounded work only when capture is on
  const now = Date.now();
  let attempt: number | undefined;
  if (phase === "onerror") {
    t.errCount++;
    attempt = t.errCount;
    // Bounded: the FIRST error of a generation is always logged (≥1 per gen);
    // subsequent errors at most once per STREAM_LIFE_LOG_GAP_MS window.
    if (t.errCount > 1 && now - t.lastErrLogTs < STREAM_LIFE_LOG_GAP_MS) return;
    t.lastErrLogTs = now;
  }
  const entry: StreamLifeEntry = {
    kind: "es-life",
    ts: now,
    stream,
    generation: gen,
    phase,
    readyState,
    attempt,
  };
  captureDiagEntry(entry);
}

/** Tree EventSource onopen/onerror observation (call at handler entry). */
export function noteTreeLife(gen: number, phase: "onopen" | "onerror", readyState: number): void {
  noteLife("tree", gen, phase, readyState);
}
/** Session EventSource onopen/onerror observation (call after the gen guard). */
export function noteSessionLife(gen: number, phase: "onopen" | "onerror", readyState: number): void {
  noteLife("session", gen, phase, readyState);
}

// --- Test-only ---------------------------------------------------------------

/** Test-only: reset tracker state (not the diaglog ring). */
export function _resetStreamOpenDiagForTest(): void {
  for (const t of Object.values(trackers)) {
    t.rec = null;
    t.gen = -1;
    t.errCount = 0;
    t.lastErrLogTs = 0;
  }
}

/** Test-only: the current open record for a stream (the ring holds the same ref). */
export function _currentRecordForTest(stream: StreamKind): StreamOpenEntry | null {
  return trackers[stream].rec;
}
