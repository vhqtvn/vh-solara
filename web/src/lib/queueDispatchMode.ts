// Queue dispatch-ownership mode — the FE's feature-detect for daemon-owned
// dispatch (send-net-resilience slice 3).
//
// When the daemon owns dispatch (/vh/version advertises
// `daemonDispatchCapable: true`, or a claim/resolve was refused with 409 +
// code `queue_custody_active`), the FE STOPS claiming/dispatching and becomes
// an observe-only PROJECTION of the queue: it still admits (enqueue), lists,
// and renders chips, but never claims, never POSTs prompt_async, and never
// resolves — the daemon's custody drain owns those. When the capability is
// absent (legacy daemons), the legacy browser-dispatch path is byte-intact.
//
// The two switches:
//   capable        — /vh/version's daemonDispatchCapable (refreshed at boot;
//                    refreshed on session-open via createQueueSync's dep).
//   custodyRefused — a LATCH: one observed 409 queue_custody_active proves a
//                    live custody owner holds this project's queue; the page
//                    switches to projection and never races it again (a
//                    refusal is ownership information, NOT an error).
//
// The tri-state read (b-F1, commit-review 2026-10-27): `capable() === false`
// is NOT evidence of a legacy server — a daemon-dispatch server whose every
// /vh/version probe fails (network error / non-OK / malformed JSON) also
// reads false. dispatchMode() distinguishes the two: "modern" (a switch says
// the daemon owns dispatch), "legacy-confirmed" (the last completed probe
// returned a parseable body and no switch says modern — INCLUDING the
// capability-absent shape, a genuine legacy daemon), and "unknown" (the last
// probe could not establish the mode, or no probe has completed yet — the
// boot-race window). The queue-item retry guard treats "unknown" as NO
// permission to POST (createSend.retryQueuedItem refuses loudly).
import { createSignal } from "solid-js";

/** The dispatch-ownership tri-state (see module header). */
export type DispatchMode = "modern" | "legacy-confirmed" | "unknown";

const [capable, setCapable] = createSignal(false);
// Queue-policy slice B2 (2026-10-29 amendment §4): the server advertises
// `queueDispatchPolicyVersion` (a number, 1 = the per-item dispatchPolicy
// scheduler) ONLY while the policy scheduler is ACTIVE — the same enablement
// as daemon dispatch. True gates the policy composer button table + the
// pending-chip Send-now escalation; false/absent keeps every pre-policy
// surface byte-for-byte. Same fail-safe posture as `capable`: a failed probe
// keeps the previous value (the buttons stay as rendered; a server that truly
// lost the capability answers the now-admission with 409
// queue_dispatch_policy_unsupported, which surfaces on the rejected row).
const [policyCapable, setPolicyCapable] = createSignal(false);
let custodyRefused = false;
// Whether the LAST COMPLETED /vh/version probe established the mode (a
// parseable response body arrived). Per-attempt by design: a probe that
// fails AFTER an earlier success DOWNGRADES the observation to "unknown" —
// for the retry guard, "cannot establish the mode right now" must never
// ride on stale evidence (the mode can flip across a daemon upgrade).
// `capable` itself still RETAINS its previous value on failure (the
// projection paths — drainer observeOnly, QueueChip render guard — keep
// their fail-safe semantics; only the tri-state read is per-attempt).
let modeEstablished = false;

/** Live daemon-dispatch capability as advertised by /vh/version. */
export function daemonDispatchCapable(): boolean {
  return capable();
}

/** Queue-policy capability (queueDispatchPolicyVersion on /vh/version).
 *  True ONLY while the server's policy scheduler is active — gates the
 *  Send-now/Queue composer button table and the pending-chip escalation. */
export function queuePolicyCapable(): boolean {
  return policyCapable();
}

/** The observe-only projection predicate: true when the daemon owns dispatch
 *  (advertised capability OR an observed custody refusal). Gates the drainer
 *  (queueDrain.ts observeOnly dep). Equivalent to dispatchMode() === "modern". */
export function projectionActive(): boolean {
  return capable() || custodyRefused;
}

/** The dispatch-ownership tri-state (b-F1). "modern" dominates (either
 *  switch — capability advertised or a custody refusal latched); otherwise
 *  the observation is only as good as the last completed probe. */
export function dispatchMode(): DispatchMode {
  if (capable() || custodyRefused) return "modern";
  return modeEstablished ? "legacy-confirmed" : "unknown";
}

/** True once a claim/resolve was refused with 409 queue_custody_active. */
export function queueCustodyRefused(): boolean {
  return custodyRefused;
}

/** Fetch /vh/version and update the capability signal. Never throws; a failed
 *  fetch keeps the previous capability value (fail-safe: false keeps the
 *  legacy path — and if a custody owner IS present, its 409 refusal latches
 *  the projection through noteQueueCustodyRefusal). The tri-state
 *  observation is per-attempt: a failed fetch downgrades dispatchMode() to
 *  "unknown" until a probe succeeds again — an unestablishable mode is not
 *  legacy evidence (b-F1). Concurrent probes (boot + session-open + the
 *  retry's click-time refresh) each record their own attempt's outcome on
 *  completion; last completion wins. */
export async function refreshDispatchMode(): Promise<void> {
  try {
    const r = await fetch("/vh/version", { cache: "no-store" });
    if (!r.ok) {
      modeEstablished = false;
      return;
    }
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== "object") {
      modeEstablished = false;
      return;
    }
    if (typeof (j as any).daemonDispatchCapable === "boolean") {
      setCapable((j as any).daemonDispatchCapable);
    }
    // Queue-policy B2: a numeric queueDispatchPolicyVersion >= 1 advertises
    // the ACTIVE policy scheduler (the server omits the key otherwise — a
    // missing/unsupported capability never activates modern gestures). Any
    // other shape (absent, wrong type, 0/negative) reads NOT capable.
    const pv = (j as any).queueDispatchPolicyVersion;
    setPolicyCapable(typeof pv === "number" && Number.isFinite(pv) && pv >= 1);
    // Any parseable 200 body establishes the mode: capability advertised or
    // false → resolved by the switches + this flag; field ABSENT → genuine
    // legacy (an old daemon that predates the advertisement) — the retry
    // proceeds exactly as on a capability:false server.
    modeEstablished = true;
  } catch {
    modeEstablished = false; // offline/transient — capability keeps its value
  }
}

/** Latch the custody-refusal switch (queue.ts claim/resolve 409 handler). */
export function noteQueueCustodyRefusal(): void {
  custodyRefused = true;
}

/** Test-only: reset both switches. */
export function __resetQueueDispatchModeForTests(): void {
  setCapable(false);
  setPolicyCapable(false);
  custodyRefused = false;
  modeEstablished = false;
}

// Boot probe: one fetch at module load. Session-open refreshes come through
// createQueueSync's injected dep.
void refreshDispatchMode();
