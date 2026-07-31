// L-08/M4 — the projection/effect boundary contract.
//
// Reducers (reducers.ts) synchronously project server facts into SyncState and
// RETURN typed reconciliation effects. They do NOT directly call notification
// dispatch, pin-store mutation, page-flight/cache services, persistence
// scheduling, localStorage/storage APIs, timers, or transport APIs. An
// orchestration boundary (reconcile.ts) interprets the returned effects and
// owns every side-effect policy. The standing check
// TestApplyReconcileHasNoInlinePolicy pins that the projection module invokes
// none of those policy APIs directly.
//
// EFFECT NAMING DISCIPLINE: effect kinds are FACTUAL OBSERVATIONS of what the
// server fact implied ("assistant-error-observed"), NOT policy commands
// ("show-error-notification"). Orchestration owns the policy decision (which
// notification kind, the settled-idle timer, the pin-drop, the persist
// debounce). This keeps projection and policy independently reason-about-able
// and checkable.
//
// The reconciliation path is FULLY SYNCHRONOUS after the transport layer's
// existing coherent-capture await — no promise/await/microtask may be inserted
// in the project → interpret → cursor → persist sequence.

export type ReconcileEffect =
  // A server fact implied an assistant/session error. Orchestration decides the
  // notification kind + detail. Emitted by message.upsert (assistant error) and
  // status (session.error) projections.
  | { kind: "assistant-error-observed"; sessionID: string; detail: string }
  // A subtree's working state may have settled; the root-completion ping
  // (settled-idle timer) is decided by orchestration. Emitted by the activity
  // projection.
  | { kind: "root-maybe-completed"; sessionID: string }
  // A session's pending-input state may have resolved; the "waiting" nudge ack
  // is decided by orchestration. Emitted by activity / permission.delete /
  // question.delete projections.
  | { kind: "input-maybe-answered"; sessionID: string }
  // A session was removed from the store. Orchestration runs the deletion
  // cascade: resetPageInFlight + dropPinnedSession. Emitted by session.delete
  // and the eager archive prune (both route through projectSessionRemoval).
  | { kind: "session-removed"; sessionID: string }
  // A cold-seed lastAgent.set event filled an agent label for an un-opened
  // session. The tree node must be patched so the chip renders on collapsed
  // nodes without an expand round-trip — a cross-store (tree) mutation that is
  // NO LONGER allowed inline in the projection. Orchestration calls
  // patchTreeAgent here; interpreted synchronously within the same
  // reconciliation cycle as the producing event (ordering-equivalent to the
  // former inline call, which ran inside the produce() batch). Emitted by the
  // lastAgent.set projection.
  | { kind: "reconcile-tree-agent"; sessionID: string; agent: string }
  // The projected mutation dirtied the persisted slices (cursor/activity/
  // lastAgents). Interpreted LAST (after the cursor advance) so persistence
  // captures the final cursor value. Orchestration calls the debounced persist.
  | { kind: "sync-state-dirty" };

// A projection's result is the list of effects the server fact produced.
// The orchestration entrypoint feeds this list into interpretEffects. The
// projection functions in reducers.ts push into a caller-supplied effects
// array (closure-captured inside produce); conceptually that array IS the
// ProjectionResult.effects.
export interface ProjectionResult {
  effects: ReconcileEffect[];
}

// Cursor-tracking policy carried explicitly through the orchestration entrypoint.
// Stream 1 (tree transport) tracks the shared resume cursor; Stream 2
// (active-session messages) never advances it (it re-snapshots on connect, and
// letting its high-seq events advance the shared cursor would push Stream 1's
// resume point past structural events it hasn't applied yet).
export interface ReconcileContext {
  trackCursor: boolean;
}

// The event the orchestration entrypoint projects. `payload` is the decoded
// wire event body (the reducer layer never re-parses transport frames).
export interface ReconcileEvent {
  kind: string;
  seq: number;
  payload: any;
}
