// Deep-link handler for the `web+vhsolara:` protocol.
//
// Contract (DO NOT change without operator sign-off):
//
// 1. The manifest registers `web+vhsolara` -> `/?proto=%s` (see
//    web/public/manifest.webmanifest). When the OS/browser hands the launched
//    app a protocol URL, Chrome substitutes `%s` with the percent-encoded
//    payload, so the app boots at e.g. `/?proto=web%2Bvhsolara%3Asession%2Fabc`.
//
// 2. This module PARSES that payload from location.search on boot. It MUST NOT
//    auto-navigate or auto-act. The raw payload is surfaced to a user-confirmation
//    prompt (see components/ProtocolConfirm.tsx); the only "act" path is the
//    user clicking Allow. "Let the user enter for security" — a protocol handler
//    is an untrusted inbound surface, so we never act on it implicitly.
//
// 3. The current "act" is a stub that logs the confirmed payload (see
//    `confirmProtocol()`). Real routing (e.g. open a session) lands behind a
//    future slice; the parse + confirm-before-act contract is what this module
//    guarantees today.
import { createSignal } from "solid-js";

// The protocol scheme this handler accepts. Anything not starting with this
// prefix is dropped (treated as a malformed/spoofed payload).
export const PROTOCOL_SCHEME = "web+vhsolara:";

// pendingProtocol holds the inbound payload awaiting user decision, or null.
// Read-only outside this module (use dismissProtocol/confirmProtocol to clear).
const [pendingProtocol, setPendingProtocol] = createSignal<string | null>(null);
export { pendingProtocol };

// parseProtocolPayload extracts and URL-decodes the `proto` query parameter.
// Returns null when the param is absent or empty — callers treat null as "no
// inbound payload". Pure: no side effects, no signal mutation, no navigation.
export function parseProtocolPayload(search: string): string | null {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const raw = new URLSearchParams(q).get("proto");
  // URLSearchParams already percent-decodes (and converts '+' to space, which
  // is why a literal '+' in the scheme must arrive as %2B). An empty/whitespace
  // payload is treated as absent.
  return raw && raw.trim() ? raw : null;
}

// Looks well-formed enough to surface to the user. We deliberately do NOT
// reject unfamiliar shapes here — the user sees the raw string and decides.
// The only hard filter is the scheme prefix, which guards against completely
// unrelated strings being presented as protocol launches.
export function isPlausiblePayload(payload: string): boolean {
  return payload.startsWith(PROTOCOL_SCHEME);
}

// initProtocolHandler reads the launched URL exactly once on boot and stages
// the payload for the confirm prompt. It does NOT act. Safe to call multiple
// times: once a payload is staged it is not overwritten by a later empty read.
export function initProtocolHandler(search: string = location.search): void {
  if (pendingProtocol()) return;
  const payload = parseProtocolPayload(search);
  if (payload) setPendingProtocol(payload);
}

// User clicked Allow — the ONLY act path. Today this logs the confirmed
// payload (stub). Future routing lives here.
export function confirmProtocol(): void {
  const payload = pendingProtocol();
  if (!payload) return;
  // eslint-disable-next-line no-console
  console.info("[vh-solara] protocol handler: user confirmed payload", payload);
  setPendingProtocol(null);
}

// User clicked Cancel (or pressed Escape). Drop the payload without acting.
export function dismissProtocol(): void {
  setPendingProtocol(null);
}
