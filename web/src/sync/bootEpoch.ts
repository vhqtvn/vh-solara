// bootEpoch — the persisted store-lifetime declaration shared by BOTH stream
// openers (F1 epoch handshake, round 3 / review b-F1).
//
// Why persistence (not a reconnect): the first connect of a page life
// necessarily precedes the snapshot that would tell it the epoch — its URL
// is epoch-less by construction, and an EventSource URL is frozen (native
// auto-reconnect re-requests it verbatim). Reconnecting once the snapshot
// lands would inject a reconnect into EVERY page load — and a reconnect
// here is a significant app event (status resets, convergence boundaries,
// expand/refetch contracts). Instead the last-applied epoch is PERSISTED per
// project dir: every boot AFTER the first declares the previous lifetime in
// its FIRST URL — on BOTH streams (tree connect() and openSessionES), which
// also covers the persisted state.cursor (store.ts) and every remembered
// session cursor, whose resume values are equally previous-lifetime
// candidates. The server-side handshake then protects even the first
// native reconnect of a returning visitor (declared ≠ store ⇒ fresh
// fallback instead of a plausible-but-wrong replay).
//
// This module exists so session-stream can read the boot epoch WITHOUT
// importing tree-transport (tree-transport imports session-stream for
// noteStoreEpochChanged; the reverse edge would close a cycle — an invariant
// the review panel traces explicitly).
//
import { projectDir } from "./store";

// Standalone per-dir LS key with write-through, mirroring the agent/model
// pick keys' rationale (store.ts: never part of the debounced persist()
// batch — the epoch must be readable at the very first connect()).
export const bootEpochKey = (): string => `vh:syncepoch:${projectDir()}`;

export function readBootEpoch(): string {
  try {
    return localStorage.getItem(bootEpochKey()) ?? "";
  } catch {
    return ""; // storage unavailable (private mode) — boot stays epoch-less
  }
}

export function writeBootEpoch(epoch: string): void {
  try {
    localStorage.setItem(bootEpochKey(), epoch);
  } catch {
    // Unwritable storage only costs the next boot's first-connect
    // declaration; the in-page handshake machinery is unaffected.
  }
}
