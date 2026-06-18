// Shared context-window usage for a session: the most recent assistant turn's
// tokens (incl. cache) against the selected model's context limit. Used by the
// header Usage pill and the session inspector.
import { state } from "./sync";
import { findModel, selectionFor } from "./models";

export interface ContextUsage {
  used: number;
  limit: number;
  pct: number | null;
}

export function contextUsage(sessionId: string): ContextUsage | null {
  const sm = state.messages[sessionId];
  if (!sm) return null;
  // Walk back to the most recent assistant turn that actually has token counts.
  // The streaming turn carries an empty (but truthy) `tokens: {}` until it
  // completes, so we skip any turn whose token total is still zero.
  for (let i = sm.order.length - 1; i >= 0; i--) {
    const m = sm.byId[sm.order[i]];
    if (m.info.role !== "assistant") continue;
    const t = (m.info as any).tokens || {};
    const used =
      (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
    if (used <= 0) continue;
    const sel = selectionFor(sessionId);
    const model = sel ? findModel(sel.providerID, sel.modelID) : undefined;
    const limit = (model?.contextK || 0) * 1000;
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
    return { used, limit, pct };
  }
  return null;
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}
