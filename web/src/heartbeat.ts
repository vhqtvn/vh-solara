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
 * Reconstruct the SPA's route query carrying ONLY the known deep-link params
 * (dir, session). Every other query param in window.location.search is dropped
 * so the cross-origin route payload stays within the declared non-sensitive
 * boundary — the SPA's routing vocabulary is exactly {dir, session}
 * (sync/url.ts writes nothing else). Returns a canonical
 * "?dir=...&session=..." (only params actually present, in dir-then-session
 * order), or "" when the SPA has no deep-link to forward. If the SPA's routing
 * vocabulary grows, extend this allowlist.
 */
function allowlistRoute(): string {
  const incoming = new URLSearchParams(window.location.search);
  const out = new URLSearchParams();
  const dir = incoming.get("dir");
  if (dir !== null) out.set("dir", dir);
  const session = incoming.get("session");
  if (session !== null) out.set("session", session);
  const qs = out.toString();
  return qs === "" ? "" : `?${qs}`;
}

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

  // Route emission: track the SPA's current URL query (a non-sensitive
  // ?dir=...&session=... deep-link) and post it to the host on change so the
  // host can persist it per-pane and restore it on reload. Mirrors the
  // heartbeat exactly: embed-gated, captured origin, never '*'. The route is
  // the same threat class as mountTs/nonce (non-sensitive display state).
  let lastRoute: string | null = null;

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

    // Route emission: post a route message when the SPA's URL query changes.
    // Same origin target + embed gate + source-guard as the heartbeat above.
    // ALLOWLIST (CF1): only the SPA's known deep-link params (dir, session) are
    // forwarded; all other query params are dropped to keep the cross-origin
    // payload within the declared non-sensitive boundary. The SPA's routing
    // vocabulary is exactly {dir, session} (sync/url.ts); if it grows, extend
    // allowlistRoute(). The reconstructed query is a canonical
    // "?dir=...&session=..." (only params actually present) — "" when the SPA
    // has no deep-link to forward.
    const route = allowlistRoute();
    if (route !== lastRoute) {
      lastRoute = route;
      try {
        window.parent.postMessage({ type: "route", route }, hostOrigin);
      } catch {
        /* parent window gone — ignore */
      }
    }
  }, HEARTBEAT_MS);
}
