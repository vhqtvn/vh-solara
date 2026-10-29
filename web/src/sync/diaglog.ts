// Bounded, default-OFF historical diagnostic log. A ring buffer of FE-only
// timing/log entries, viewable from a non-obvious trigger (the hidden server-
// admin menu). Designed to be EXTENSIBLE (more `kind`s later) but ships minimal:
// only the per-session cold-open timing entry kind today.
//
// GUARANTEES:
//  - Default DISABLED per project. When off, captureDiagEntry() returns before
//    any allocation or buffer write — the "must not log too much" promise.
//  - max-time cap: entries older than MAX_DIAG_AGE_MS are evicted on capture.
//  - max-size cap: the buffer never exceeds MAX_DIAG_ENTRIES (oldest dropped).
//
// The enable flag and the entries buffer are both PROJECT-SCOPED and persisted
// in versioned localStorage, mirroring how sessions/cursor/activity persist.
// The reactive capture is wired once from App.onMount (startDiagCapture).
import { createEffect, createSignal, on } from "solid-js";
import { boolMigrate, loadVersioned, saveVersioned } from "../lib/store";
import { projectDir, selectedId, state } from "./store";

// --- Caps (documented defaults) --------------------------------------------
// max-time: 10 minutes. Long enough to capture a handful of cold opens while
// debugging a "slow session" report, short enough that a forgotten-on toggle
// can't accumulate hours of stale entries. Wall-clock, evaluated at capture.
export const MAX_DIAG_AGE_MS = 10 * 60 * 1000;
// max-size: 200 entries. A cold open is one entry; 200 covers a long debugging
// session at <1 KB/entry (a ~200 KB ceiling) before ring-buffer eviction.
export const MAX_DIAG_ENTRIES = 200;

// --- Entry shape (extensible discriminated union) --------------------------
// Today only the cold-open kind ships. Future kinds (warm switch, reconnect
// stall, …) extend this union and the renderer's switch — no buffer/caps rework.
export interface ColdOpenEntry {
  kind: "cold-open";
  /** Wall-clock capture time (ms epoch). */
  ts: number;
  /** The session whose Stream-2 open completed. */
  sessionId: string;
  /**
   * EventSource construction → onopen (ms). PURE TRANSPORT (DNS/TCP/TLS/
   * handshake through the controller tunnel) — NOT total session-open time.
   * The server flushes `: hello\n\n` immediately at handler entry precisely
   * so this stays pure-transport. For total user-perceived open time see
   * `total` on the rendered entryLine (= open + snap + hydrate when cold).
   * Named `open` on the persisted shape for back-compat; rendered as `conn`
   * in the diag log line and ServersPanel to match its actual meaning.
   */
  open?: number;
  /** Stream-2 onopen → first snapshot frame arrival (ms). */
  snap?: number;
  /** First snapshot → messages.loaded (ms). A finite number = a cold open. */
  hydrate?: number;
  /** Upstream OpenCode GET round-trip portion of hydrate (ms). */
  fetchMs?: number;
  /** Daemon-side SetSessionMessages portion of hydrate (ms). */
  reconcileMs?: number;
}
/**
 * StallEntry — a diagnostic record captured when the FE detects a silent event
 * loss (or suspected loss) and forces a self-heal resync. Written BEFORE the
 * resync fires so the pre-recovery state is preserved in the ring.
 *
  * The triggers:
  *  - `seq-gap`              — a per-stream seq gap not covered by the other
  *                             stream's cursor (Invariant 1).
  *  - `tail-incomplete-on-idle` — activity=idle arrived but the resident tail's
  *                             last assistant message lacks time.completed
  *                             (Invariant 2).
  *  - `content-stale-watchdog` — the dual-clock watchdog forced a reconnect
  *                             (health.ts transport/content stall paths).
  *  - `sentinel-timeout`     — the liveness sentinel (slice 5 webperf/F7)
  *                             waited SENTINEL_TIMEOUT for the probe nonce and
  *                             recovered cursor-preserving (health.ts onTimeout
  *                             closures; the probe itself is counted in
  *                             recovery-reasons.ts sentinel-* codes).
  *  - `reconnect`            — any other forced reconnect (visibility/online).
  *  - `resume-silent-fallback` — slice 5b fix: a cursor-preserving recovery
  *                             reopen delivered nothing for
  *                             SES_RESUME_SILENT_FALLBACK_MS (ring replay
  *                             provably continuous but interest-filtered to
  *                             zero frames); ONE cursorless snapshot
  *                             confirmation follows.
  */
export interface StallEntry {
  kind: "stall";
  /** Wall-clock capture time (ms epoch). */
  ts: number;
  /** What triggered the stall detection + self-heal. */
  trigger: "seq-gap" | "tail-incomplete-on-idle" | "content-stale-watchdog" | "sentinel-timeout" | "reconnect" | "part-append-offset-mismatch" | "resume-silent-fallback";
  /** Which stream(s) the detection + recovery targets. */
  stream: "tree" | "session" | "both";
  /** The session the stall concerns (for session-scoped triggers). */
  sessionId?: string;
  /** Age of Stream1's transport clock at capture (ms). */
  treeLastSeenAge?: number;
  /** Age of Stream1's content-only clock at capture (ms). */
  treeContentSeenAge?: number;
  /** Age of Stream2's transport clock at capture (ms). */
  sessionLastSeenAge?: number;
  /** Age of Stream2's content-only clock at capture (ms). */
  sessionContentSeenAge?: number;
  /** Gate snapshot at capture — what in-flight barriers existed. */
  gate?: {
    busyActive: boolean;
    expectSessionSnap: boolean;
    expectTreeSnap: boolean;
    sesSnapshotDecoding: boolean;
    treeSnapshotDecoding: boolean;
  };
  /** Resident tail summary at capture (for tail-incomplete triggers). */
  residentTail?: {
    sessionId: string;
    lastMsgRole?: string;
    lastMsgCompleted?: boolean;
    msgCount: number;
  } | null;
  /** Seq gap details (for seq-gap triggers). */
  seqGap?: {
    stream: "tree" | "session";
    expected: number;
    got: number;
    missed: number;
  };
  /** EventSource readyState snapshot at capture (0=CONNECTING,1=OPEN,2=CLOSED). */
  eventSourceState?: {
    tree: number;
    session: number;
  };
}
// --- Stream-open diagnostics (PWA warm-resume capture, 2026-10-28) -----------
//
// STREAM_OPEN_REASONS is the CLOSED enum of open-cause values for the
// stream-open diag kind. Every tree/session EventSource construction records
// exactly one of these (an untagged caller lands on the explicit "other") so a
// real-resume capture can attribute each open to its S0 taxonomy path. The
// taxonomy-level granularity (e.g. WHICH recovery forced a fresh open) rides
// the free-form `detail` field; the enum itself must stay closed + stable —
// extend only, never rename (operator evidence packs grep these).
export const STREAM_OPEN_REASONS = [
  "first-open",
  "reveal-resume",
  "visibility-resume",
  "watchdog",
  "onerror-backoff",
  "retry-ladder",
  "recovery-fresh",
  "selection-change",
  "other",
] as const;
export type StreamOpenReason = (typeof STREAM_OPEN_REASONS)[number];

/**
 * StreamOpenEntry — recorded at every tree/session EventSource CONSTRUCTION.
 * The content-progress stamps (openTs/firstFrameTs/firstSnapshotTs/
 * snapshotAppliedTs/replayDoneTs) are completed LATER on the SAME record
 * object (the ring holds the reference; stream-open-diag mutates in place and
 * re-touches persistence), so one line carries construction → catch-up.
 *
 * Stamp semantics (wall-clock ms epoch, joinable against the worker journal
 * ±100 ms):
 *  - openTs            — EventSource onopen (also emitted as an es-life entry).
 *  - firstFrameTs      — first CONTENT frame of any kind on this connection
 *                        (replayed delta, snapshot, tree.snapshot, message.*).
 *  - firstSnapshotTs   — first snapshot-family frame (`snapshot` detail /
 *                        `tree.snapshot` / session `snapshot`).
 *  - snapshotAppliedTs — first snapshot actually APPLIED (tree: coherent
 *                        install or independent apply; session: applySnap).
 *  - replayDoneTs      — tree only: the re-seed `snapshot.complete` boundary
 *                        (the truthful end of a resume catch-up — replay tail
 *                        + re-seed, or the fallback snapshot). The SESSION
 *                        stream has NO replay-complete milestone (S0 gate (b)
 *                        — protocol fact); it stays undefined there, by
 *                        design, not by omission.
 */
export interface StreamOpenEntry {
  kind: "stream-open";
  /** Wall-clock construction time (ms epoch). */
  ts: number;
  stream: "tree" | "session";
  reason: StreamOpenReason;
  /** S0 taxonomy path id for attribution granularity (e.g. "watchdog-closed"). */
  detail?: string;
  /** "hosted" (host-shell iframe) | "standalone" (own window / installed PWA). */
  pane: string;
  /** Project dir at open time (pane/project identity; no pane-id wire surface exists). */
  project: string;
  /** Session id (session stream only). */
  sessionId?: string;
  /** Connection generation AFTER the open's bump (treeGen / sesGen). */
  generation: number;
  /** Resume cursor SENT on the open URL (0 = none). */
  cursor: number;
  /** Whether the URL carried a meaningful (>0) cursor. */
  hadCursor: boolean;
  /** Whether THIS open armed the 8 s silence fallback (stamped at arm time). */
  fallbackArmed: boolean;
  // --- completed later, same record ---
  openTs?: number;
  firstFrameTs?: number;
  firstSnapshotTs?: number;
  snapshotAppliedTs?: number;
  replayDoneTs?: number;
}

/**
 * StreamLifeEntry — NATIVE EventSource lifecycle observability. onopen and
 * onerror (with readyState) are logged BOUNDED (first per connection
 * generation always; further errors at most once per 30 s per generation) so
 * a NATIVE auto-reconnect attempt (onerror readyState=CONNECTING with NO new
 * stream-open record) is distinguishable from a JS-owned open in captured
 * data — the A3-vs-A4/A5/A6 discriminator.
 */
export interface StreamLifeEntry {
  kind: "es-life";
  /** Wall-clock time (ms epoch). */
  ts: number;
  stream: "tree" | "session";
  /** Connection generation the EventSource instance belongs to. */
  generation: number;
  phase: "onopen" | "onerror";
  /** EventSource readyState at the event (0=CONNECTING,1=OPEN,2=CLOSED). */
  readyState: number;
  /** Per-generation onerror ordinal (1-based; absent on onopen). */
  attempt?: number;
}

// --- Grade/cascade diag stamps (PWA resume capture-2, 2026-10-29 card) -------
//
// The capture-1 interpretation (tmp/agent-runs/pwa-resume-surge/
// capture-1-interpretation.md §Q4/§Q5) ranked the toast/connstatus grading
// path as the remaining resume suspect after every instrumented stream
// converged <0.5s: the discriminating evidence for the next capture is
// WHEN/WHY the connstatus grade moved relative to the stream-open applied@
// stamps already in this ring. These kinds ride the SAME ring + caps +
// enable flag (default OFF). Emitters: connstatus.ts's transition observer
// (conn-grade) and cascade.ts's pass-boundary stamps (cascade). Bounded by
// construction — genuine grade transitions and pass-lifecycle edges only,
// never per-tick.
export interface ConnGradeEntry {
  kind: "conn-grade";
  /** Wall-clock capture time (ms epoch). */
  ts: number;
  /** The prior grade; null on the observer's baseline evaluation. */
  from: string | null;
  to: string;
  /** The landing grade's reduction reasons (e.g. ["convergence-pending"]; [] for live). */
  reasons: string[];
}

export interface CascadeDiagEntry {
  kind: "cascade";
  /** Wall-clock capture time (ms epoch). */
  ts: number;
  /** Which pass-lifecycle boundary fired. */
  event: "pass-start" | "step-converged" | "pass-converged" | "pass-timeout" | "pass-superseded";
  /** The stream whose baseline converged (step-converged only). */
  stream?: "tree" | "session";
  /** Canonical reason-set at the boundary (absent on step-converged). */
  reasons?: string[];
  /** Steps still PENDING at the boundary (absent/empty = none). */
  pending?: ("tree" | "session")[];
  /** Pass in-flight duration at the boundary (absent on pass-start). */
  elapsedMs?: number;
}

export type DiagEntry = ColdOpenEntry | StallEntry | StreamOpenEntry | StreamLifeEntry | ConnGradeEntry | CascadeDiagEntry;

// --- entryLine rendering ----------------------------------------------------
// One entry -> a single copy-friendly line. The label `conn` (not the persisted
// field name `open`) is intentional: `open` was misread as "total session-open
// time" when in fact it is pure transport (see ColdOpenEntry.open doc). The
// rendered line leads with `total` (= open + snap + hydrate for a cold open) so
// a future operator can read the user-perceived wait at a glance without
// mistaking the transport-only field for it.
//
// `switch (kind)` is the extension point: a new entry kind adds a case here.
// With a single union member TS knows the switch is exhaustive; adding a kind
// makes it non-exhaustive → compile error nudges the renderer to grow alongside
// the type (no runtime guard needed).
// Number.isFinite (not typeof === "number") so a malformed/non-finite timing
// value renders as `—` rather than `NaN` — defensive, since real captured
// entries always carry finite numbers but the formatter is pure and may be
// exercised with arbitrary inputs by future kinds/tests.
const fmtMs = (v: number | undefined): string => (Number.isFinite(v) ? `${v}` : "—");

const iso = (ts: number): string => {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
};

// Total user-perceived cold-open time = transport + snapshot transit + cold
// fetch. Defensive: if any leg is missing or non-finite (e.g. an older client
// that didn't stamp all three), `total` renders as "—" rather than a misleading
// partial sum. Warm sessions are never captured (the reactive trigger requires
// a finite hydrate), so hydrate is always a number on a real entry.
function coldOpenTotal(e: ColdOpenEntry): number | undefined {
  if (!Number.isFinite(e.open) || !Number.isFinite(e.snap) || !Number.isFinite(e.hydrate)) {
    return undefined;
  }
  return e.open! + e.snap! + e.hydrate!;
}

export function entryLine(e: DiagEntry): string {
  switch (e.kind) {
    case "cold-open":
      return `${iso(e.ts)} cold-open sess=${e.sessionId} total=${fmtMs(coldOpenTotal(e))} conn=${fmtMs(e.open)} snap=${fmtMs(e.snap)} hydrate=${fmtMs(e.hydrate)} fetch=${fmtMs(e.fetchMs)} recon=${fmtMs(e.reconcileMs)}`;
    case "stall": {
      const parts: string[] = [
        iso(e.ts),
        "stall",
        `trigger=${e.trigger}`,
        `stream=${e.stream}`,
      ];
      if (e.sessionId) parts.push(`sess=${e.sessionId}`);
      if (e.seqGap) parts.push(`gap[${e.seqGap.stream}]=${e.seqGap.expected}→${e.seqGap.got}(-${e.seqGap.missed})`);
      if (typeof e.treeLastSeenAge === "number") parts.push(`treeAge=${fmtMs(e.treeLastSeenAge)}`);
      if (typeof e.treeContentSeenAge === "number") parts.push(`treeContentAge=${fmtMs(e.treeContentSeenAge)}`);
      if (typeof e.sessionLastSeenAge === "number") parts.push(`sesAge=${fmtMs(e.sessionLastSeenAge)}`);
      if (typeof e.sessionContentSeenAge === "number") parts.push(`sesContentAge=${fmtMs(e.sessionContentSeenAge)}`);
      if (e.residentTail) {
        parts.push(
          `tail[${e.residentTail.sessionId}]:${e.residentTail.msgCount}msgs last=${e.residentTail.lastMsgRole ?? "?"}` +
            (e.residentTail.lastMsgCompleted ? "(done)" : "(no-done)"),
        );
      }
      if (e.gate) {
        const g: string[] = [];
        if (e.gate.busyActive) g.push("busy");
        if (e.gate.expectSessionSnap) g.push("expSes");
        if (e.gate.expectTreeSnap) g.push("expTree");
        if (e.gate.sesSnapshotDecoding) g.push("sesDec");
        if (e.gate.treeSnapshotDecoding) g.push("treeDec");
        if (g.length) parts.push(`gate=${g.join(",")}`);
      }
      if (e.eventSourceState) {
        parts.push(`es[t=${e.eventSourceState.tree},s=${e.eventSourceState.session}]`);
      }
      return parts.join(" ");
    }
    case "stream-open": {
      const parts: string[] = [
        iso(e.ts),
        "stream-open",
        `stream=${e.stream}`,
        `reason=${e.reason}`,
      ];
      if (e.detail) parts.push(`detail=${e.detail}`);
      parts.push(`gen=${e.generation}`, `cursor=${e.cursor}`, `had_cursor=${e.hadCursor}`);
      if (e.sessionId) parts.push(`sess=${e.sessionId}`);
      parts.push(`fb=${e.fallbackArmed ? 1 : 0}`, `pane=${e.pane}`, `proj=${e.project}`);
      if (e.openTs !== undefined) parts.push(`open@=${e.openTs}`);
      if (e.firstFrameTs !== undefined) parts.push(`frame@=${e.firstFrameTs}`);
      if (e.firstSnapshotTs !== undefined) parts.push(`snap@=${e.firstSnapshotTs}`);
      if (e.snapshotAppliedTs !== undefined) parts.push(`applied@=${e.snapshotAppliedTs}`);
      if (e.replayDoneTs !== undefined) parts.push(`replayDone@=${e.replayDoneTs}`);
      return parts.join(" ");
    }
    case "es-life":
      return `${iso(e.ts)} es-life stream=${e.stream} gen=${e.generation} ${e.phase} readyState=${e.readyState}${e.attempt !== undefined ? ` attempt=${e.attempt}` : ""}`;
    case "conn-grade":
      return `${iso(e.ts)} conn-grade ${e.from ?? "init"}→${e.to}${e.reasons.length ? ` reason=${e.reasons.join("+")}` : ""}`;
    case "cascade": {
      const parts: string[] = [iso(e.ts), "cascade", `event=${e.event}`];
      if (e.stream) parts.push(`stream=${e.stream}`);
      if (e.reasons?.length) parts.push(`reasons=${e.reasons.join("+")}`);
      if (e.pending?.length) parts.push(`pending=${e.pending.join("+")}`);
      if (e.elapsedMs !== undefined) parts.push(`elapsed=${fmtMs(e.elapsedMs)}`);
      return parts.join(" ");
    }
  }
}

// --- Persistence keys (project-scoped, versioned) --------------------------
const lsOn = (dir: string) => `vh.diaglog.on:${dir}`;
const lsEntries = (dir: string) => `vh.diaglog.entries:${dir}`;

/** Read the persisted enable flag for a project (default OFF). */
export function diagLogOn(dir: string): boolean {
  return loadVersioned<boolean>(lsOn(dir), 1, false, boolMigrate(false));
}

// Reactive mirror of the CURRENT project's enabled flag. Kept in sync with the
// persisted value (setDiagLogOn writes through) and rescoped on project switch.
const [enabled, setEnabledRaw] = createSignal<boolean>(diagLogOn(projectDir()));
/** Reactive: is the diagnostic log capturing for the current project? */
export function diagLogEnabled(): boolean {
  return enabled();
}
/** Toggle capture for the current project + persist. Default OFF. */
export function setDiagLogOn(v: boolean): void {
  const dir = projectDir();
  saveVersioned(lsOn(dir), 1, v);
  setEnabledRaw(v);
}

// Reactive mirror of the CURRENT project's entry buffer.
const [entries, setEntriesRaw] = createSignal<DiagEntry[]>(loadDiagEntries(projectDir()));
/** Reactive: the current project's (capped) diagnostic entries, newest last. */
export function diagEntries(): DiagEntry[] {
  return entries();
}

function loadDiagEntries(dir: string): DiagEntry[] {
  return loadVersioned<DiagEntry[]>(lsEntries(dir), 1, [], (old) => {
    if (!Array.isArray(old)) return [];
    return (old as unknown[]).filter(isDiagEntry) as DiagEntry[];
  });
}
// Runtime validator for migrated / foreign persisted payloads. StallEntry's
// sessionId is OPTIONAL, so a valid entry must have (ts:number + kind:string)
// and EITHER a string sessionId (cold-open) OR kind==="stall" OR one of the
// stream diag kinds (stream-open requires stream+reason; es-life requires
// stream+generation+phase). conn-grade requires to:string + an ARRAY reasons
// (required field; entryLine dereferences reasons.length unguarded); cascade
// requires event:string + reasons/pending absent-or-array (optional fields,
// but entryLine's ?.length is truthy on a non-empty string → .join throws).
function isDiagEntry(o: unknown): o is DiagEntry {
  if (!o || typeof o !== "object") return false;
  const obj = o as {
    ts?: unknown;
    kind?: unknown;
    sessionId?: unknown;
    stream?: unknown;
    reason?: unknown;
    generation?: unknown;
    phase?: unknown;
    to?: unknown;
    event?: unknown;
    reasons?: unknown;
    pending?: unknown;
  };
  if (typeof obj.ts !== "number") return false;
  if (typeof obj.kind !== "string") return false;
  if (obj.kind === "stall") return true; // sessionId optional on stall entries
  // (2026-10-29 hardening, triple-corroborated review advisory: the conn-grade
  // branch previously validated only `to` — a reasons-missing payload passed
  // validation and threw at the entryLine render.)
  if (obj.kind === "conn-grade") return typeof obj.to === "string" && Array.isArray(obj.reasons);
  if (obj.kind === "cascade")
    return (
      typeof obj.event === "string" &&
      (obj.reasons === undefined || Array.isArray(obj.reasons)) &&
      (obj.pending === undefined || Array.isArray(obj.pending))
    );
  if (obj.kind === "stream-open") {
    return obj.stream === "tree" || obj.stream === "session";
  }
  if (obj.kind === "es-life") {
    return (
      (obj.stream === "tree" || obj.stream === "session") &&
      typeof obj.generation === "number" &&
      (obj.phase === "onopen" || obj.phase === "onerror")
    );
  }
  return typeof obj.sessionId === "string"; // cold-open requires it
}

// Debounced persistence of the current project's buffer (mirrors store.persist).
let persistTimer: number | undefined;
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    saveVersioned(lsEntries(projectDir()), 1, entries());
  }, 250);
}

/**
 * Pure: apply BOTH caps to a list. max-time first (drop older than now−AGE),
 * then max-size (keep the newest MAX_DIAG_ENTRIES). Exported for unit tests so
 * the eviction logic is exercised independently of the reactive wiring.
 */
export function enforceCaps(list: DiagEntry[], now: number): DiagEntry[] {
  const minTs = now - MAX_DIAG_AGE_MS;
  let out = list.filter((e) => e.ts >= minTs);
  if (out.length > MAX_DIAG_ENTRIES) out = out.slice(out.length - MAX_DIAG_ENTRIES);
  return out;
}

/**
 * Capture one diagnostic entry. ZERO work when the facility is OFF for the
 * current project — returns before any allocation or buffer write. When ON:
 * append, enforce both caps, and schedule a debounced persist.
 */
export function captureDiagEntry(entry: DiagEntry): void {
  if (!enabled()) return; // default-off: no allocation, no writes
  setEntriesRaw(enforceCaps([...entries(), entry], entry.ts));
  schedulePersist();
}

/**
 * Re-schedule the debounced persist after mutating an ALREADY-captured entry
 * in place (the stream-open progress stamps complete seconds after their
 * construction record landed). No-op when capture is off. Cheap: one signal
 * read + a timer reschedule; safe to call from listener paths.
 */
export function touchDiagPersist(): void {
  if (!enabled()) return;
  schedulePersist();
}

// --- Bounded emitters for the capture-2 stamp kinds ---------------------------
// Thin, default-off-gated wrappers so the emitters in connstatus.ts /
// cascade.ts stay one-call sites. Each checks the enable flag BEFORE any
// object allocation (the "must not log too much" promise), and the entries
// then ride the same capped ring as every other kind.

/**
 * Capture one connstatus GRADE transition (connstatus.ts's transition
 * observer is the sole caller). Skips a vacuous from===to call defensively
 * (the caller already diffs, but the helper must be safe on its own).
 */
export function noteConnGradeTransition(from: string | null, to: string, reasons: string[]): void {
  if (from === to) return;
  if (!enabled()) return;
  captureDiagEntry({ kind: "conn-grade", ts: Date.now(), from, to, reasons });
}

/**
 * Capture one cascade pass-lifecycle boundary (cascade.ts is the sole
 * caller): pass started / a step's baseline converged / pass converged /
 * the pass timeout fired / pass superseded. Bounded: pass-lifecycle edges
 * only, never per-tick.
 */
export function noteCascadeBoundary(
  event: CascadeDiagEntry["event"],
  info: Omit<CascadeDiagEntry, "kind" | "ts" | "event"> = {},
): void {
  if (!enabled()) return;
  captureDiagEntry({ kind: "cascade", ts: Date.now(), event, ...info });
}

// Internal: re-point both mirrors at a (possibly new) project dir.
function rescope(dir: string): void {
  setEnabledRaw(diagLogOn(dir));
  setEntriesRaw(loadDiagEntries(dir));
}

// Dedup: only capture each (session, cold-open) once. The hydrate watcher can
// fire on unrelated reactive ticks; keying on sessionId + the hydrate number
// means a re-tick with the same value is a no-op while a genuinely new cold
// open (same or different session, different timing) still captures.
let lastKey: string | undefined;

/**
 * Wire reactive capture. Call ONCE from App.onMount (app root).
 *  - rescopes the mirrors + dedup key when the active project changes;
 *  - on a cold-open completion (session.hydrate becomes a finite number),
 *    captures a ColdOpenEntry built from the live connLatency.session + the
 *    selected session id + a wall-clock timestamp.
 */
let started = false;
export function startDiagCapture(): void {
  if (started) return;
  started = true;
  createEffect(
    on(projectDir, (dir) => {
      lastKey = undefined;
      rescope(dir);
    }),
  );
  createEffect(
    on(
      () => state.connLatency.session.hydrate,
      (h) => {
        // Cold-open completion = hydrate is a finite number. "warm" (string)
        // and undefined are not cold completions.
        if (typeof h !== "number") return;
        const sid = selectedId();
        if (!sid) return;
        const key = sid + ":" + h;
        if (key === lastKey) return; // already captured this cold open
        lastKey = key;
        const s = state.connLatency.session;
        captureDiagEntry({
          kind: "cold-open",
          ts: Date.now(),
          sessionId: sid,
          open: s.open,
          snap: s.snap,
          hydrate: h,
          fetchMs: s.fetchMs,
          reconcileMs: s.reconcileMs,
        });
      },
    ),
  );
}

// Test-only: reset the mirrors from storage so isolated unit tests start clean.
// Not wired into any production path.
export function _resetDiagForTest(): void {
  lastKey = undefined;
  rescope(projectDir());
}
