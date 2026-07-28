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
