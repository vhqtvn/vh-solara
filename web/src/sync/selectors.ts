// Read-only derived views over the sync store: the parent/subtree walks, the
// working-state rollup, todo aggregation, and the per-session model selectors.
// All pure reads of `state` (no mutation, no I/O), so they sit just above the
// store in the dependency graph and everything else can read through them.
import type { SessionMessages, TodoItem } from "../types";
import { anyDescendantWorking } from "../lib/reduce";
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
export function sessionModel(id: string): ModelRefLite | undefined {
  const m = state.sessions[id]?.model;
  const modelID = m?.modelID ?? m?.id;
  return m?.providerID && modelID ? { providerID: m.providerID, modelID, variant: m.variant } : undefined;
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

function descendantWorking(sessionID: string): boolean {
  return anyDescendantWorking(state.sessions, state.activity, sessionID, isActivityWorking);
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
function subtreeSessionIds(rootID: string): string[] {
  const childrenOf: Record<string, string[]> = {};
  for (const id of Object.keys(state.sessions)) {
    const p = state.sessions[id]?.parentID;
    if (p) (childrenOf[p] ||= []).push(id);
  }
  const out: string[] = [];
  const stack = [rootID];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const c of childrenOf[id] || []) stack.push(c);
  }
  return out;
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
