// Host→pane reverse-nav select listener (embed-gated) for the production SPA.
//
// P4 enabler: lets the vh-solara host shell direct an embedded SPA to switch to
// a specific {dir, session} WITHOUT reloading the iframe (a survival-safe
// SPA-INTERNAL route change). The host posts {type:'vh-host-select',dir,session};
// this listener dispatches it to the existing route-change primitives
// (`setSelectedId` for a SAME-DIR session switch — Stream-2 only, warm, instant;
// `switchProject` + `setSelectedId` for a DIR/project switch — full tree
// re-snapshot, the expensive case that gates the P4 reuse-vs-per-dir-pool fork).
//
// The iframe element, its src, and `renderer:'always'` are NEVER touched — this
// is purely an SPA-internal selection/project change, exactly what a user
// clicking a session in the tree would trigger. Survival is unchanged.
//
// SECURITY MODEL (mirrors heartbeat/route/status EXACTLY):
//   - embed gate (`window.parent === window` → no-op standalone);
//   - inbound source-guard (`ev.source !== window.parent` → reject, BEFORE any
//     state mutation — the heartbeat F1 fix: only the actual parent window may
//     drive a select, so an untrusted sibling pane that grabbed this window's
//     WindowProxy via window.parent.frames[index] cannot hijack the selection);
//   - payload allowlist to {dir, session} ONLY (the CF1 route-allowlist pattern
//     — every other field is ignored; a poison access_token / debug flag in the
//     payload never reaches the dispatch).
//
// No REPLY is posted here. Captured-origin targeting (the heartbeat's
// hostOrigin capture) is therefore N/A: this listener mutates SPA state only;
// the SPA's existing route emission (heartbeat.ts ~125-133) naturally fires
// {type:'route'} back to the host once the URL changes — that is the round-trip
// signal. No new outbound message is needed (and none would have a captured
// origin to target without sharing the handshake listener, which is unnecessary
// here since the source-guard is the load-bearing inbound binding).

import { projectDir } from "./sync/store";
import { setSelectedId, switchProject } from "./sync/actions";

export const SELECT_TYPE = "vh-host-select";

interface HostSelectMessage {
  type: "vh-host-select";
  dir: string;
  session: string;
}

/**
 * Validate that a payload is an allowlisted {type:'vh-host-select',dir,session}
 * carrying ONLY string dir + session (CF1: every other field is ignored, never
 * forwarded into dispatch). Returns the typed message or null when the payload
 * is out-of-contract. Mirrors the closed-vocabulary discipline of the route
 * allowlist (heartbeat.ts `allowlistRoute`).
 */
function asHostSelect(data: unknown): HostSelectMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<HostSelectMessage> & Record<string, unknown>;
  if (d.type !== SELECT_TYPE) return null;
  // Allowlist: dir + session MUST be strings; reject anything else (a poison
  // field like access_token is ignored — it never reaches setSelectedId).
  if (typeof d.dir !== "string") return null;
  if (typeof d.session !== "string") return null;
  return { type: SELECT_TYPE, dir: d.dir, session: d.session };
}

/**
 * Dispatch a validated select to the SPA's route-change primitives.
 *
 *   - SAME-DIR (select.dir === projectDir()): `setSelectedId(session)` — Stream-2
 *     only, the tree is untouched, a warm session switch is instant.
 *   - CROSS-DIR: `switchProject(dir)` then `setSelectedId(session)`. switchProject
 *     does NOT take a session arg (it clears selection via setSelectedIdRaw(null)
 *     and reconnects the stream scoped to the new dir), so the follow-up
 *     setSelectedId is required to land on the requested session. The snapshot
 *     reconciles asynchronously; selecting before it lands mirrors a deep-link.
 */
function dispatchSelect(sel: HostSelectMessage): void {
  if (sel.dir === projectDir()) {
    setSelectedId(sel.session);
    return;
  }
  switchProject(sel.dir);
  setSelectedId(sel.session);
}

/**
 * Install the embed-gated host→pane select listener. Returns a disposer that
 * removes the listener (the listener otherwise lives for the document lifetime;
 * a reload re-runs this module → a fresh listener). No-op when standalone
 * (returns undefined, mirroring startHeartbeat's embed gate). Wire alongside
 * startHeartbeat()/startStatusEmitter() in index.tsx.
 */
export function startSelectListener(): (() => void) | undefined {
  if (typeof window === "undefined") return;
  // Constraint #1 (mirror heartbeat): embed gate. Do nothing standalone — the
  // common single-server case has no host to drive a select.
  if (window.parent === window) return;

  const onMessage = (ev: MessageEvent): void => {
    // F1 (mirror heartbeat): inbound source-guard, BEFORE any state mutation.
    // Only the actual parent window may drive a select; an untrusted sibling
    // pane that grabbed this window's WindowProxy must not hijack the SPA's
    // selection/project. event.source for a real host select is window.parent.
    if (ev.source !== window.parent) return;
    const sel = asHostSelect(ev.data);
    if (!sel) return; // CF1 allowlist: non-contract payloads are ignored entirely.
    dispatchSelect(sel);
  };
  window.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener("message", onMessage);
  };
}
