// Document-liveness heartbeat emitter (embed-gated) for the production SPA.
//
// When this SPA is embedded in an iframe by the vh-solara host shell
// (`window.parent !== window`), listen for the host's one-time handshake,
// capture its browser-validated origin, and post periodic heartbeats so the host
// can drive a per-pane "document alive / reloaded / no recent signal" indicator.
// No-op when standalone (the common single-server case). See
// host-web/docs/heartbeat-protocol.md for the full contract.
//
// Q1-C: this is DOCUMENT liveness only — it fires regardless of SSE/stream
// health and must never be read as a connection/realtime signal.
// Q2-A: replies go to the host origin captured from the inbound handshake
// MessageEvent.origin (never a literal '*' and never a build-time config).

const HEARTBEAT_MS = 250; // ≈4 Hz, matching the mock stand-in (docs §6).

/**
 * Install the embed-gated heartbeat emitter. Captures identity ONCE per document
 * load (mountTs + nonce) and posts periodic heartbeats to the captured host
 * origin. Returns the interval id (the emitter lives for the document lifetime;
 * a reload re-runs this module → fresh mountTs + a fresh nonce from the new
 * handshake). No-op when not embedded (constraint #1).
 */
export function startHeartbeat(): number | undefined {
  if (typeof window === "undefined") return;
  // Constraint #1: embed gate. Send nothing when standalone.
  if (window.parent === window) return;

  // Identity captured ONCE per document load. NEVER reassigned.
  // mountTs = the document's navigation start (stable per load, changes on
  // reload). performance.timeOrigin is the cleanest monotonic anchor; fall back
  // to Date.now() at first embed-mode execution if it is unavailable.
  const mountTs =
    typeof performance !== "undefined" &&
    typeof performance.timeOrigin === "number"
      ? performance.timeOrigin
      : Date.now();

  // nonce is set from the host's handshake challenge (constraint #4: the SPA
  // echoes the host challenge). Until the handshake arrives we hold off (no
  // challenge to echo). A self-nonce is intentionally NOT used here — the real
  // SPA echoes the host challenge (stronger binding); the mock stand-in
  // (host-web/iframe-content/content.ts) is what self-nonces.
  let nonce: string | null = null;
  // Q2-A: host origin captured from the inbound handshake MessageEvent.origin.
  let hostOrigin: string | null = null;

  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type?: string; nonce?: string } | null;
    if (!data || data.type !== "vh-host-handshake") return;
    // F1 (inbound source-guard): only the actual parent window may establish
    // the heartbeat target. A handshake posted by any OTHER source must be
    // ignored — an untrusted sibling pane can grab this window's WindowProxy
    // via window.parent.frames[index] and postMessage({type:'vh-host-handshake',
    // ...}); without this check it would capture the attacker's origin/nonce,
    // poisoning the echoed nonce and/or redirecting every subsequent heartbeat
    // to the attacker (the legit host then sees "no recent signal" AND the
    // attacker receives this document's liveness metadata). Composes with the
    // host-side challenge-nonce verification — the two fixes are orthogonal:
    // source-guard on the inbound handshake (here) + nonce-verification on the
    // host side (store.routeMessage). event.source for a real host handshake is
    // window.parent (the host calls this contentWindow's postMessage directly).
    if (ev.source !== window.parent) return;
    // Q2-A: capture the browser-validated host origin for ALL replies.
    hostOrigin = ev.origin;
    // Constraint #4: echo the host's challenge nonce.
    if (typeof data.nonce === "string") nonce = data.nonce;
  };
  window.addEventListener("message", onMessage);

  return window.setInterval(() => {
    // Hold off until the host has handshaked (origin + nonce captured). This
    // keeps every reply origin-bound (Q2-A) and payload-minimal (constraint #5).
    if (hostOrigin === null || nonce === null) return;
    const msg = {
      type: "heartbeat" as const,
      mountTs,
      nonce,
      uptime: Date.now() - mountTs,
    };
    try {
      // Q2-A: targeted to the captured host origin — never '*'.
      window.parent.postMessage(msg, hostOrigin);
    } catch {
      /* parent window gone — ignore */
    }
  }, HEARTBEAT_MS);
}
