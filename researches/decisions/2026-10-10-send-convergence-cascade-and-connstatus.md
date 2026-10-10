# Send convergence cascade + graded ConnStatus — binding decision record

Date: 2026-10-10. Promoted from the send-net-resilience design record
(`tmp/agent-runs/send-design/{design.md,debate-3.md,debate-4.md}` — gitignored
history) per the 2026-10-10 research packet
(`tmp/agent-runs/send-design/research-packet-cascade.md` §Q8) and the
coordinator's recorded adjudications. This file promotes ONLY the binding
subset — the cascade/ConnStatus contracts and their DRIFT CORRECTIONS — not
the whole program record (send-path policy is binding via landed code +
headers; the tmp record stays history).

Amendment authority: where the design text and the 2026-10-10 tree disagree,
THIS record's corrections win (they were adjudicated against the verified
tree state). Code citations reference the slice-A landing
(`web/src/sync/cascade.ts` and the feeding sites).

---

## 1. Convergence cascade (AMEND-A5, as amended + LANDED)

### 1.1 The pass contract

ONE coalesced, supersession-aware recovery pass per eval
(`web/src/sync/cascade.ts`), fed by the EXISTING recovery-reason codes
(`web/src/sync/recovery-reasons.ts` closed vocabulary, extend-only) and the
server's SSE `cause:"reconnect"` field.

- **Generation key** `(epoch, acceptedCursor, canonicalized reason-set)` —
  captured at pass start; the reason-set is canonicalized by sorted dedup
  (debate-4 #8). The key is the pass's IDENTITY (dedup + observability), not
  an ordering oracle.
- **Exactly one in-flight pass.** A request arriving mid-pass COALESCES: its
  reason unions into the running pass's set. Its recovery action (the
  `direct` closure that travels WITH the request — the cascade holds no
  static transport imports) is SUBSUMED when the pass is already awaiting
  that stream's baseline, and still RUNS when the request covers a stream the
  pass is not awaiting (coalescing dedupes DUPLICATE work, never drops a
  distinct stream's recovery). N overlapping triggers within one window ⇒
  exactly ONE cascade executes.
- **Supersession rules** (which reason-sets supersede):
  - **S1 — epoch change mid-pass**: the running pass's pending outputs belong
    to a dead store lifetime; supersede WITHOUT inheriting its steps.
  - **S2 — proven loss after convergence**: a loss-class reason
    (`tree-seq-gap`, `seq-gap`, `offset-mismatch`, `tail-incomplete`,
    `tree-overlap-capture`, `epoch-reset`) whose implied steps are ALL
    converged-or-unawaited in the running pass cannot be absorbed ⇒
    supersede WITH inheritance of the old pass's pending steps.
  - Everything else (watchdog stales, sentinel timeouts, drift resyncs,
    ring-gap / stream-live signals) coalesces.
- **Generation check before EVERY commit**: the queue-reconcile trigger and
  completion bookkeeping compare the pass generation against the live cascade
  generation — a superseded pass's late outputs (timeout, convergence notes)
  never commit.
- **Bounded**: `CASCADE_PASS_TIMEOUT_MS = 15s`; a pass that never converges
  completes WITHOUT the queue trigger (convergence unproven; the queue's own
  5s poll / focus surface covers). Recovery latency is UNCHANGED — a
  request's action runs synchronously when it starts a pass.

### 1.2 Epoch discipline (BINDING adjudication 2026-10-10 — identity + liveness, NOT ordering)

Daemon epochs are crypto-random per store lifetime (`pkg/state/store.go`
newEpoch): never reused, never ordered. Debate-4 #8's "monotonic epoch"
requirement is REJECTED as a server change; the binding semantics are
INEQUALITY ONLY (this is what every existing consumer already does):

- The FE tracks the epoch its state was built from (`state.epoch`, set on
  applied snapshots). X-VH-Epoch/X-VH-Seq are stamped on every /vh/* response
  (`pkg/web/server.go` stampMeta) and remain available as a liveness hint.
- Snapshot tagged with the state's epoch ⇒ **seq-compare**: `snap.seq <
  acceptedCursor` ⇒ DISCARD (the D1 snapshot-clobber closure — never rewinds
  cursor or state); else apply with a monotonic cursor ratchet.
- Snapshot tagged with a DIFFERENT epoch ⇒ one of the two is from another
  store lifetime; PROVENANCE decides which:
  - **"stream"** (delivered on the current gen-guarded SSE connection — fresh
    by construction) ⇒ APPLY-REBUILD: the reducers' epoch-change clearing
    invalidates prior-epoch detail; the cursor RE-BASELINES to `snap.seq`.
    Cross-epoch seq comparison is FORBIDDEN.
  - **"http"** (an HTTP-fetched bundle, e.g. expand-children detail — can
    race a daemon restart in either direction) ⇒ DISCARD + ONE conservative
    `epoch-reset` recovery (fresh tree snapshot re-syncs). In the
    state-was-stale direction this costs one redundant resync — the
    documented conservative price of never guessing liveness from a random
    epoch. Cross-epoch snapshots NEVER cursor-clobber.
- Live events are untagged; they arrive gen-guarded on the current
  connection, so every cursor advance is a MONOTONIC RATCHET (the
  session-stream `sesCursor` guard generalized to the shared store cursor:
  `reconcile.reconcileEvent`, `tree-transport.advanceCursor`).

### 1.3 cause:"reconnect" consumption

`cause:"reconnect"` means **cursor-resume reconnect — replay OR ring-gap**,
nothing narrower. The server stamps it on TWO emission sites
(`pkg/web/server.go`): the replay-SUCCESS branch hardcodes `"reconnect"` on
the post-replay re-seed snapshot (~2931/2933 — EVERY cursor-preserving
replay reconnect, benign ones included, e.g. native EventSource auto-retry),
and the fresh-snapshot branch gates it on `hasCursor && !replayOK`
(~2999-3002, the true ring-gap fallback). The missed-events distinction is
carried by the detail snapshot's `partial.ringGap` flag (server.go ~3015-3021,
stamped ONLY when `hasCursor && !replayOK`, tree-only partial path — the
precise signal Slice B consumes); it is NOT carried by the cause field.

The FE retains the cause field through `decodeTreeSnapshot` and feeds it to
the cascade (`noteServerRingGap`), which arms a step-less pass that awaits
the pending tree baseline and fires the unified queue-reconcile trigger.
Counted as the stable reason `server-ring-gap`. Consequence of the coarse
cause: that counter today counts ALL cursor-resume reconnects — benign
replay reconnects included (harmless: the armed pass is idempotent and never
auto-sends) — and is NOT a true-ring-gap metric until Slice B switches the
detection to the `partial.ringGap` flag.

*(Corrected 2026-10-10, round-1 review C-F1/D-F1: the prior text claimed the
cause fires ONLY on the ring-gap fallback — it misdescribed the wire
contract. Semantics change belongs to Slice B; this section now states the
as-built wire behavior.)*

### 1.4 Unified queue-reconcile trigger (LANDED)

When a pass converges, the cascade fires the registered queue-reconcile
trigger — the SAME `reconcileOutboxSession` + `fetchQueue` surface
session-open and focus use (wired in ChatView; token-guarded registration).
**No third caller.** The stream-live reconnect path
(`createQueueSync`'s reconnect effect) notifies the cascade
(`notifyStreamLive`) on a `reconnecting → live` transition; every other live
run of that effect KEEPS the pre-existing immediate fetch (boot's
`connecting → live` and the session-change re-run — additive-only: removing
them reshuffles unrelated ack/notification timing the suite evolved under).
Counted as `cascade-queue-reconcile`.

Known interaction (deferred finding, 2026-10-10): the attending-view ack
(`sync/orchestration.ts` ackSession — "viewing a session acks ALL of its
notifications (any kind)") can mark a just-pushed USER-ACTION-OUTCOME error
notification read within ~300ms (turn completion while attending), making the
unread badge transient. The fork-guard e2e was restructured to assert the
durable observable (the notification item in the opened bell panel). Whether
user-action outcome errors deserve an ack carve-out is a coordinator
adjudication, not settled here.

### 1.5 Which paths route through the cascade (as-built)

FULL REROUTE (the request's action travels into the pass): `tree-seq-gap`,
`seq-gap`, `offset-mismatch`, `tail-incomplete`, watchdog tree/session
legacyForce (cursor-preserving tree / fresh session), sentinel timeouts
(cursor-preserving), `resyncTree` drift self-heal (new reason
`tree-drift-resync`), `epoch-reset`.

KEPT DIRECT (liveness/hygiene, not loss-recovery passes — observed via
`noteExternalRecovery` where their reason belongs in a running pass's key):
native CLOSED backoff retries (both transports), watchdog closed-branch
reopens, `tree-overlap-capture`'s owner-hygiene `connect(true)` (its
replacement capture MUST happen — a coalesced skip would strand the canceled
C4 owner), the slice-5b silent-fallback one-shot, `reconcileBusy` (its own
gated busy-scope handshake), and the visibility resume paths (already
coalesced by design).

### 1.6 Design-text drift corrections (binding, from the 2026-10-10 packet)

- **"A single `resume-required` control event"** — NOT BUILT and not
  required: no such server event exists; the cascade is FE-side, fed by the
  existing reason codes + the `cause` field. A future server-pushed
  tunnel/resume event remains a Slice-B option, not a cascade dependency.
- **The design's 6-step cascade sequence**, as-built: steps 1–2 (reopen +
  cursor replay) remain the transports' OWN reconnect ladders (backoff +
  native auto-retry) — deliberately NOT cascade-owned (liveness, not
  loss-recovery); step 3 (guarded snapshot apply) LANDED as the §1.2 guard;
  step 4 (queue reconcile by intentID) LANDED as the §1.4 unified trigger;
  step 5 ("refresh transient-backed pins + terminal scrollback") is STALE
  TEXT — pins are snapshot-converged and terminal scrollback replays on its
  own ws reconnect; the D4/D9 residues it cited were closed by slices 5/5b
  (sentinel, cursor-preserving reopen, silent-fallback). Documented OUT. The
  surviving residue — GLOBAL-status masking (`isStale` reads the TREE clock
  only, `health.ts`) — is an AMEND-A6/ConnStatus concern (Slice B), not a
  cascade step; step 6 (pane link status) is likewise AMEND-A6 territory.
- **Reconcile triggers as-built**: `createQueueSync` fires reconcile on
  session-open + focus; the cascade owns the reconnect trigger (this slice).
  The design's "queue reconcile by key" wording maps onto the SAME surface.

---

## 2. Graded ConnStatus (AMEND-A6 — BINDING for Slice B, with drift corrections)

A unified `ConnStatus` model replaces the per-consumer precedence ladders
(today: `"connecting" | "live" | "reconnecting"` in `web/src/types.ts`, with
Sidebar/sessionRail duplicating the same ladder and `navigator.offline`
mapping to generic "reconnecting").

- **Graded states**: `live | degraded | reconnecting | offline`.
- **Precedence (deterministic, single reduction — `web/src/sync/connstatus.ts`
  in Slice B)**: daemon tunnel-down ⇒ `reconnecting`; `navigator.offline` ⇒
  `offline` (never rendered as generic "reconnecting"); otherwise client
  observations govern browser reachability; `live` requires
  daemon-reachable AND post-cascade success (consumes Slice A's pass
  completion signal). Source/reason bits published.
- **Thresholds are ASSUMPTION-labeled and GATED on the FE-vantage baseline**
  (slice 4c BINDING rule, `web/src/sync/weaklink.ts`): tuning gates on the
  weaklink/recovery counters, NEVER on daemon-only proxy metrics. The design
  draft's "degraded after 2 failed probes or 2x p95 tick latency" is VOID as
  written (daemon-p95 is a proxy metric).
- **DRIFT CORRECTIONS (binding)**:
  - No tunnel-health push exists: `TunnelStats` is worker-side, exposed
    pull-only via `/vh/diag/latency`, consumed today only by the operator
    perf dialog. AMEND-A6's "daemon tunnel-down ⇒ reconnecting" precedence
    has NO input signal — Slice B must either add a daemon→FE signal or
    explicitly defer that precedence arm.
  - TerminalPane runs a PRIVATE staleness island (slice 4b: lastRecv
    watchdog, compose buffer). Any unification MUST preserve the 4b
    invariants: never auto-flush held text, exactly-once Send,
    gesture-disable while held.
  - Per-PANE status is per-SPA (each pane has its own streams + status);
    cross-pane unification is host-web territory — coordinate (fenced
    during Slice A).
  - Statuses adjust UI urgency but NEVER authorize mutation retries or prove
    non-delivery (unchanged).
- Slice-A note: the cascade's pass-completion signal is the "post-cascade
  success" input this section requires (Sequencing: A then B holds).

---

## 3. Test obligations (RED-first, pinned)

The research packet's five slice-A invariants are LANDED as tests
(`web/tests/unit/cascade.test.ts`, `web/tests/unit/snapshot-guard.test.ts`,
`web/tests/e2e/cascade-reconnect.spec.ts`):

1. A snapshot with `snap.seq < acceptedCursor` (same epoch) never rewinds
   cursor/state.
2. Epoch change ⇒ full invalidate + no cross-epoch seq compare (rebuild
   re-baselines).
3. N overlapping triggers within one window ⇒ exactly ONE cascade executes.
4. A superseded cascade's late outputs do not commit after a newer
   generation starts.
5. Flapping (repeated drop/restore storms) converges with bounded passes —
   no stacking.

Plus AMEND-A5 flapping (reason storm → one pass; supersession mid-pass),
epoch-reset, and the real-browser tunnel-drop e2e (route-injected tree-SSE
drop with `cause:"reconnect"`; convergence WITHOUT `location.reload` per
AMEND-A7 instrumentation; the queue reconcile fires FROM the cascade
trigger, observed via the `cascade-queue-reconcile` counter).

## 4. Provenance

- Source record: `tmp/agent-runs/send-design/` (gitignored; debate-3 AMEND-A5,
  debate-4 #8/B3, design.md §Convergence/§Connectivity — dated 2026-10-07/08).
- Gap map + drift corrections: `tmp/agent-runs/send-design/research-packet-cascade.md`
  (2026-10-10, tree 18574dd).
- Adjudication 1 (epoch discipline) + slice scoping: coordinator, 2026-10-10
  (this slice's task brief).
- Landing: slice A `web/src/sync/cascade.ts` + feeding sites (see §1.5),
  2026-10-10.
