// Archive-failure visibility — the CLIENT FACADE over the per-project stuck-
// archive-ROOT registry (Slice 1 of the archive-failure chain).
//
// A permanently-stuck archive root (OpenCode 400/403 on PATCH time.archived, or
// the bounded retry budget exhausting on a root/unresolvable chain) is recorded
// server-side in an in-memory (dir,id) UPSERT map (pkg/web/archive.go) and
// surfaced to the SPA via two SSE frames:
//   - archive-failures.snapshot — emitted on every fresh /vh/stream connect
//     (the bootstrap catch-up, already filtered to reqDir(r) — tenant
//     isolation: only THIS project's failures cross the wire).
//   - archive-failures.updated — emitted transiently on record/clear.
//
// Both frames carry the SAME shape (the full per-project set), so the client
// applies them idempotently: REPLACE the local set with the server's current
// set. There is no CAS, no revision, no mutation — this is far simpler than the
// labels/pins facades (which own optimistic mutation + rollback). The signal
// here is a pure reflection of server state for the current project.
//
// The clear lifecycle is load-bearing: a failure clears ONLY when a retry
// actually succeeds (clear-on-success at the runArchiveCascade success funnel —
// pkg/web/archive.go), NEVER when the 200-accepted POST response returns
// (acceptance ≠ success — the cascade runs async). The banner reflects that by
// staying visible until an archive-failures.updated frame removes the id.
//
// The wire DTO carries ONLY the classified reason token ("permanent:403",
// "exhausted:5", "cancelled:shutdown") — NEVER raw opencode.Error.Body (that
// stays in server log.Printf). The client has no path to Body at all, so the
// banner structurally cannot leak it.

import { createSignal } from "solid-js";
import { log } from "./lib/log";

// === Wire shape (mirrors pkg/web/archive_failures.go) ========================
// Both archive-failures.snapshot and archive-failures.updated decode as
// ArchiveFailuresDoc. The server is the authority; the client repairs
// defensively (drop entries lacking a string id) but never invents fields.
export interface ArchiveFailureDTO {
  id: string;
  reason: string; // classified token: "permanent:403" | "exhausted:5" | "cancelled:shutdown"
  rootSrc?: string; // the originating POST /vh/archive sessionID (omitted when empty)
  at: number; // unix millis
}
export interface ArchiveFailuresDoc {
  failures: ArchiveFailureDTO[];
}

// === Per-project signal ======================================================
// The SSE frames are ALREADY filtered server-side to this stream's reqDir, so
// the client holds ONE signal for the current project. A project switch
// reconnects the stream (new reqDir), and the next snapshot resets this signal
// to the new project's set. No client-side dir filtering is needed.
//
// Project-switch reset (mirrors labels' labelsScopeGen / resetLabelsScope
// pattern precisely — commit 23efd32): resetArchiveFailuresScope() clears the
// signal AND bumps archiveFailuresScopeGen on every switchProject, so the
// outgoing project's failures vanish IMMEDIATELY — before the incoming
// project's stream connects — fixing two leaks:
//   - No-project switch (''): connect() early-returns on empty dir → no stream
//     → no snapshot → without the reset, A's banner renders INDEFINITELY.
//   - A→B switch: without the reset, A's failures render in B's banner until
//     B's snapshot lands (the exact cross-project leak resetLabelsScope fixes).
//
// archiveFailuresScopeGen is a monotonic token bumped on every reset. The SSE
// apply functions (applyArchiveFailuresSnapshot / applyArchiveFailuresUpdated)
// are guarded PRIMARILY by the transport's connection-generation check (treeGen
// in sync/tree-transport.ts: `if (gen !== treeGen) return;` — a frame from the
// outgoing project's closed stream is dropped at the listener BEFORE it reaches
// here). The facade-level scope check in the apply functions is DEFENSE-IN-
// DEPTH: it mirrors labels' scope-gen discipline so the facade is self-defending
// if the transport invariant ever has a hole, and future-proofs against an async
// gap being added here (today the apply path is synchronous, so the check is
// structurally a no-op — the live guard is treeGen + the reset clear). This is
// the same layering labels uses: labelsScopeGen guards the PUT mutation path
// (performMutation, after an await); the labels SSE apply functions rely on
// treeGen. archive-failures has no mutation path today, so the scope-gen is
// reset-clear + future-proofing.
const [archiveFailures, setArchiveFailures] = createSignal<ArchiveFailureDTO[]>([]);
export { archiveFailures };

// archiveFailuresScopeGen is a monotonic token bumped on every
// resetArchiveFailuresScope. Captured by the apply functions at entry and
// re-checked before set so a project switch landing between dispatch and
// application drops the stale frame (defense-in-depth — see the signal comment
// above for the treeGen primary guard).
let archiveFailuresScopeGen = 0;

// resetArchiveFailuresScope — clear the failures signal and advance the scope
// generation. Called on every project switch (and on the no-project teardown)
// from sync/actions.ts switchProject, right beside resetLabelsScope, so the
// outgoing project's failures are gone before the incoming project connects.
// The scope-gen bump invalidates any in-flight frame from the outgoing project
// that might reach an apply function (defense-in-depth; the primary guard is
// treeGen at the transport listener). Mirrors resetLabelsScope precisely.
export function resetArchiveFailuresScope(): void {
  setArchiveFailures([]);
  archiveFailuresScopeGen++;
}

// coerceArchiveFailuresDoc — defensive parser for an archive-failures frame.
// Returns null only for a shape that cannot yield a usable doc (non-object
// input or missing failures array); otherwise repairs in-place (drop entries
// lacking a string id; default reason to "unknown"). Mirrors the
// defensive-parse posture of coerceLabelsDoc / coercePinDoc so a corrupt frame
// never crashes the UI — the transport drops (null) or adopts (repaired array)
// sensibly. The server never emits these inconsistencies in practice.
function coerceArchiveFailuresDoc(raw: unknown): ArchiveFailureDTO[] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.failures)) return null;
  const out: ArchiveFailureDTO[] = [];
  for (const f of obj.failures) {
    if (!f || typeof f !== "object") continue;
    const fr = f as Record<string, unknown>;
    const id = typeof fr.id === "string" ? fr.id : "";
    if (!id) continue; // nothing to retry or display without an id
    const reason = typeof fr.reason === "string" ? fr.reason : "unknown";
    const rootSrc = typeof fr.rootSrc === "string" && fr.rootSrc ? fr.rootSrc : undefined;
    const at = typeof fr.at === "number" ? fr.at : 0;
    out.push({ id, reason, rootSrc, at });
  }
  return out;
}

// === Stream entry points (called by sync/tree-transport.ts listeners) ========
// applyArchiveFailuresSnapshot — the fresh-connect bootstrap. Authoritative,
// always adopted. Resets the signal to the server's current per-project set
// (a reconnect never loses unresolved failures — RT2/RT3).
export function applyArchiveFailuresSnapshot(raw: unknown): void {
  const scope = archiveFailuresScopeGen;
  const failures = coerceArchiveFailuresDoc(raw);
  if (failures === null) {
    log.warn("archive-failures", "malformed archive-failures.snapshot doc", { raw });
    return;
  }
  // Defense-in-depth scope guard (see the signal comment above): drop a frame
  // whose dispatch preceded a project-switch reset. The PRIMARY guard is the
  // transport's treeGen check at the listener level; this is the facade-level
  // backstop.
  if (scope !== archiveFailuresScopeGen) return;
  setArchiveFailures(failures);
}

// applyArchiveFailuresUpdated — a live record/clear fan-out. The frame carries
// the FULL per-project set (same shape as the snapshot), so this is a plain
// replace — no diffing, no revision guard. recordArchiveFailure UPSERTS one
// entry; clearArchiveFailure removes one; both re-emit the full set, so the
// client converges by replacement. RT4 (retry-200 does NOT prematurely clear):
// the 200-accepted POST does not emit an updated frame at all — only the
// background cascade's success funnel does, so an accepted-but-still-running
// retry leaves the warning intact until genuine success.
export function applyArchiveFailuresUpdated(raw: unknown): void {
  const scope = archiveFailuresScopeGen;
  const failures = coerceArchiveFailuresDoc(raw);
  if (failures === null) {
    log.warn("archive-failures", "malformed archive-failures.updated doc", { raw });
    return;
  }
  if (scope !== archiveFailuresScopeGen) return; // defense-in-depth scope guard (see above)
  setArchiveFailures(failures);
}

// Test-only: reset the signal AND zero the scope-gen so each test starts from a
// deterministic scope (resetArchiveFailuresScope, which tests call to simulate a
// project switch, then bumps it monotonically from 0). Mirrors
// __resetLabelsForTest.
export function __resetArchiveFailuresForTest(): void {
  setArchiveFailures([]);
  archiveFailuresScopeGen = 0;
}
