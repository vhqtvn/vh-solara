// Read-only derived views over the sync store: the parent/subtree walks, the
// working-state rollup, todo aggregation, and the per-session model selectors.
// All pure reads of `state` (no mutation, no I/O), so they sit just above the
// store in the dependency graph and everything else can read through them.
import type { Part, SessionMessages, TodoItem } from "../types";
import { toolSubject, toolVerb } from "../lib/toolLabel";
import { state } from "./store";

// The root of a session (top of the parentID chain that's still in the store).
export function rootOf(id: string): string {
  let cur = id;
  for (let guard = 0; guard < 10000; guard++) {
    const p = state.sessions[cur]?.parentID;
    if (!p || !state.sessions[p]) return cur;
    cur = p;
  }
  return cur;
}

export type ModelRefLite = { providerID: string; modelID: string; variant?: string };

// Read-only per-session model selectors, so the models module depends on these
// views rather than reaching into the store's shape directly. session.model uses
// `id`, message.model uses `modelID` — accept either.
//
// Phase 3 snapshot trim: when the server hoists model/projectID/directory into
// a snapshot-level map (?hoist=1), the per-session model field is stripped from
// most sessions. Fall back to the hoisted project constant so a cold tree still
// resolves the model for every row. The per-session value (when present) always
// wins — a session may carry an inline override (a different model than the
// project default).
export function sessionModel(id: string): ModelRefLite | undefined {
  const m = state.sessions[id]?.model ?? state.projectConstants?.model;
  const modelID = m?.modelID ?? m?.id;
  return m?.providerID && modelID ? { providerID: m.providerID, modelID, variant: m.variant } : undefined;
}

// Server model present on THIS session record ONLY. Unlike sessionModel(), this
// deliberately does NOT fall back to projectConstants.model. projectConstants.model
// is a snapshot-compression/display value: the backend hoists the common value
// from active captured sessions and strips matching inline fields under ?hoist=1
// (pkg/state/projection.go). It is NOT per-session user intent, so it is the
// wrong signal for the agent-write guard (applyAgentModel), which must only
// treat a session as "established" when THIS session's record carries its own
// server model. selectionFor() still resolves display through sessionModel()
// (hoist-aware); this selector is the narrower, faithful per-session provenance
// read for the write guard. Mirrors sessionModel's field-read logic verbatim
// (modelID ?? id, variant passthrough) — only WITHOUT the projectConstants ?? .
export function inlineSessionModel(id: string): ModelRefLite | undefined {
  const m = state.sessions[id]?.model;
  const modelID = m?.modelID ?? m?.id;
  return m?.providerID && modelID ? { providerID: m.providerID, modelID, variant: m.variant } : undefined;
}

// Phase 3 snapshot trim: like sessionModel, projectID is hoisted into
// projectConstants under ?hoist=1. Fall back to the hoisted constant so
// features that read it (e.g. suggestTitle → "Regenerate name") work on
// hoisted sessions whose per-session projectID was stripped.
export function sessionProjectID(id: string): string | undefined {
  return state.sessions[id]?.projectID ?? state.projectConstants?.projectID;
}

// The model on the session's most recent user message.
export function lastUserMessageModel(id: string): ModelRefLite | undefined {
  const sm = state.messages[id];
  if (!sm) return undefined;
  for (let i = sm.order.length - 1; i >= 0; i--) {
    const info: any = sm.byId[sm.order[i]]?.info;
    if (info?.role === "user" && info.model?.providerID) {
      return { providerID: info.model.providerID, modelID: info.model.modelID, variant: info.model.variant };
    }
  }
  return undefined;
}

// The agent of the session's most recent message that carries one (OpenCode
// stamps `agent` on assistant messages). Used to restore the composer's agent
// per session, the same way the model is restored from the last user message,
// AND to render the per-agent chip in the tree.
//
// When the session's messages are LOADED (open), the live scan is authoritative
// — it reflects the newest assistant turn as events stream in (the snapshot-seeded
// lastAgents map only refreshes on snapshot/reconnect, so preferring it would
// show a STALE agent for an open session). When messages are NOT loaded
// (cold/un-opened session on a fresh tree), fall back to the snapshot-seeded
// lastAgents map so the chip renders immediately without opening the session.
export function sessionLastAgent(id: string): string | undefined {
  const sm = state.messages[id];
  if (sm) {
    for (let i = sm.order.length - 1; i >= 0; i--) {
      const info: any = sm.byId[sm.order[i]]?.info;
      if (info?.agent) return info.agent as string;
    }
    return undefined; // loaded but no assistant message with an agent yet
  }
  return state.lastAgents[id];
}

// True when a session OR any of its subagents has a pending permission/question
// (a typed reply it's blocked on). Reactive — clears itself when the request is
// resolved. Surfaced in the session list and used to auto-ack the in-app nudge.
export function sessionNeedsInput(sessionID: string): boolean {
  for (const id of subtreeSessionIds(sessionID)) {
    if (Object.keys(state.permissions[id] || {}).length > 0) return true;
    if (Object.keys(state.questions[id] || {}).length > 0) return true;
  }
  return false;
}

// Whether a session is actively working. Purely the authoritative activity
// signal (matches opencode web: status.type !== "idle"), recovered on hydrate
// from /session/status. No message-based heuristic — a turn terminated
// mid-generation leaves an incomplete last message but is NOT busy, and must not
// spin forever.
export function sessionWorking(sessionID: string): boolean {
  if (isActivityWorking(state.activity[sessionID])) return true;
  // A running subagent (child) session keeps its parent chain "working" too.
  // OpenCode's /session/status marks only the child (delegate) session busy, so
  // the root/parent would otherwise render idle while its subagent is still
  // generating. Propagate busy/retry up by checking descendants.
  return descendantWorking(sessionID);
}

export function isActivityWorking(act?: string): boolean {
  return act === "busy" || act === "retry";
}

// runningSessionCount counts root sessions whose subtree is currently working —
// the sessions a restart would interrupt. Subagents fold into their root via
// sessionWorking(), so each running task counts once.
export function runningSessionCount(): number {
  let n = 0;
  for (const id of Object.keys(state.sessions)) {
    const s = state.sessions[id];
    if (s?.parentID && state.sessions[s.parentID]) continue; // count roots only
    if (sessionWorking(id)) n++;
  }
  return n;
}

// rootSessionCount counts LIVE root sessions — the total that pairs with
// runningSessionCount() to derive an idle count (roots − running) for the project
// switcher's "X running, Y idle" badge. Uses the SAME orphan-inclusive root
// definition as runningSessionCount() (a session is a root when it has no
// parentID OR its parentID is not in the live store), so a child never counts and
// an orphaned child becomes its own root. Archived sessions are removed from
// state.sessions on the session.delete stream event (stream.ts), so they're
// excluded naturally — the Go RootCount() and this draw from the SAME population.
export function rootSessionCount(): number {
  let n = 0;
  for (const id of Object.keys(state.sessions)) {
    const s = state.sessions[id];
    if (s?.parentID && state.sessions[s.parentID]) continue; // count roots only
    n++;
  }
  return n;
}

function descendantWorking(sessionID: string): boolean {
  // O(subtree) walk over the cached parent→children index (was O(stack × all
  // sessions) via anyDescendantWorking). `seen` preserves the cycle-safety
  // the old anyDescendantWorking carried — never trips on a tree, but kept as
  // a guard against malformed parent loops.
  const idx = childrenIndex();
  const stack = [sessionID];
  const seen = new Set<string>([sessionID]);
  while (stack.length) {
    const id = stack.pop()!;
    const kids = idx[id];
    if (!kids) continue;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (seen.has(c)) continue;
      seen.add(c);
      if (isActivityWorking(state.activity[c])) return true;
      stack.push(c);
    }
  }
  return false;
}

// What the agent is doing right now, surfaced as the Working pill's verb + an
// elapsed-timer base. Pure read of `state` (the caller supplies the ticking
// clock — consumed by ChatView's working-status memos `verb`, `verbElapsed`,
// and `workingAriaLabel` — so this selector stays clock-free and only
// recomputes when the part stream changes).
//
// Returns null when the session isn't working (the pill is hidden). Otherwise,
// in priority order:
//   1. Waiting for approval — a pending permission/question on this session.
//   2. Active tool — the newest running tool part of the last assistant turn.
//   3. Thinking — the newest live reasoning part (no time.end).
//   4. Working — generic fallback (between steps, or a verb we don't model).
export interface CurrentVerb {
  verb: string;
  subject?: string;
  // Epoch-ms the elapsed timer counts from. 0 = unknown (show the verb only).
  // Tool/reasoning use the part's step-level start; Waiting/Working use the
  // current turn's start (newest message created time).
  startMs: number;
}

export function currentVerb(sessionID: string): CurrentVerb | null {
  if (!sessionWorking(sessionID)) return null;
  const sm = state.messages[sessionID];
  // 1) Waiting for operator approval/question — prefer this so a long elapsed
  //    never reads as "stuck" when the agent is actually blocked on the operator.
  if (Object.keys(state.permissions[sessionID] || {}).length > 0 ||
      Object.keys(state.questions[sessionID] || {}).length > 0) {
    return { verb: "Waiting for approval", startMs: turnStartMs(sm) };
  }
  // 2/3) The active verb from the last assistant turn's parts.
  const active = activeVerbFromTurn(sm);
  if (active) return active;
  // 3.5) Tier-A facet for an UNOPENED session: when messages aren't loaded
  //   (the session/subagent was never opened), fall back to the snapshot-seeded
  //   / live-streamed raw tool primitive and format it via the SAME per-tool
  //   toolVerb/toolSubject the opened path uses (Path B2 — Go ships the raw
  //   primitive, TS owns the target picker). Opened sessions (sm present) are
  //   already authoritative above, so this only fires for cold rows; an opened
  //   session never degrades to the facet even if its live scan finds nothing.
  if (!sm) {
    const facet = state.currentVerbs[sessionID];
    if (facet?.tool) {
      const part = { tool: facet.tool, state: facet.state } as unknown as Part;
      const subject = toolSubject(part);
      return {
        verb: toolVerb(facet.tool),
        subject: subject || undefined,
        startMs: facet.state?.time?.start || 0,
      };
    }
  }
  // 4) Fallback.
  return { verb: "Working", startMs: turnStartMs(sm) };
}

// Scan the newest assistant message's parts (newest-first) for the current verb.
// Two passes so a running tool always wins over an older live reasoning part:
//   pass 1 — newest running tool; pass 2 — newest live reasoning.
// Only the newest assistant message is considered — that's the in-flight turn.
function activeVerbFromTurn(sm: SessionMessages | undefined): CurrentVerb | null {
  if (!sm) return null;
  let m: SessionMessages["byId"][string] | undefined;
  for (let mi = sm.order.length - 1; mi >= 0; mi--) {
    const cand = sm.byId[sm.order[mi]];
    if (cand?.info?.role === "assistant") { m = cand; break; }
  }
  if (!m) return null;
  const order = m.partOrder || [];
  for (let i = order.length - 1; i >= 0; i--) {
    const p = m.parts[order[i]];
    if (p?.type === "tool") {
      const st = (p.state || {}) as { status?: string; time?: { start?: number } };
      if (st.status === "running") {
        const subject = toolSubject(p);
        return {
          verb: toolVerb((p.tool as string | undefined) ?? ""),
          subject: subject || undefined,
          startMs: st.time?.start || (p.time?.start as number | undefined) || 0,
        };
      }
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const p = m.parts[order[i]];
    if (p?.type === "reasoning" && !p.time?.end) {
      return { verb: "Thinking", startMs: (p.time?.start as number | undefined) || 0 };
    }
  }
  return null;
}

// The current turn's start: the newest message's created time (the user message
// just sent, or the in-flight assistant message). Used as the elapsed base when
// no specific part bounds the verb (Waiting / generic Working).
function turnStartMs(sm: SessionMessages | undefined): number {
  if (!sm?.order.length) return 0;
  const last = sm.byId[sm.order[sm.order.length - 1]];
  return (last?.info?.time?.created as number | undefined) || 0;
}

// normalizeTodos extracts the todo array from either the bare array or the
// daemon's `{ sessionID, todos }` envelope (snapshot stores the raw properties).
export function normalizeTodos(v: any): TodoItem[] {
  if (Array.isArray(v)) return v as TodoItem[];
  if (v && Array.isArray(v.todos)) return v.todos as TodoItem[];
  return [];
}

// All session ids in a subtree (the session + descendant subagents). Tasks roll
// up like running state does, so a parent's indicator surfaces the todos its
// subagents are working — without having to open each subsession.
//
// Uses the cached parent→children index (see childrenIndex /
// invalidateChildrenIndex below) so the per-call cost is O(subtree), not
// O(all-sessions). At cold mount (~100 sessions × ~100 SessionTree Nodes
// calling sessionNeedsInput) this is the difference between ~10,000
// synchronous ops and ~100.
function subtreeSessionIds(rootID: string): string[] {
  const idx = childrenIndex();
  const out: string[] = [];
  const stack = [rootID];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    const kids = idx[id];
    if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return out;
}

// --- Parent→children index (Fix A: kills the O(N²) cold-mount freeze) -------
//
// subtreeSessionIds / descendantWorking USED to rebuild a `childrenOf` index by
// walking ALL sessions on EVERY call. With ~100 sessions at cold mount and
// ~100 Node components each calling sessionNeedsInput() once, that was ~10,000
// ops in a single synchronous render — the main-thread freeze on Android
// Chrome the operator reported ("page completely freezes until all loading
// finished").
//
// The index is now built lazily on first read after a mutation and reused
// across all subsequent selector calls until invalidated. The THREE production
// mutation sites — applySnapshot (wholesale replace), applySessionEvent
// (session.upsert / session.delete), and switchProject (wholesale replace on
// project switch) — all call invalidateChildrenIndex() after the store update.
// Tests that mutate state.sessions directly must call it too (mirrors the
// existing reconcile({}) reset convention).
//
// Correctness under live updates: the index is a pure function of
// state.sessions keyed on parentID. An orphan child (parentID pointing to a
// session absent from the store) is grouped under the missing parent's ID,
// NOT under "" — so it never appears in a real root's subtree (matches the
// pre-fix subtreeSessionIds semantics exactly).
let cachedChildrenIndex: Record<string, string[]> | null = null;

// Test-only build counter. Used by the perf-correctness test to assert the
// index is built O(1) across many selector calls, not O(N) per call. Cheap to
// maintain (one increment per build).
let childrenIndexBuildCount = 0;
export function __childrenIndexBuildCountForTest(): number {
  return childrenIndexBuildCount;
}
export function __resetChildrenIndexBuildCountForTest(): void {
  childrenIndexBuildCount = 0;
}

/** Invalidate the cached parent→children index. Call after ANY state.sessions
 *  mutation (upsert / delete / wholesale replace). O(1). */
export function invalidateChildrenIndex(): void {
  cachedChildrenIndex = null;
}

// Lazily build (or return the cached) parent→children index. Keyed on
// parentID; sessions with no parentID are NOT in the index (matches the
// pre-fix semantics — they're roots, never someone's child).
function childrenIndex(): Record<string, string[]> {
  if (cachedChildrenIndex) return cachedChildrenIndex;
  const idx: Record<string, string[]> = {};
  for (const id of Object.keys(state.sessions)) {
    const p = state.sessions[id]?.parentID;
    if (p) (idx[p] ||= []).push(id);
  }
  cachedChildrenIndex = idx;
  childrenIndexBuildCount++;
  return idx;
}

// sessionTodos returns the agent todos (OpenCode TodoWrite) for a session AND
// its subagents, in subtree order.
export function sessionTodos(sessionID?: string): TodoItem[] {
  if (!sessionID) return [];
  const out: TodoItem[] = [];
  for (const id of subtreeSessionIds(sessionID)) {
    const items = state.todos[id];
    if (items && items.length) out.push(...items);
  }
  return out;
}

// sessionTodoCounts summarizes the subtree todos for the "Tasks N active · M
// left" indicator: active = in_progress, left = pending + in_progress (i.e. not
// completed/cancelled), total = all. Zeros when there are none.
export function sessionTodoCounts(sessionID?: string): { active: number; left: number; total: number } {
  const items = sessionTodos(sessionID);
  let active = 0;
  let left = 0;
  for (const t of items) {
    const st = t?.status;
    if (st === "in_progress") active++;
    if (st !== "completed" && st !== "cancelled") left++;
  }
  return { active, left, total: items.length };
}
