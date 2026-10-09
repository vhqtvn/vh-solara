// Outbox controller — the FE-side durability + reconciliation layer for send
// gestures (send-net-resilience slice 3).
//
// CONTRACT (BLK-A3, debate-3 — BINDING prerequisite of this slice):
//   - The UI may show a locally-"saved" state ONLY after the IDB transaction
//     commits — saveGesture resolves `{ok:true}` strictly after the store's
//     transaction completed.
//   - On storage-unavailable/quota/eviction/cleared-IDB failure the gesture is
//     BLOCKED before admission with a persistent "not saved — copy your text"
//     state and the compose text retained in memory — never a silent loss.
//     `storageFailure()` carries the retained payload for that surface.
//
// CAPTURE SEMANTICS (debate-4 finding 7, as amended 2026-10-09 — see
// tmp/agent-runs/send-design/design.md):
//   - At successful local save the gesture captures the immutable target
//     session + the current context-head (transcript tail). The captured head
//     is compared at RESUME (reconcile re-admission — a changed head surfaces
//     a VISIBLE stale-context row and NEVER auto-sends) and at REPLACEMENT
//     (the chip's two-tap inline confirmation + the controller's TOCTOU
//     re-verify) — not inside the live tap→save→admit window (hydration
//     catch-up there is innocent, not drift). A replacement send is a NEW
//     gesture: it captures a fresh head at tap.
//
// INTENT IDENTITY:
//   - `intentId` is minted once per explicit send gesture (the same value as
//     the send-action attemptId — the daemon dedupes admission by VALUE across
//     the attemptId/intentId wire aliases). An explicit retry of the same
//     gesture reuses it; a NEW send (including an ambiguous replacement) mints
//     a fresh one. Two tabs can never double-send one gesture: each tab's
//     in-module single-flight per intentId guards only ITS OWN re-admissions
//     (per-tab, not cross-tab), so the daemon's intentId admission dedupe is
//     the cross-tab backstop (a racing replay returns the ORIGINAL receipt
//     and creates no second item).
//
// RECONCILE (boot/session-open/focus): records are reconciled against the
// authoritative queue list by intentId (either alias):
//   saved   + item present           → admission confirmed after all → admitted
//   saved   + absent + head unchanged→ re-admit the SAME gesture (same
//                                      intentId; dedupe-safe by construction)
//   saved   + absent + head changed  → NEVER auto-send; surface a visible
//                                      stale-context row (the operator decides)
//   saved   + reAdmitHold            → NEVER auto-send (no usable captured
//                                      head — the stale gate cannot run;
//                                      c-F2 fail-closed) — visible row
//   admitted + item sent             → delivered → prune
//   admitted + item absent (list     → server queue archived/dismissed → prune
//     AUTHORITATIVELY empty — [])      — a null list (fetch failed) is a
//     NO-ANSWER: absence is NOT established, the record is retained + skipped
//     and the next pass retries (null-vs-empty tighten, 2026-10-10)
//   any record older than GC_MS      → prune (bounded store)
import { createSignal } from "solid-js";
import type { QueuedMessage } from "../../queue";
import { ensureSendActionRecord, finishSendAttempt } from "../sendActionStatus";
import {
  createIdbOutboxStore,
  type OutboxContextHead,
  type OutboxGestureRecord,
  type OutboxPayload,
  type OutboxSaveResult,
  type OutboxStore,
} from "./store";

export type { OutboxContextHead, OutboxGestureRecord, OutboxPayload, OutboxSaveResult };
export { createIdbOutboxStore, createMemoryOutboxStore } from "./store";

/** Blocking storage-failure surface state (BLK-A3). `payload` is the retained
 *  in-memory gesture text — the "copy your text" affordance's source.
 *  `capturedHead` is the TAP-TIME head the gesture captured (c-F2): it must
 *  survive into the retry's record so the stale gate still runs — a head
 *  re-captured at retry time would whitelist a conversation that moved on
 *  during the storage failure. `null` means the head was unknowable at tap
 *  (the retry's record is then marked reAdmitHold — never fail-open). */
export interface OutboxStorageFailure {
  sessionId: string;
  intentId: string;
  payload: OutboxPayload;
  capturedHead: OutboxContextHead | null;
  reason: string;
}

/** Inputs for one gesture save. `intentId` is the caller-minted gesture id
 *  (send-reliability's attemptId under its canonical name). */
export interface SaveGestureInput {
  intentId: string;
  sessionId: string;
  payload: OutboxPayload;
  capturedHead: OutboxContextHead | null;
}

// --- module singleton ---------------------------------------------------------

let store: OutboxStore = createIdbOutboxStore();

// Reactive overlay map: intentId → replacement intentId. Hydrated from the
// durable store at boot and updated on requestReplacement, so chips reconcile
// the "Replacement requested" state across reloads/tab-kills.
const [replacementOverlays, setReplacementOverlays] = createSignal<ReadonlyMap<string, string>>(
  new Map(),
);

// BLK-A3 blocking state (null when storage is healthy).
const [storageFailure, setStorageFailure] = createSignal<OutboxStorageFailure | null>(null);

// Cleared/evicted-IDB detection: a localStorage marker written after every
// successful save-while-records-exist. If the marker is set but the durable
// store reads empty at hydrate, storage was cleared/evicted underneath us —
// surfaced honestly (the texts are unrecoverable; the operator must know).
const LS_OUTBOX_PENDING = "vh.outbox.pending.v1";
const [evictionSuspected, setEvictionSuspected] = createSignal(false);

// --- page (tab) identity — R-F2 cross-tab supersede scoping -------------------
// A stable id for THIS TAB: per-tab (never deliberately shared across tabs)
// AND stable across RELOADS within the tab (b-F2 round 1: minting per module
// evaluation made the id reload-unstable — after a reload the operator's
// fresh same-text re-send could NOT supersede-prune the pre-reload saved
// record; both then aged past the 60s guard, reconcile sorted oldest-first
// and admitted the STALE record while the R-F3 twin prune deleted the FRESH
// gesture: an oldest-wins inversion of same-tab newest-wins). sessionStorage
// has exactly both required properties; NOT localStorage — it is shared
// across ALL tabs (it would reintroduce the cross-tab mutual-prune interleave
// R-F2 closed). Records are stamped with the id at saveGesture/retryFailedSave
// and supersede scans match only SAME-clientId records: tab B's scan must
// never prune tab A's just-committed durable record.
//
// b-F1/b-F2 round 2 — the platform COPY exception + the uncontested-claim
// gate: sessionStorage is per-tab EXCEPT that the platform COPIES it into
// opener-created tabs (window.open / target=_blank) and duplicated tabs — a
// clone then evaluates under the SAME clientId, so the clientId gate alone
// cannot tell "my own record" from "another live tab's". The clone's
// supersede scan matched the ORIGINAL tab's just-saved same-text record as
// own-tab and DELETED it — a cross-tab prune of a live tab's durable record
// (the exact BLK-A3-class void R-F2 exists to prevent). Neutralized in two
// layers:
//   1. bootNonce (a per-PAGE-EVALUATION random stamped on every save/retry,
//      re-minted each module evaluation): same clientId + SAME nonce =
//      written by THIS page-eval → definitely ours → prune directly (the
//      common same-typing case, zero latency, no channel). Same clientId +
//      DIFFERENT/absent nonce = written by an EARLIER eval of this id — my
//      dead former self (the reload shape) OR a live clone sibling; NOT
//      locally distinguishable.
//   2. uncontendedClaim() (the cross-eval gate): a one-per-eval
//      BroadcastChannel('vh-solara-outbox') handshake — post
//      {type:'who-has', id}, collect objections ({type:'mine', id}) for
//      ~120ms. No objection → uncontested (the reload shape: the predecessor
//      is my dead former self) → the prune proceeds. ANY objection → a live
//      tab holds this id → SKIP the prune: the records coexist and the
//      DESIGNED cross-tab stance owns them (reconcile's oldest-wins belt +
//      pass-local same-text suppression, the R-F3 twin prune, and the
//      daemon's intentId-VALUE admission dedupe — which does NOT collapse
//      same-text records under distinct intentIds). No BroadcastChannel
//      available (old browser, exotic embedding, jsdom without a stub) →
//      the same conservative SKIP, never an error — degradation is to the
//      SAFE direction.
// RESIDUAL CORNER (replaces c-F1's scope, stated honestly): a predecessor
// tab FROZEN by the platform (tab freeze — typically after ≥~5min hidden; no
// JS runs, so it cannot answer 'mine') + a clone of it + a same-text gesture
// + a cross-eval prune issued during the freeze window → the handshake sees
// no objection and the frozen tab's record is pruned. No local signal exists
// for frozen-tab liveness. Harm stays bounded by the same-text belt (at most
// ONE re-admission per text per reconcile pass) and the daemon's
// intentId-value admission dedupe — the same backstops that own every
// cross-tab duplicate.
const SS_OUTBOX_CLIENT = "vh-solara-outbox-client";

function mintRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the fallback below */
  }
  // crypto.randomUUID is secure-context-only (plain-http LAN origins do not
  // expose it): time + two random stretches is collision-safe for tab identity.
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Resolve THIS tab's identity: adopt the sessionStorage-stored id (a reload
 *  within this tab re-derives the SAME id), else mint once and store it (the
 *  tab's first page lifetime). sessionStorage unavailable (storage disabled /
 *  exotic embeddings): a per-call mint — reload-unstable, but still
 *  per-tab-unique and NEVER cross-tab shared (degrades to the pre-b-F2
 *  behavior, never worse). */
function resolvePageClientId(): string {
  try {
    const stored = sessionStorage.getItem(SS_OUTBOX_CLIENT);
    if (stored) return stored;
    const minted = mintRandomId();
    sessionStorage.setItem(SS_OUTBOX_CLIENT, minted);
    return minted;
  } catch {
    return mintRandomId();
  }
}
let pageClientId = resolvePageClientId();

// The page-EVALUATION nonce (b-F1/b-F2 round 2): re-minted every module
// evaluation — the deliberately reload-UNSTABLE half of the record identity
// (the clientId above is the reload-stable half). See the identity block.
const bootNonce = mintRandomId();

// --- cross-eval claim channel (b-F1/b-F2 round 2: the uncontested-claim gate) --
// ONE BroadcastChannel per page evaluation, opened eagerly at module init:
// the OBJECTION side of the handshake only works if every live tab is already
// listening when a sibling posts its 'who-has' query — a channel opened only
// for the query window would miss every idle sibling and make the
// "uncontested" verdict a fiction. The channel carries no gesture data, only
// id-liveness probes. It is a structural-subset interface so unit tests
// inject a deterministic stub (the node test environment must not depend on
// the platform API).

/** The channel surface the claim handshake needs (a structural subset of
 *  BroadcastChannel). */
export interface OutboxClaimChannel {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  /** Node only: an open channel must not pin the event loop (test exit). */
  unref?(): void;
}

/** Factory seam: returns the channel to claim on, or null when unavailable. */
export type OutboxClaimChannelFactory = () => OutboxClaimChannel | null;

const CLAIM_CHANNEL_NAME = "vh-solara-outbox";
const CLAIM_WAIT_MS = 120;

function defaultClaimChannelFactory(): OutboxClaimChannel | null {
  try {
    const C = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    if (typeof C !== "function") return null; // no BroadcastChannel — conservative-skip path
    const ch = new (C as new (name: string) => OutboxClaimChannel)(CLAIM_CHANNEL_NAME);
    ch.unref?.(); // Node: an open channel must not keep the process alive
    return ch;
  } catch {
    return null;
  }
}

let claimChannelFactory: OutboxClaimChannelFactory = defaultClaimChannelFactory;
let claimChannel: OutboxClaimChannel | null = null;
// The handshake VERDICT, memoized once per page evaluation: the set of live
// sibling tabs does not observably change within one eval, so every
// cross-eval prune in the eval reuses the first verdict (a second query
// would only re-ask the same tabs the same question).
let claimMemo: Promise<boolean> | null = null;

/** (Re)open the per-eval channel + install the ANSWER listener: when another
 *  live tab asks who else evaluates under THIS page's id (a clone sibling
 *  gating its own cross-eval prune), answer 'mine' for as long as this page
 *  evaluates — its same-id records are not predecessor relics while we run. */
function openClaimChannel(): void {
  if (claimChannel) {
    try {
      claimChannel.close();
    } catch {
      /* best-effort */
    }
    claimChannel = null;
  }
  let ch: OutboxClaimChannel | null = null;
  try {
    ch = claimChannelFactory();
  } catch {
    ch = null;
  }
  if (!ch) return;
  claimChannel = ch;
  try {
    ch.addEventListener("message", (ev) => {
      const d = ev.data;
      if (
        d &&
        typeof d === "object" &&
        (d as { type?: unknown }).type === "who-has" &&
        (d as { id?: unknown }).id === pageClientId
      ) {
        try {
          claimChannel?.postMessage({ type: "mine", id: pageClientId });
        } catch {
          /* best-effort */
        }
      }
    });
  } catch {
    // A channel that cannot listen cannot object — claims stay conservative.
  }
}

/** The cross-eval prune gate (b-F1/b-F2 round 2): true only when no live
 *  sibling tab objected to this page's id claim within CLAIM_WAIT_MS. Never
 *  throws, never rejects; anything unexpected resolves false (the
 *  conservative-skip direction). */
function uncontendedClaim(): Promise<boolean> {
  if (!claimMemo) {
    claimMemo = (async (): Promise<boolean> => {
      const ch = claimChannel;
      if (!ch) return false; // no channel — conservative SKIP, never an error
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (uncontested: boolean) => {
          if (settled) return;
          settled = true;
          try {
            ch.removeEventListener("message", onObjection);
          } catch {
            /* best-effort */
          }
          resolve(uncontested);
        };
        const onObjection = (ev: { data: unknown }) => {
          const d = ev.data;
          if (
            d &&
            typeof d === "object" &&
            (d as { type?: unknown }).type === "mine" &&
            (d as { id?: unknown }).id === pageClientId
          ) {
            finish(false);
          }
        };
        try {
          ch.addEventListener("message", onObjection);
          ch.postMessage({ type: "who-has", id: pageClientId });
        } catch {
          finish(false); // channel broke mid-handshake — conservative skip
          return;
        }
        setTimeout(() => finish(true), CLAIM_WAIT_MS);
      });
    })().catch(() => false);
  }
  return claimMemo;
}

openClaimChannel();

export { storageFailure, evictionSuspected };

/** Test-only: swap the store (memory/failing fakes) + reset all module state.
 *  The page identity is RE-DERIVED from sessionStorage — a reset models a
 *  module re-evaluation over the tab's storage state, so tests choose the
 *  shape they simulate: SEED the sessionStorage id before resetting to model
 *  the SAME TAB across a reload (the identity is adopted); CLEAR it (key
 *  absent) to model a DIFFERENT TAB — a fresh mint is stored, exactly what a
 *  new tab's first page lifetime does (per-tab storage starts empty). */
export function __resetOutboxForTests(fake?: OutboxStore): void {
  store = fake ?? createIdbOutboxStore();
  pageClientId = resolvePageClientId();
  claimMemo = null; // a fresh page evaluation: the claim verdict re-derives
  openClaimChannel(); // re-open under the (possibly new) identity + factory
  setReplacementOverlays(new Map());
  setStorageFailure(null);
  setEvictionSuspected(false);
  try {
    localStorage.removeItem(LS_OUTBOX_PENDING);
  } catch {
    /* jsdom-less environments */
  }
}

/** Test-only: the current page (tab) clientId — lets tests assert record
 *  stamping / model a second tab's writes against a shared store. */
export function __outboxClientIdForTests(): string {
  return pageClientId;
}

/** Test-only: the current page EVALUATION's bootNonce — lets tests assert
 *  record stamping / model this eval's own vs an earlier eval's writes. */
export function __outboxBootNonceForTests(): string {
  return bootNonce;
}

/** Test-only: inject the claim-channel factory (a deterministic stub), pass
 *  `() => null` to model an environment with NO BroadcastChannel, or pass
 *  null to restore the production default. Re-opens the channel and clears
 *  the memoized verdict so the next cross-eval prune re-queries under the
 *  new factory. */
export function __setOutboxClaimChannelForTests(factory: OutboxClaimChannelFactory | null): void {
  claimChannelFactory = factory ?? defaultClaimChannelFactory;
  claimMemo = null;
  openClaimChannel();
}

function readPendingMarker(): number {
  try {
    return Number(localStorage.getItem(LS_OUTBOX_PENDING)) || 0;
  } catch {
    return 0;
  }
}

function writePendingMarker(n: number): void {
  try {
    if (n > 0) localStorage.setItem(LS_OUTBOX_PENDING, String(n));
    else localStorage.removeItem(LS_OUTBOX_PENDING);
  } catch {
    /* marker is best-effort diagnostics, never a correctness gate */
  }
}

/** Hydrate overlays + eviction detection from the durable store. Called once
 *  at module init (page boot) and safe to re-run (tests). */
export async function hydrateOutbox(): Promise<void> {
  const all = await store.all();
  const map = new Map<string, string>();
  for (const r of all) {
    if (r.replacedBy) map.set(r.intentId, r.replacedBy);
  }
  setReplacementOverlays(map);
  const marker = readPendingMarker();
  setEvictionSuspected(marker > 0 && all.length === 0 && !storageFailure());
  if (all.length === 0 && marker > 0 && !storageFailure()) writePendingMarker(0);
}

void hydrateOutbox();

async function persistPendingMarker(): Promise<void> {
  writePendingMarker((await store.all()).length);
}

// --- gesture lifecycle --------------------------------------------------------

/** SUPERSEDE PRUNE (double-send guard), R-F2 tab-scoped (2026-10-10) +
 *  PUT-CONFIRM-THEN-PRUNE (B-F1) + b-F1/b-F2 round 2 cross-eval gate. Callers
 *  run this ONLY after the replacement record COMMITTED — deleting before
 *  the put would destroy the prior durable gesture exactly when the put then
 *  fails (quota/storage-unavailable — the failure mode this slice exists
 *  for), leaving NEITHER gesture durable. Match: SAME session + status
 *  `saved` + SAME text + DIFFERENT intentId + SAME clientId (this tab's own
 *  obsolete unsent gesture — the deliberate re-typed-duplicate case the scan
 *  exists for). WITHIN the same-clientId matches, the bootNonce splits the
 *  prune decision (round 2 — the platform COPIES sessionStorage into
 *  opener-created/duplicated tabs, so a clone runs under the SAME clientId
 *  and the id alone cannot prove ownership):
 *    same clientId + SAME bootNonce → THIS page-eval's record — prune
 *      directly (zero latency, no channel: the common same-typing case).
 *    same clientId + DIFFERENT/absent nonce → an EARLIER eval of this id —
 *      my dead former self (reload) OR a live clone sibling, not locally
 *      distinguishable — prune ONLY after uncontendedClaim() reports no live
 *      sibling objection. ANY objection / no channel / handshake surprise →
 *      SKIP (safe direction): the records coexist and the designed
 *      backstops own them (see the identity block, including the documented
 *      frozen-predecessor residual corner).
 *  A record written by a genuinely DIFFERENT tab (different clientId) is
 *  NEVER pruned here: two tabs saving the same text could otherwise each
 *  prune the other's just-committed record in a narrow interleave, leaving a
 *  gesture with NO durable recovery record while its UI said "saved" (a
 *  BLK-A3 void). Records WITHOUT a clientId (pre-upgrade) are foreign —
 *  never pruned (migration-safe, errs toward retention). Cross-tab same-text
 *  duplicates are the designed backstops' job: reconcile's pass-local
 *  same-text suppression + the daemon's intentId-VALUE admission dedupe.
 *  Records already `admitted` are never touched (server custody), and a
 *  different text is a different gesture. The match is TEXT-ONLY by design:
 *  attachments/config may diverge between the two gestures — a bounded edge
 *  (the superseded gesture was an unsent re-send whose text the operator
 *  just re-sent; tightening the match would let a divergent-attachment prior
 *  escape the guard and double-send). A crash between put and prune leaves
 *  both same-tab records — the daemon dedupes admission by intentId VALUE
 *  and does NOT collapse the distinct ids (two same-text records under
 *  different ids would be TWO admissions); reconcile's same-text suppression
 *  keeps that residual to exactly ONE admission. */
async function pruneSupersededOwnTab(sessionId: string, intentId: string, text: string): Promise<void> {
  for (const r of await store.all()) {
    if (
      r.sessionId === sessionId &&
      r.status === "saved" &&
      r.intentId !== intentId &&
      r.payload.text === text &&
      r.clientId === pageClientId
    ) {
      // b-F1/b-F2 round 2: same clientId alone no longer proves ownership —
      // a cross-eval writer (different/absent nonce) is pruned only when the
      // uncontested-claim gate says no live sibling holds this id. Skip is
      // the SAFE direction (retention + designed backstops), never an error.
      if (r.bootNonce !== bootNonce && !(await uncontendedClaim())) continue;
      await store.delete(r.intentId);
    }
  }
}

/** Persist one gesture. The ONLY place a "locally saved" claim may originate:
 *  `{ok:true}` resolves strictly after the store transaction committed. On
 *  failure the blocking state is armed (storageFailure) with the retained
 *  payload — the caller must abort the send and keep the composer text. */
export async function saveGesture(input: SaveGestureInput): Promise<OutboxSaveResult> {
  const existing = await store.get(input.intentId);
  const rec: OutboxGestureRecord = {
    intentId: input.intentId,
    sessionId: input.sessionId,
    createdAt: existing?.createdAt ?? Date.now(),
    payload: input.payload,
    capturedHead: input.capturedHead,
    status: existing?.status ?? "saved",
    queueItemId: existing?.queueItemId,
    replacedBy: existing?.replacedBy,
    replacedAt: existing?.replacedAt,
    // R-F2: the writing tab owns the record for supersede purposes (a re-save
    // of an existing gesture adopts it into THIS tab's scan scope).
    // b-F1/b-F2 round 2: the page-EVALUATION nonce — id + nonce together
    // identify THIS evaluation as the writer (see the identity block).
    clientId: pageClientId,
    bootNonce,
  };
  const res = await store.put(rec);
  if (!res.ok) {
    // B-F1: NOTHING was mutated before this point — a failed put must find
    // the prior durable records intact (pruning superseded gestures only
    // after the replacement commits, below).
    setStorageFailure({
      sessionId: input.sessionId,
      intentId: input.intentId,
      payload: input.payload,
      capturedHead: input.capturedHead, // c-F2: the retry re-commits THIS head
      reason: res.reason,
    });
    return res;
  }
  // SUPERSEDE (own-tab double-send guard): an older still-`saved` record for
  // the SAME session + SAME text under a DIFFERENT intentId is this tab's
  // obsolete unsent gesture — the operator's fresh re-send of that text
  // replaces it (put-confirm-then-prune + R-F2 tab scoping: see
  // pruneSupersededOwnTab).
  if (!existing) {
    await pruneSupersededOwnTab(input.sessionId, input.intentId, input.payload.text);
  }
  // A successful save clears the blocking state for THIS gesture (storage
  // recovered — e.g. the operator's retry after freeing quota).
  setStorageFailure((cur) => (cur && cur.intentId === input.intentId ? null : cur));
  void persistPendingMarker();
  return res;
}

/** Re-attempt the failed save from the blocking banner ("Try saving again").
 *  Resolves true when the save now committed (the banner may clear). This
 *  path only persists the record — it never enqueues: sending resumes via
 *  the operator's re-tap OR the reconcile re-admission, which for a
 *  re-committed record is STALE-GATED (only past READMIT_MIN_AGE_MS and only
 *  while the captured head is unchanged — not "never"). c-F2 (review): the
 *  record is re-committed with the TAP-TIME head captured on the failure —
 *  NOT a fresh capture (re-capturing at retry time would whitelist a
 *  conversation that moved on during the storage failure, restoring the
 *  stale gate only in name). When no usable tap-time head exists the record
 *  is marked `reAdmitHold` instead: the stale gate can never run for it, so
 *  reconcile must NEVER auto re-admit what the banner promised would wait
 *  for an explicit re-tap (fail-closed, never fail-open). */
export async function retryFailedSave(): Promise<boolean> {
  const f = storageFailure();
  if (!f) return false;
  const res = await store.put({
    intentId: f.intentId,
    sessionId: f.sessionId,
    createdAt: Date.now(),
    payload: f.payload,
    capturedHead: f.capturedHead,
    ...(f.capturedHead ? {} : { reAdmitHold: true }),
    clientId: pageClientId, // R-F2: the retry writes THIS tab's record
    bootNonce, // round 2: stamped by THIS page evaluation
    status: "saved",
  });
  if (res.ok) {
    // SUPERSEDE PRUNE (b-F1 round 3 — duplicate re-admission guard): mirror
    // saveGesture's put-confirm-then-prune exactly (own-tab scope, R-F2). The
    // failed save could not run its supersede prune (nothing had committed),
    // so the retry's commit is where this tab's older same-text `saved`
    // record is finally pruned. WITHOUT this the store DETERMINISTICALLY
    // keeps two same-text saved records, and reconcile — whose saved-record
    // loop passes both through the age/head gates (neither has a matching
    // queue item) — would re-admit BOTH: the daemon dedupes admission by
    // intentId VALUE, so distinct ids are two admissions = a duplicate send.
    // Another tab's record is NOT matched (R-F2) — the cross-tab backstops
    // (reconcile same-text suppression + daemon value dedupe) own those.
    await pruneSupersededOwnTab(f.sessionId, f.intentId, f.payload.text);
    setStorageFailure(null);
    void persistPendingMarker();
  }
  return res.ok;
}

/** Admission confirmed (2xx receipt): link the queue item and keep the record
 *  for reconcile + overlays until pruned. Stamps `admittedAt` (R-F3) — the
 *  time basis reconcile uses to prune crash-separated pre-admission
 *  same-text twins. Best-effort — a failed link write must never fail the
 *  send (the server owns custody now). */
export async function markAdmitted(intentId: string, queueItemId: string): Promise<void> {
  const rec = await store.get(intentId);
  if (!rec) return;
  await store.put({ ...rec, status: "admitted", queueItemId, admittedAt: Date.now() });
  void persistPendingMarker();
}

/** Drop a gesture record whose admission was DEFINITIVELY refused or whose
 *  gesture was terminally blocked (stale context): nothing may re-admit it
 *  later — the visible row/composer own the retained text. */
export async function dropGesture(intentId: string): Promise<void> {
  await store.delete(intentId);
  void persistPendingMarker();
}

/** The captured context-head for a gesture (null when unknown/absent). */
export async function capturedHeadFor(intentId: string): Promise<OutboxContextHead | null> {
  return (await store.get(intentId))?.capturedHead ?? null;
}

/** True when `head` differs from the gesture's captured head — the
 *  stale-context predicate. Unknown heads (either side null) never fabricate
 *  staleness (fail-open: an unknowable head cannot prove drift). */
export function headIsStale(
  captured: OutboxContextHead | null,
  current: OutboxContextHead | null,
): boolean {
  if (!captured || !current) return false;
  if (captured.sessionId !== current.sessionId) return true;
  if (captured.count !== current.count) return true;
  return captured.lastMessageId !== current.lastMessageId;
}

// --- ambiguous replacement overlay -------------------------------------------

/** Record that the operator requested a replacement send off this gesture's
 *  ambiguous chip (debate-4 B1). The queue item stays server-side
 *  unknown+ambiguousDelivery; this FE-owned marker is what the chip renders. */
export async function requestReplacement(intentId: string, replacementIntentId: string): Promise<void> {
  const rec = await store.get(intentId);
  if (rec) {
    await store.put({ ...rec, replacedBy: replacementIntentId, replacedAt: Date.now() });
  }
  setReplacementOverlays((m) => new Map(m).set(intentId, replacementIntentId));
}

/** Reactive read for chip rendering: the replacement intentId when a
 *  replacement was requested for this gesture, else undefined. */
export function replacementRequestedFor(intentId: string | undefined): string | undefined {
  if (!intentId) return undefined;
  return replacementOverlays().get(intentId);
}

// --- reconcile ----------------------------------------------------------------

/** Deps injected by the wiring layer (ChatView) so this module owns no fetch. */
export interface ReconcileDeps {
  fetchList: (sessionId: string) => Promise<QueuedMessage[] | null>;
  enqueue: (sessionId: string, input: OutboxPayload & { intentId: string }) => Promise<QueuedMessage>;
  currentHead: (sessionId: string) => OutboxContextHead | null;
}

/** A saved record younger than this is NEVER re-admitted by reconcile — its
 *  own gesture may still be mid-admission in this or another tab (the enqueue
 *  bound is 12s; 60s is safely past every wait in the admission funnel). The
 *  daemon's intentId dedupe makes even a race harmless; this guard keeps
 *  reconcile from competing with a live gesture at all. */
export const READMIT_MIN_AGE_MS = 60_000;

/** Records older than this are pruned unconditionally (bounded store; a
 *  record that survived a week without converging has no remaining local
 *  meaning — the server queue is the authority). */
export const OUTBOX_GC_MS = 7 * 24 * 60 * 60_000;

// Per-tab in-module single-flight per intentId (b-F4 correction: each tab's
// module instance guards only its OWN re-admissions — this is NOT a cross-tab
// guard; the daemon's intentId admission dedupe is the cross-tab backstop).
const reAdmitting = new Set<string>();

function itemMatchesGesture(item: QueuedMessage, rec: OutboxGestureRecord): boolean {
  if (rec.queueItemId && item.id === rec.queueItemId) return true;
  return item.intentId === rec.intentId || item.attemptId === rec.intentId;
}

/** Surface a non-sendable gesture as a visible SendStatus row (the operator
 *  decides; nothing auto-sends). Used for stale-context holds and definitive
 *  re-admission rejections (a generic rejection passes reason undefined and
 *  renders the row's generic fallback copy). */
function surfaceBlockedGesture(
  rec: OutboxGestureRecord,
  reason: "stale-context" | "queue-full" | undefined,
  detail: string,
): void {
  ensureSendActionRecord(rec.intentId, rec.sessionId, {
    stage: "blocked",
    certainty: "definitive",
    recovery: "restore",
    reason,
    detail,
    payload: {
      tapText: rec.payload.text,
      text: rec.payload.text,
      attachments: rec.payload.attachments,
      sendConfig: rec.payload.sendConfig,
    },
  });
}

/** Reconcile one session's outbox records against the authoritative queue
 *  list (boot / session-open / focus). Never throws. */
export async function reconcileOutboxSession(sessionId: string, deps: ReconcileDeps): Promise<void> {
  let records: OutboxGestureRecord[];
  try {
    records = (await store.all()).filter((r) => r.sessionId === sessionId);
  } catch {
    return; // store unreadable — nothing honest to reconcile from
  }
  if (records.length === 0) return;
  // b-F1 belt (duplicate re-admission guard): deterministic pass order —
  // oldest createdAt first, so among same-text saved twins the OLDEST
  // gesture wins the pass's single re-admission.
  records.sort((a, b) => a.createdAt - b.createdAt);
  // R-F3 (time-scoped twin prune): the LATEST admission time per text among
  // this session's ADMITTED records (pre-loop snapshot — an admission
  // confirmed mid-pass does not retroactively affect this pass; the in-pass
  // duplicate is the reAdmitTexts belt's job). Existence semantics: a saved
  // same-text record older than ANY admission of that text is a pre-admission
  // residual twin. Records without admittedAt (legacy) contribute nothing —
  // the time gate cannot run for them (current behavior retained).
  const admittedAtByText = new Map<string, number>();
  for (const r of records) {
    if (r.status === "admitted" && typeof r.admittedAt === "number") {
      admittedAtByText.set(r.payload.text, Math.max(r.admittedAt, admittedAtByText.get(r.payload.text) ?? 0));
    }
  }
  const now = Date.now();
  const list = await deps.fetchList(sessionId);
  // b-F1 belt: texts that already reached a re-admission attempt in THIS
  // pass — a later same-text saved record is the obsolete twin.
  const reAdmitTexts = new Set<string>();
  for (const rec of records) {
    if (now - rec.createdAt > OUTBOX_GC_MS) {
      await store.delete(rec.intentId);
      continue;
    }
    const item = list?.find((it) => itemMatchesGesture(it, rec));
    if (rec.status === "admitted") {
      // Null-vs-empty tighten (2026-10-10): list===null is a NO-ANSWER (fetch
      // failed), never an authoritative empty — absence is NOT established,
      // so the record is retained + skipped and the next pass retries. Prune
      // runs only when the list was AUTHORITATIVELY empty ([] — the server
      // answered and the item is absent) or the item is delivered.
      if (list !== null && (!item || item.state === "sent")) {
        // Delivered, or the server queue ended (archive/explicit dismissal):
        // server custody is over — prune. Any unknown/failed item keeps its
        // record only for the replacement overlay (below).
        if (!item || !rec.replacedBy) await store.delete(rec.intentId);
      }
      continue;
    }
    // status === "saved": the crash-window class the outbox exists for.
    if (item) {
      // Admission had landed after all (e.g. the response was lost): confirm
      // custody; no second admission is sent.
      await markAdmitted(rec.intentId, item.id);
      continue;
    }
    if (now - rec.createdAt < READMIT_MIN_AGE_MS) continue; // own gesture may be live
    // R-F3 (time-scoped twin prune, AFTER the age guard — a young record's
    // own gesture may still be mid-admission in another tab; only a record
    // that aged past the guard AND predates a completed admission of the
    // same text is provably a residual): a crash-separated twin of an
    // ADMITTED gesture — created before that admission's admittedAt stamped
    // by markAdmitted, still `saved` here. The daemon does NOT collapse
    // distinct intentIds (it dedupes admission by intentId VALUE — two ids
    // are two admissions = a duplicate send), so prune the twin instead of
    // re-admitting it. Slice 3 deliberately did NOT naively register admitted
    // text into reAdmitTexts: the TIME gate is what keeps a fresh DELIBERATE
    // same-text re-send (createdAt NEWER than admittedAt) out of this prune.
    // Residual window (accepted): a twin whose re-admission is already IN
    // FLIGHT in an overlapping pass when the admission lands is beyond a
    // pass-local map — the snapshot is pre-loop by design.
    const twinAdmittedAt = admittedAtByText.get(rec.payload.text);
    if (twinAdmittedAt !== undefined && rec.createdAt < twinAdmittedAt) {
      await store.delete(rec.intentId);
      continue;
    }
    if (rec.reAdmitHold) {
      // c-F2 (fail-closed): the record was committed WITHOUT a usable
      // captured head (retryFailedSave after a tap with an unknowable head),
      // so the stale gate can never run for it — NEVER auto re-admit what
      // the banner promised would wait for an explicit re-tap. Visible row;
      // the operator's re-tap (a fresh same-text gesture supersedes this
      // record) owns the recovery.
      surfaceBlockedGesture(
        rec,
        undefined,
        "saved without a context snapshot — review and send it again",
      );
      continue;
    }
    const head = rec.capturedHead;
    const current = deps.currentHead(sessionId);
    if (headIsStale(head, current)) {
      // NEVER auto-send onto a moved-on conversation: visible row, keep the
      // record (a later reconcile after the operator acts re-evaluates; the
      // row itself is the confirmation surface).
      surfaceBlockedGesture(
        rec,
        "stale-context",
        "the conversation moved on while this message was waiting",
      );
      continue;
    }
    // b-F1 belt (crash-window residual): two same-text `saved` records under
    // DIFFERENT intentIds (a put-confirm-then-prune crash — a window the
    // retryFailedSave prune cannot reach) BOTH arrive here: neither has a
    // matching queue item and both pass the age/head gates. The daemon does
    // NOT collapse them (it dedupes admission by intentId VALUE — distinct
    // ids are two admissions = a duplicate send). Suppress: at most ONE
    // re-admission attempt per text per pass; the twin is PRUNED, mirroring
    // saveGesture's supersede semantics (a pure skip would let a LATER pass
    // re-admit the twin once the winner flips to admitted).
    if (reAdmitTexts.has(rec.payload.text)) {
      await store.delete(rec.intentId);
      continue;
    }
    if (reAdmitting.has(rec.intentId)) {
      // A-F1: this record's re-admission is IN FLIGHT in a concurrent pass —
      // createQueueSync registers ONE handler on BOTH window focus AND
      // document visibilitychange, each firing an unserialized `void`
      // reconcile, so an ordinary refocus runs two OVERLAPPING passes.
      // Register its text into THIS pass's set: without this the overlapping
      // pass skips the in-flight record without claiming its text and admits
      // a same-text sibling under a distinct intentId — the daemon dedupes
      // admission by intentId VALUE, so distinct ids are two admissions = a
      // duplicate send.
      reAdmitTexts.add(rec.payload.text);
      continue;
    }
    reAdmitting.add(rec.intentId);
    reAdmitTexts.add(rec.payload.text);
    try {
      // Same-gesture re-admission: identical payload under the SAME intentId.
      // The daemon dedupes by value — a tab that raced us gets the same
      // receipt, never a second item.
      const admitted = await deps.enqueue(sessionId, {
        text: rec.payload.text,
        attachments: rec.payload.attachments,
        sendConfig: rec.payload.sendConfig,
        intentId: rec.intentId,
      });
      await markAdmitted(rec.intentId, admitted.id);
      // The re-admission completed the original gesture: any retained row for
      // it is finished (server custody owns display now).
      finishSendAttempt(rec.intentId);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "queue_admission_full") {
        surfaceBlockedGesture(rec, "queue-full", String(e));
      } else       if (code && code !== "timeout" && code !== "network" && code !== "ambiguous") {
        // A definitive HTTP rejection (conflict/unknown status): the gesture
        // is dead server-side — surface + drop so nothing re-admits it.
        surfaceBlockedGesture(rec, undefined, String(e));
        await store.delete(rec.intentId);
      }
      // timeout/network/ambiguous: outcome unknown — KEEP the record; the next
      // reconcile re-evaluates against the authoritative list (which may show
      // the item admitted after all).
    } finally {
      reAdmitting.delete(rec.intentId);
    }
  }
  void persistPendingMarker();
}

/** True when the queue-drain projection mode must hold for this page: the
 *  daemon advertised dispatch custody (daemonDispatchCapable) or explicitly
 *  refused a claim/resolve (409 queue_custody_active). Owned by
 *  lib/queueDispatchMode; re-exported for the wiring layer's convenience. */
export { projectionActive } from "../queueDispatchMode";
