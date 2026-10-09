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
import { createSignal } from "solid-js";

const [capable, setCapable] = createSignal(false);
let custodyRefused = false;

/** Live daemon-dispatch capability as advertised by /vh/version. */
export function daemonDispatchCapable(): boolean {
  return capable();
}

/** The observe-only projection predicate: true when the daemon owns dispatch
 *  (advertised capability OR an observed custody refusal). Gates the drainer
 *  (queueDrain.ts observeOnly dep). */
export function projectionActive(): boolean {
  return capable() || custodyRefused;
}

/** True once a claim/resolve was refused with 409 queue_custody_active. */
export function queueCustodyRefused(): boolean {
  return custodyRefused;
}

/** Fetch /vh/version and update the capability signal. Never throws; a failed
 *  fetch keeps the previous value (fail-safe: false keeps the legacy path —
 *  and if a custody owner IS present, its 409 refusal latches the projection
 *  through noteQueueCustodyRefusal). */
export async function refreshDispatchMode(): Promise<void> {
  try {
    const r = await fetch("/vh/version", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    if (j && typeof j.daemonDispatchCapable === "boolean") {
      setCapable(j.daemonDispatchCapable);
    }
  } catch {
    /* offline/transient — keep the previous value */
  }
}

/** Latch the custody-refusal switch (queue.ts claim/resolve 409 handler). */
export function noteQueueCustodyRefusal(): void {
  custodyRefused = true;
}

/** Test-only: reset both switches. */
export function __resetQueueDispatchModeForTests(): void {
  setCapable(false);
  custodyRefused = false;
}

// Boot probe: one fetch at module load. Session-open refreshes come through
// createQueueSync's injected dep.
void refreshDispatchMode();
