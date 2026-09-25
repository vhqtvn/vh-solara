// Create-certainty Slice 2 — the SPA client lifecycle for the
// /vh/session/create protocol (pkg/web/session_create.go, frozen in Slice 1).
//
// This module owns everything the modern create flow needs BEYOND the plain
// legacy POST /oc/session (which stays in sync/actions.ts, unchanged):
//
//   1. Capability feature-detect with an explicit UNCERTAINTY LADDER
//      (detectCreateSupport): a recognized v1 body ⇒ modern; a 404/405 or a
//      recognizable same-origin SPA-shell HTML fallback ⇒ legacy; EVERYTHING
//      else — 401/403, auth/login redirects, malformed JSON, wrong protocol
//      or version, 502, network failure, timeout — is UNCERTAIN, and an
//      uncertain capability check means NO create POST may be sent at all
//      (the caller reports a retry-safe "capability check unavailable"
//      failure; it must NEVER be mislabeled session-created-unknown).
//
//   2. Create-operation identity: ONE high-entropy idempotency key per
//      project directory + draft generation (create-certainty brief §3.2) —
//      distinct from the enqueue attempt identity (mintSendAttempt). The key
//      is minted before the first execute POST, stable across re-taps of the
//      SAME logical create operation, and a re-tap of an UNCERTAIN operation
//      reuses the key via RECEIPT LOOKUP ONLY — never a re-POST (after the
//      idemCache's 10-minute TTL a same-key POST WILL re-execute; that pinned
//      asymmetry is why recovery is GET-only). The project dir is captured at
//      mint time and stamped on every later recovery lookup, so navigation or
//      a project switch can never resolve a receipt under the wrong directory.
//
//   3. Bounded receipt recovery: after an unknown/in-flight outcome, at most
//      THREE non-overlapping receipt GETs with 3s individual bounds inside a
//      12s overall window (schedule pinned: attempt 1 immediately, then 4s
//      backoff — last attempt ends ≤11s). Exhaustion releases the UI guard
//      and retains the recoverable state; an explicit "Check again" gets a
//      FRESH bounded budget, never a fresh execute. An operator re-tap
//      COALESCES with the active budget — it piggybacks on the in-flight
//      lookup (or adds nothing while the budget is between lookups); it
//      NEVER issues a parallel GET outside a budget (review T1B-F1). No
//      infinite polling; the budget continues across ChatView unmount
//      (module-level state).
//
//   4. Certainty upgrade without operator confirmation: a valid fresh-or-
//      replay receipt (state created, non-empty validated id) resolves the
//      operation, re-keys its draft-owned send-status records onto the exact
//      session id (operation-scoped — unrelated drafts/operations untouched,
//      finished records never resurrected), and marks the operation's
//      uncertain records resolved. Recovery alone never sends a message and
//      never hijacks navigation; the draft view surfaces the resolved session
//      through an operator-driven "Open it".
//
//   5. The failure envelope (brief §3.5): proven pre-upstream rejection
//      (400) or identity conflict (409 idempotency_conflict) is DEFINITIVE —
//      a corrected attempt mints a NEW key; timeout / network / 502 /
//      malformed-body / 202-unknown / 409 in_flight are UNKNOWN — the key is
//      retained and recovery is lookup-only; a receipt miss (404) is an
//      honest unavailable, NEVER a reason to re-POST. An explicit
//      "Start a new session anyway" (duplicate-risk acknowledged in the UI)
//      abandons the operation and lets the next send mint a fresh key.
//
// In-memory only (module singletons, like sendActionStatus): a reload loses
// the keys, matching the brief's honest idemCache tradeoff — this is NOT a
// durable browser outbox and NOT exactly-once creation across restart/expiry.
import { createStore, produce, unwrap } from "solid-js/store";
import {
  markCreateOpRecordsResolved,
  markOwnerSessionCreateUnknown,
  stampDraftPreparingCreateOp,
  transferCreateOpRecords,
} from "./sendActionStatus";
import { projectDir } from "../sync/store";

// ── Capability feature-detect ───────────────────────────────────────────────

/** The capability verdict. "uncertain" is NOT a verdict to act on: it means
 *  the check could not prove either way, so NO create POST may be sent. */
export type CreateSupport = "modern" | "legacy" | "uncertain";

/** 5s bound for the capability read INCLUDING the body read (brief §3.4). */
export const CAPABILITY_TIMEOUT_MS = 5000;

/** The SPA/host shell signature used to recognize the same-origin HTML
 *  fallback (unknown /vh/… paths serve the shell — pkg/web/server.go's
 *  serveAppIndex/serveHostIndex). Both shells' titles start "VHSolara"
 *  ("<title>VHSolara</title>" and "<title>VHSolara · Host</title>"). ARBITRARY
 *  html is NOT shell evidence — only our own shell counts as route-
 *  unsupported. */
export const APP_SHELL_TITLE_MARK = "<title>VHSolara";

export function isAppShellHtml(body: string): boolean {
  return body.includes(APP_SHELL_TITLE_MARK);
}

// Cached verdict per worker origin for the page lifetime (uncertain is
// deliberately NOT cached — the next attempt re-probes).
let supportVerdict: "modern" | "legacy" | undefined;
let supportProbe: Promise<CreateSupport> | undefined;

async function probeCreateSupport(): Promise<CreateSupport> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CAPABILITY_TIMEOUT_MS);
  try {
    const res = await fetch("/vh/session/create/capabilities", { signal: ctrl.signal });
    // Route-unsupported: explicit 404/405 is the server SAYING the route does
    // not exist (nothing was or would be executed).
    if (res.status === 404 || res.status === 405) return "legacy";
    if (res.status === 200) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        // Same-origin SPA-shell HTML fallback for an unknown /vh path — our
        // pinned compatibility branch (the shell has no API routes). Read the
        // body INSIDE the armed window; arbitrary HTML stays uncertain.
        const body = await res.text();
        if (ctrl.signal.aborted) return "uncertain";
        return isAppShellHtml(body) ? "legacy" : "uncertain";
      }
      let j: unknown;
      try {
        j = await res.json();
      } catch {
        return "uncertain"; // malformed JSON
      }
      if (ctrl.signal.aborted) return "uncertain";
      const caps = j as { protocol?: unknown; version?: unknown; recovery_only?: unknown };
      if (caps.protocol === "vh-session-create" && caps.version === 1 && caps.recovery_only === true) {
        return "modern";
      }
      return "uncertain"; // wrong protocol/body — not unsupported evidence either
    }
    // 401/403 (auth), 502 (proxy transport), 5xx, anything else: NOT proof the
    // route is unsupported — uncertain, no POST.
    return "uncertain";
  } catch {
    // Network failure or timeout: uncertain, no POST.
    return "uncertain";
  } finally {
    clearTimeout(timer);
  }
}

/** Non-mutating capability read, cached per page lifetime for definitive
 *  verdicts; concurrent callers share one probe; "uncertain" re-probes. */
export function detectCreateSupport(): Promise<CreateSupport> {
  if (supportVerdict) return Promise.resolve(supportVerdict);
  if (!supportProbe) {
    supportProbe = probeCreateSupport().then((v) => {
      if (v !== "uncertain") supportVerdict = v;
      return v;
    }).finally(() => {
      supportProbe = undefined;
    });
  }
  return supportProbe;
}

// ── Create-operation registry ───────────────────────────────────────────────

export type CreateOpState = "sending" | "unknown" | "linked" | "rejected" | "abandoned";

/** Reactive view of one create operation (SendStatus binds this). */
export interface CreateOp {
  id: string;
  key: string;
  dir: string;
  state: CreateOpState;
  sessionId?: string;
  sentAt?: number;
  /** A recovery lookup is currently in flight (the "Checking session
   *  creation." UI state). */
  recoveryActive: boolean;
  /** Bounded-budget bookkeeping: lookups used by the CURRENT budget run. */
  recoveryLookups: number;
  lastDetail?: string;
}

interface CreateOpInternal extends CreateOp {
  // epoch guards the async recovery loop against a module reset between
  // awaits (tests); production never bumps it.
  epoch: number;
}

const [ops, setOps] = createStore<Record<string, CreateOpInternal>>({});
const [currentOp, setCurrentOp] = createStore<Record<string, string | undefined>>({});
let createEpoch = 0;
let opSeq = 0;

/** Mint a high-entropy unguessable idempotency key (crypto.randomUUID when
 *  available; the fallback concatenates random sweeps — never a counter or
 *  timestamp alone, which would be guessable). */
function mintCreateKey(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let rnd = "";
  for (let i = 0; i < 4; i++) rnd += Math.random().toString(16).slice(2);
  return `sc-${rnd}`;
}

function mintCreateOp(dir: string): CreateOpInternal {
  const op: CreateOpInternal = {
    id: `create-op-${++opSeq}-${Math.random().toString(36).slice(2, 8)}`,
    key: mintCreateKey(),
    dir,
    state: "sending",
    recoveryActive: false,
    recoveryLookups: 0,
    epoch: createEpoch,
  };
  setOps(op.id, op);
  setCurrentOp(dir, op.id);
  return op;
}

/** A new explicitly independent draft generation (actions.newSession): the
 *  previous current operation — whatever its state — stops being the draft's
 *  create operation. It stays in history (its records keep their honest
 *  unresolved presentation); a fresh send mints a fresh key. */
export function beginDraftGeneration(dir: string): void {
  if (!dir) return;
  setCurrentOp(produce((map) => { delete map[dir]; }));
}

function opById(id: string): CreateOpInternal | undefined {
  return ops[id];
}

/** Reactive read for the UI (bind inside a Solid computation). */
export function getCreateOp(id: string | undefined): CreateOp | undefined {
  if (!id) return undefined;
  return ops[id];
}

/** Is `id` the CURRENT create operation for its directory (the one the
 *  modern affordances — Check again / Start a new session anyway — may act
 *  on)? Old-generation or abandoned operations keep their honest copy but
 *  get no fresh affordances. */
export function isCurrentCreateOp(id: string): boolean {
  const op = opById(id);
  return !!op && currentOp[op.dir] === id;
}

/** The current draft-generation's LINKED operation (the draft view's
 *  "Session was created — open it" row). Reads the CURRENT project dir. */
export function draftResolvedCreateOp(): { sessionId: string; opId: string } | undefined {
  const dir = projectDir();
  if (!dir) return undefined;
  const id = currentOp[dir];
  if (!id) return undefined;
  const op = ops[id];
  if (op && op.state === "linked" && op.sessionId) return { sessionId: op.sessionId, opId: id };
  return undefined;
}

/** For createSend's draft→live ownership step: the operation-scoped record
 *  set to re-key onto `sessionId` when the modern flow produced this id —
 *  null means "not a modern resolution" (legacy: the caller runs the broad
 *  draft sweep instead). */
export function modernCreateTransferTarget(sessionId: string): string | null {
  for (const raw of Object.values(unwrap(currentOp))) {
    if (!raw) continue;
    const op = unwrap(ops)[raw];
    if (op && op.state === "linked" && op.sessionId === sessionId) return raw;
  }
  return null;
}

// ── Receipt lookup + bounded recovery ───────────────────────────────────────

export const CREATE_EXECUTE_BOUND_MS = 12_000;
export const RECOVERY_LOOKUP_BOUND_MS = 3_000;
export const RECOVERY_MAX_LOOKUPS = 3;
export const RECOVERY_BACKOFF_MS = 4_000;
/** The overall recovery window: with the pinned 0/4/8s schedule and 3s
 *  individual bounds the last lookup ends ≤11s — inside the 12s budget. */
export const RECOVERY_WINDOW_MS = 12_000;

type ReceiptOutcome =
  | { kind: "created"; sessionId: string }
  | { kind: "rejected"; detail: string }
  | { kind: "unresolved"; detail: string };

/** One bounded receipt GET (recovery-ONLY: the route never executes; a miss
 *  is an honest unavailable). NEVER a create. */
async function lookupReceipt(op: CreateOpInternal): Promise<ReceiptOutcome> {
  const url =
    `/vh/session/create/receipt?key=${encodeURIComponent(op.key)}` +
    (op.dir ? `&dir=${encodeURIComponent(op.dir)}` : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RECOVERY_LOOKUP_BOUND_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      return { kind: "unresolved", detail: `receipt ${res.status} (unreadable body)` };
    }
    if (ctrl.signal.aborted) return { kind: "unresolved", detail: "receipt body stalled" };
    const r = j as { protocol?: unknown; version?: unknown; state?: unknown; sessionID?: unknown; code?: unknown; error?: unknown };
    // Only act on OUR protocol at OUR version — a foreign body is an anomaly,
    // never permission to act elsewhere.
    if (r.protocol !== "vh-session-create" || r.version !== 1) {
      return { kind: "unresolved", detail: "receipt protocol/version anomaly" };
    }
    if (r.state === "created" && typeof r.sessionID === "string" && r.sessionID) {
      return { kind: "created", sessionId: r.sessionID };
    }
    if (r.state === "rejected") {
      return { kind: "rejected", detail: `receipt rejected${r.code ? ` (${r.code})` : ""}` };
    }
    // unknown (202), in_flight (409), unavailable (404 miss) — all honest
    // not-yet-resolved answers. A MISS NEVER RE-CREATES.
    return { kind: "unresolved", detail: `receipt state ${String(r.state)}` };
  } catch {
    return { kind: "unresolved", detail: "receipt lookup failed (network/timeout)" };
  } finally {
    clearTimeout(timer);
  }
}

// Re-tap coalescing (review T1B-F1): ONE receipt GET per operation at a
// time. The budget loop issues its lookups through this registry, and an
// operator re-tap that lands while a budget run is active piggybacks on the
// SAME in-flight promise instead of issuing a parallel GET outside the
// declared ≤3-non-overlapping-3s-in-12s budget. Repeated re-taps add ZERO
// GETs; the entry self-deregisters when the GET settles.
const inflightLookups = new Map<string, Promise<ReceiptOutcome>>();

/** Issue (or join) the single in-flight receipt lookup for `op`. The budget
 *  loop is the only issuer; concurrent awaiters share the promise. */
function sharedLookupReceipt(op: CreateOpInternal): Promise<ReceiptOutcome> {
  const existing = inflightLookups.get(op.id);
  if (existing) return existing;
  const p = lookupReceipt(op).finally(() => {
    if (inflightLookups.get(op.id) === p) inflightLookups.delete(op.id);
  });
  inflightLookups.set(op.id, p);
  return p;
}

function patchOp(id: string, p: Partial<CreateOpInternal>): void {
  setOps(
    produce((map) => {
      const cur = map[id];
      if (!cur) return;
      Object.assign(cur, p);
    }),
  );
}

/** Resolve an operation from a valid receipt (fresh or replayed): exact
 *  binding, records patched + transferred (operation-scoped), uncertainty
 *  removed. Pointer STAYS on the linked op so the still-open draft view can
 *  render the resolved row and a re-tap can continue in the known session —
 *  a later newSession() (new draft generation) clears it. */
function resolveCreateOp(opId: string, sessionId: string): void {
  const op = opById(opId);
  if (!op || op.state === "linked") return;
  patchOp(opId, { state: "linked", sessionId, recoveryActive: false });
  markCreateOpRecordsResolved(opId, sessionId);
  transferCreateOpRecords(opId, sessionId);
}

/** Reject an operation proven to never have reached upstream (cached
 *  rejection receipt): definitive, and a corrected attempt mints a NEW key
 *  (pointer cleared). */
function rejectCreateOp(opId: string, detail: string): void {
  patchOp(opId, { state: "rejected", lastDetail: detail, recoveryActive: false });
  const op = opById(opId);
  if (op && currentOp[op.dir] === opId) setCurrentOp(produce((map) => { delete map[op.dir]; }));
}

/** The bounded recovery runner: ≤ RECOVERY_MAX_LOOKUPS non-overlapping
 *  lookups (0/4/8s schedule, 3s bounds — all inside the 12s window). Stops
 *  early the moment the operation resolves/rejects/abandons elsewhere. Safe
 *  to fire-and-forget; never sends anything. Its lookups go through the
 *  shared in-flight registry so a concurrent re-tap piggybacks instead of
 *  issuing a parallel GET (review T1B-F1). */
async function runLookupBudget(opId: string): Promise<void> {
  const startEpoch = createEpoch;
  const op0 = opById(opId);
  if (!op0 || op0.recoveryActive) return; // one budget run at a time
  patchOp(opId, { recoveryActive: true, recoveryLookups: 0 });
  try {
    for (let attempt = 1; attempt <= RECOVERY_MAX_LOOKUPS; attempt++) {
      const cur = opById(opId);
      if (!cur || createEpoch !== startEpoch) return;
      if (cur.state !== "unknown" && cur.state !== "sending") return; // resolved/abandoned elsewhere
      if (attempt > 1) {
        await new Promise<void>((r) => setTimeout(r, RECOVERY_BACKOFF_MS));
        const after = opById(opId);
        if (!after || createEpoch !== startEpoch) return;
        if (after.state !== "unknown" && after.state !== "sending") return;
      }
      patchOp(opId, { recoveryLookups: attempt });
      const res = await sharedLookupReceipt(cur as CreateOpInternal);
      if (createEpoch !== startEpoch) return;
      if (res.kind === "created") {
        resolveCreateOp(opId, res.sessionId);
        return;
      }
      if (res.kind === "rejected") {
        rejectCreateOp(opId, res.detail);
        return;
      }
      patchOp(opId, { lastDetail: res.detail });
    }
    // Budget exhausted: the operation stays honestly unknown; UI guards
    // release (recoveryActive flips in finally) and the state is retained.
  } finally {
    patchOp(opId, { recoveryActive: false });
  }
}

/** Explicit "Check again": a FRESH bounded lookup budget — never a fresh
 *  execute. No-op unless the operation is still unresolved+idle. */
export function checkCreateOpAgain(opId: string): void {
  const op = opById(opId);
  if (!op || op.state !== "unknown" || op.recoveryActive) return;
  void runLookupBudget(opId);
}

/** Explicit "Start a new session anyway" — the duplicate-risk-acknowledged
 *  abandon (SendStatus renders the acknowledgement). Preserves the operation
 *  as unresolved metadata; the next send mints a fresh key. */
export function abandonCreateOp(opId: string): void {
  const op = opById(opId);
  if (!op) return;
  patchOp(opId, { state: "abandoned", recoveryActive: false });
  if (currentOp[op.dir] === opId) setCurrentOp(produce((map) => { delete map[op.dir]; }));
}

// ── The modern create flow (createSessionWithCertainty's modern branch) ─────

export interface SessionCreateOutcome {
  id: string | null;
  certainty: "definitive" | "unknown";
  detail?: string;
  /** True when NO create POST was sent because the capability check was
   *  uncertain — a retry-safe failure that must never be presented as
   *  session-created-unknown. */
  capabilityUnavailable?: boolean;
  startedAt: number;
}

interface WireReceipt {
  state?: unknown;
  sessionID?: unknown;
  code?: unknown;
  error?: unknown;
  protocol?: unknown;
  version?: unknown;
  replayed?: unknown;
}

function decodeWireReceipt(j: unknown): WireReceipt | null {
  if (!j || typeof j !== "object") return null;
  return j as WireReceipt;
}

function wireValid(w: WireReceipt | null): boolean {
  return !!w && w.protocol === "vh-session-create" && w.version === 1;
}

/** The modern create lifecycle. MUST only run after detectCreateSupport()
 *  answered "modern" (the safety ladder: capability uncertainty means no
 *  POST). Re-taps of an unresolved operation reuse the key via LOOKUP ONLY. */
export async function modernCreateSession(startedAt: number): Promise<SessionCreateOutcome> {
  const dir = projectDir();
  let op = dir ? opById(currentOp[dir] ?? "") : undefined;
  if (op && (op.state === "rejected" || op.state === "abandoned")) op = undefined; // fresh key for a corrected attempt

  // Re-tap of a LINKED operation: continue in the known session (a separate
  // explicit send interaction may use it — brief §3.3). Never re-POST.
  if (op && op.state === "linked" && op.sessionId) {
    stampDraftPreparingCreateOp("draft", op.id);
    transferCreateOpRecords(op.id, op.sessionId);
    return { id: op.sessionId, certainty: "definitive", startedAt };
  }

  if (op && (op.state === "sending" || op.state === "unknown")) {
    // UNCERTAIN RE-TAP: receipt lookup only — NEVER a re-POST (a same-key
    // POST after cache expiry re-executes; recovery is GET-only). The
    // lookup COALESCES with the bounded recovery budget (review T1B-F1): a
    // re-tap never issues a parallel GET outside the ≤3-non-overlapping
    // budget. While a budget run is active it piggybacks on the in-flight
    // lookup (or, between lookups, adds nothing — the running budget
    // answers); when none is running the re-tap STARTS the fresh bounded
    // budget and awaits that run's first lookup.
    stampDraftPreparingCreateOp("draft", op.id);
    let res: ReceiptOutcome | undefined;
    if (op.recoveryActive) {
      const inflight = inflightLookups.get(op.id);
      if (inflight) res = await inflight; // piggyback — zero new GETs
    } else {
      // runLookupBudget registers attempt 1's in-flight lookup
      // synchronously before its first suspension, so this read always sees
      // the promise it started (undefined only if the budget could not
      // start — state changed under us — handled as unresolved below).
      void runLookupBudget(op.id);
      res = await inflightLookups.get(op.id);
    }
    // The budget acts on the same lookup synchronously before this
    // continuation runs — prefer the store's settled truth over re-acting
    // on `res` (avoids double-resolving or rejecting an already-settled op).
    const cur = opById(op.id);
    if (cur && cur.state === "linked" && cur.sessionId) {
      return { id: cur.sessionId, certainty: "definitive", startedAt };
    }
    if (cur && cur.state === "rejected") {
      return { id: null, certainty: "definitive", detail: `session create was rejected (${cur.lastDetail ?? "unknown"})`, startedAt };
    }
    if (res && res.kind === "created") {
      resolveCreateOp(op.id, res.sessionId);
      return { id: res.sessionId, certainty: "definitive", startedAt };
    }
    if (res && res.kind === "rejected") {
      rejectCreateOp(op.id, res.detail);
      return { id: null, certainty: "definitive", detail: `session create was rejected (${res.detail})`, startedAt };
    }
    // Still unresolved (or between budget lookups): honestly unknown. Mark
    // through the MODULE-level uncertain mark WITH the op id (review
    // T1D-F1, mirroring markUnknownAndRecover) so the re-tap's fresh
    // preparing record KEEPS its createOpId — ChatView.ensureSession's
    // legacy-shaped mark (no createOpId argument) follows this return and
    // its bare Object.assign patch would otherwise overwrite the stamp
    // with undefined; because this mark runs first, the record is already
    // uncertain and the legacy mark's preparing-only filter skips it.
    const detail = res && res.kind === "unresolved" ? res.detail : (op.lastDetail ?? "session create outcome unknown");
    markOwnerSessionCreateUnknown("draft", detail, startedAt, op.id);
    void runLookupBudget(op.id); // no-op while a budget is still running
    return { id: null, certainty: "unknown", detail, startedAt };
  }

  // Fresh operation: mint, persist may-have-been-sent BEFORE awaiting fetch,
  // then the one bounded execute POST.
  const fresh = mintCreateOp(dir);
  stampDraftPreparingCreateOp("draft", fresh.id);
  patchOp(fresh.id, { sentAt: Date.now() });
  const url = "/vh/session/create" + (dir ? `?dir=${encodeURIComponent(dir)}` : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CREATE_EXECUTE_BOUND_MS);
  const startedPost = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: fresh.key }),
      signal: ctrl.signal,
    });
    let w: WireReceipt | null = null;
    try {
      w = decodeWireReceipt(await res.json());
    } catch {
      w = null;
    }
    if (ctrl.signal.aborted) {
      // Body stalled past the bound: the POST may have been applied.
      markUnknownAndRecover(fresh.id, startedPost, "session create response stalled");
      return { id: null, certainty: "unknown", detail: "session create response stalled", startedAt };
    }
    if (!wireValid(w)) {
      // A 2xx/other answer we cannot validate is a protocol anomaly — the
      // outcome is UNKNOWN (a mutating response with no valid marker is
      // never permission to act elsewhere).
      const st = (w && typeof (w as any).state === "string") ? ` state=${(w as any).state}` : "";
      markUnknownAndRecover(fresh.id, startedPost, `session create protocol anomaly (HTTP ${res.status}${st})`);
      return { id: null, certainty: "unknown", detail: `session create protocol anomaly (HTTP ${res.status}${st})`, startedAt };
    }
    const wr = w!;
    if (wr.state === "created" && typeof wr.sessionID === "string" && wr.sessionID) {
      // Fresh or replayed receipt (replayed false|true) — both are a valid
      // exact binding; the replayed flag is informational here.
      resolveCreateOp(fresh.id, wr.sessionID);
      return { id: wr.sessionID, certainty: "definitive", startedAt };
    }
    if (wr.state === "rejected" && res.status === 400 && wr.code !== "idempotency_conflict") {
      // Proven BEFORE upstream (validation): nothing was created; a corrected
      // attempt mints a NEW key.
      rejectCreateOp(fresh.id, `create rejected: ${wr.error || wr.code || "validation"}`);
      return { id: null, certainty: "definitive", detail: `create rejected: ${wr.error || wr.code || "validation"}`, startedAt };
    }
    if (wr.state === "rejected" && wr.code === "idempotency_conflict") {
      // Identity conflict — also proven-without-execution (forward-safety).
      rejectCreateOp(fresh.id, "idempotency_key bound to a different create payload");
      return { id: null, certainty: "definitive", detail: "idempotency_key bound to a different create payload", startedAt };
    }
    if (wr.state === "in_flight") {
      // 409 in_flight: the key is claimed and the server-owned create is
      // still running (our earlier POST, client-abandoned, lives on). Bounded
      // lookup/backoff, retain the key — never a second POST.
      markUnknownAndRecover(fresh.id, startedPost, "create still in flight (receipt lookup follows)");
      return { id: null, certainty: "unknown", detail: "create still in flight (receipt lookup follows)", startedAt };
    }
    if (wr.state === "unknown") {
      markUnknownAndRecover(fresh.id, startedPost, `create outcome uncertain${wr.error ? `: ${wr.error}` : ""}`);
      return { id: null, certainty: "unknown", detail: `create outcome uncertain${wr.error ? `: ${wr.error}` : ""}`, startedAt };
    }
    if (res.status === 404) {
      // The route vanished after a modern capability verdict — nothing
      // executed (a 404 answers before any upstream call); retry-safe.
      patchOp(fresh.id, { state: "rejected", lastDetail: "create route unavailable after capability check" });
      if (currentOp[dir] === fresh.id) setCurrentOp(produce((map) => { delete map[dir]; }));
      return { id: null, certainty: "definitive", detail: "create route unavailable after capability check", startedAt };
    }
    // Any other envelope shape: unknown, never a license to fall back.
    markUnknownAndRecover(fresh.id, startedPost, `unexpected create receipt (HTTP ${res.status} state ${String(wr.state)})`);
    return { id: null, certainty: "unknown", detail: `unexpected create receipt (HTTP ${res.status} state ${String(wr.state)})`, startedAt };
  } catch (e) {
    // Network error OR 12s abort — the POST may have been applied. Unknown.
    const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    const detail = aborted ? "session create timed out" : `session create request failed (${String(e)})`;
    markUnknownAndRecover(fresh.id, startedPost, detail);
    return { id: null, certainty: "unknown", detail, startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function markUnknownAndRecover(opId: string, startedAt: number, detail: string): void {
  patchOp(opId, { state: "unknown", lastDetail: detail });
  // The create-attempt window [POST-armed, now] feeds the legacy-style timing
  // candidates (the manual fallback retained for modern ambiguity — hidden
  // again the moment an exact receipt resolves this operation).
  markOwnerSessionCreateUnknown("draft", detail, startedAt, opId);
  void runLookupBudget(opId);
}

/** Test-only: drop every operation, the pointer table, the support cache,
 *  and invalidate in-flight recovery loops (epoch bump). */
export function __resetSessionCreateForTests(): void {
  createEpoch++;
  supportVerdict = undefined;
  supportProbe = undefined;
  setOps(produce((map) => { for (const k of Object.keys(map)) delete map[k]; }));
  setCurrentOp(produce((map) => { for (const k of Object.keys(map)) delete map[k]; }));
}

/** Test-only: seed an operation (default state unknown, current for `dir`)
 *  for UI-level tests that bind SendStatus to module state without driving
 *  the network flow. Returns the op id. */
export function __seedCreateOpForTests(dir: string, over: Partial<CreateOp> = {}): string {
  const op: CreateOpInternal = {
    id: over.id ?? `create-op-seed-${++opSeq}`,
    key: over.key ?? mintCreateKey(),
    dir,
    state: "unknown",
    recoveryActive: false,
    recoveryLookups: 0,
    epoch: createEpoch,
    ...over,
  };
  setOps(op.id, op);
  setCurrentOp(dir, op.id);
  return op.id;
}
