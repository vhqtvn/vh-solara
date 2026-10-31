// messageMeta — extracted from ChatView.tsx (C1 concern).
//
// Pure message-label/metadata helpers: they take a plain message `info` (or a
// role string) and return a display string (or null). No SolidJS owner, no
// accessor, no signal — module-level pure functions. `modelLabel` resolves the
// display name through the shared models store's `findModel`, but it writes
// nothing and carries no reactivity of its own.
//
// The agent/perf badge COMPONENTS (MsgAgent, MsgPerf) are NOT moved here: they
// are presentational SolidJS components (Show/createMemo/JSX), not pure helpers,
// and belong to a later component-extraction concern. MsgAgent remains in
// ChatView and imports `agentLabel` from here.
import { findModel } from "../../models";

export function roleLabel(role?: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return role || "";
}

// The agent/subagent that produced an assistant message (e.g. "build", "plan",
// or a custom subagent). Empty for user messages or when none was recorded.
export function agentLabel(info: any): string {
  if (info?.role !== "assistant") return "";
  const a = info.agent ?? info.mode;
  return typeof a === "string" ? a.trim() : "";
}

export function messageError(info: any): string | null {
  const e = info?.error;
  if (!e) return null;
  return e.data?.message || e.name || "error";
}

// P1 never-started (instant self-abort) vocabulary. vh-solara's state layer
// refines an upstream MessageAbortedError row matching the never-started
// signature (≤100 ms, zero parts, zero tokens — opencode finalized the row
// before the run started; pkg/state/never_started.go) into
// error.name="VHSolaraNeverStartedError" with error.data.message carrying the
// user-facing text (single source of truth: Go's neverStartedUserMessage).
// MessageRow renders it through the distinct quiet .msg-never affordance —
// NOT the red .msg-error box — so the operator can tell "opencode aborted
// this turn itself; not my stop; re-sending will likely repeat it" apart from
// a real operator abort. The local literal is only a fallback for rows that
// carry the name without data.message (e.g. hand-built fixtures).
export const NEVER_STARTED_ERROR_NAME = "VHSolaraNeverStartedError";
const neverStartedFallback =
  "Turn never ran: OpenCode aborted this turn before it started — this was not your stop. Re-sending will likely repeat this.";

export function neverStartedNotice(info: any): string | null {
  const e = info?.error;
  if (!e || e.name !== NEVER_STARTED_ERROR_NAME) return null;
  return e.data?.message || neverStartedFallback;
}

// The model that produced an assistant message, resolved to its display name
// (falling back to the raw id). Empty for non-assistant messages or when the
// message carries no model. message.model uses `modelID`; older/flat envelopes
// put it directly on the info — accept either.
export function modelLabel(info: any): string {
  if (info?.role !== "assistant") return "";
  const providerID = info.providerID ?? info.model?.providerID;
  const modelID = info.modelID ?? info.model?.modelID;
  if (!modelID) return "";
  const name = (providerID ? findModel(providerID, modelID)?.name : undefined) || modelID;
  const variant = info.variant ?? info.model?.variant;
  return variant && variant !== "default" ? `${name} · ${variant}` : name;
}

// Assistant cost/token summary, shown once the turn has completed.
export function costLabel(info: any): string {
  if (info?.role !== "assistant" || !info?.time?.completed) return "";
  const parts: string[] = [];
  if (typeof info.cost === "number" && info.cost > 0) parts.push(`$${info.cost.toFixed(4)}`);
  const tok = (info.tokens?.input || 0) + (info.tokens?.output || 0);
  if (tok > 0) parts.push(tok >= 1000 ? `${(tok / 1000).toFixed(1)}k tok` : `${tok} tok`);
  return parts.join(" · ");
}
