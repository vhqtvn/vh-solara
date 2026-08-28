// Read-only derived views over the sync store: the parent/subtree walks, the
// working-state rollup, and the per-session model selectors.
// All pure reads of `state` (no mutation, no I/O), so they sit just above the
// store in the dependency graph and everything else can read through them.
import type { Part, SessionMessages } from "../types";
import { toolSubject, toolVerb } from "../lib/toolLabel";
import { state } from "./store";
import { treeNode } from "./treeState";

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
// stamps `agent` on user AND assistant messages — the SENDER stamps user
// messages, which is why the live scan is fresh after every successful send).
// Used to restore the composer's agent per session, the same way the model is
// restored from the last user message, AND to render the per-agent chip in the
// tree.
//
// Precedence: (1) when the session's messages are LOADED (open), the live
// newest-first scan is authoritative — it reflects the newest turn as events
// stream in. (2) If the loaded window contains NO agent-stamped message, fall
// through to the snapshot-seeded `lastAgents` map — NOT to `undefined`. This
// is the 2026-08 silent-flip guard: user messages are agent-stamped, so the
// live scan misses ONLY in the evidence-less window (windowed tail of a
// long-old session, or hydration still in flight); in exactly that window a
// possibly-stale-but-REAL lastAgents entry beats a fabricated config default.
// The old behavior (return undefined here) let the composer resolver fall all
// the way to the config `default_agent` and silently flip an existing session
// onto it. (3) When messages are NOT loaded (cold/un-opened session on a
// fresh tree), the snapshot-seeded lastAgents map renders the chip immediately
// without opening the session.
export function sessionLastAgent(id: string): string | undefined {
  const sm = state.messages[id];
  if (sm) {
    for (let i = sm.order.length - 1; i >= 0; i--) {
      const info: any = sm.byId[sm.order[i]]?.info;
      if (info?.agent) return info.agent as string;
    }
    return state.lastAgents[id]; // loaded window has no agent stamp yet — server-computed facet, stale-real > fabricated-default
  }
  return state.lastAgents[id];
}

// True when a session has a pending permission/question (a typed reply it's
// blocked on) — either its OWN request or a descendant's, rolled up by the
// server. Reactive — clears itself when the request is resolved. Surfaced in
// the session list and used to auto-ack the in-app nudge.
//
// P1 (C2): trusts the SERVER-COMPUTED flags.subtreeNeedsInput facet on the tree
// node (the same source TreeRow uses) — NO client-side subtree walk. For a node
// NOT resident in the tree flat map, falls back to the node's OWN pending
// permission/question only (Q1 self-only fallback — a passive status lookup
// must never trigger implicit tree expansion or walk the detail-store topology).
export function sessionNeedsInput(sessionID: string): boolean {
  const node = treeNode(sessionID);
  if (node) {
    return node.flags.pendingInput || !!node.flags.subtreeNeedsInput;
  }
  return (
    Object.keys(state.permissions[sessionID] || {}).length > 0 ||
    Object.keys(state.questions[sessionID] || {}).length > 0
  );
}

// Whether a session is actively working (busy/retry). Matches opencode web:
// status.type !== "idle". No message-based heuristic — a turn terminated
// mid-generation leaves an incomplete last message but is NOT busy, and must
// not spin forever.
//
// P1 (C1): trusts the SERVER-COMPUTED flags.subtreeBusy facet on the tree node
// (the same source treeSelectors.working() uses for the tree row) — NO client-
// side subtree walk. A running subagent (child) keeps its parent chain "working"
// because the server rolls busy/retry up into subtreeBusy on every ancestor.
// For a node NOT resident in the tree flat map, falls back to the node's OWN
// activity only (Q1 self-only fallback — never walk the detail-store topology).
//
// SELF activity is read from state.activity[id] (NOT treeNode().activity) so the
// reactive flush aligns with the cross-stream completion bridge: that bridge
// stamps time.completed on the last assistant message in the SAME produce() that
// updates state.activity[id]. Reading state.activity here keeps .working-text
// unmounting in the same Solid flush as .md-stream (time.completed → settled),
// so neither outlives the other regardless of cross-stream event ordering.
export function sessionWorking(sessionID: string): boolean {
  if (isActivityWorking(state.activity[sessionID])) return true;
  const node = treeNode(sessionID);
  return !!node?.flags.subtreeBusy;
}

export function isActivityWorking(act?: string): boolean {
  return act === "busy" || act === "retry";
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

