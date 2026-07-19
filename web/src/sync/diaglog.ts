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
export type DiagEntry = ColdOpenEntry;

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
// Runtime validator for migrated / foreign persisted payloads.
function isDiagEntry(o: unknown): o is DiagEntry {
  return (
    !!o &&
    typeof o === "object" &&
    typeof (o as { ts?: unknown }).ts === "number" &&
    typeof (o as { sessionId?: unknown }).sessionId === "string" &&
    typeof (o as { kind?: unknown }).kind === "string"
  );
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
