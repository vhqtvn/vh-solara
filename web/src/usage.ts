// Shared context-window usage for a session: the most recent assistant turn's
// tokens (incl. cache) against the selected model's context limit. Used by the
// header Usage pill and the session inspector.
import { state } from "./sync";
import { findModel, selectionFor } from "./models";
import type { MessageView } from "./types";

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

// Per-turn model performance for a SETTLED assistant turn: output tok/s and
// time-to-first-token (TTFT), surfaced behind a hover ⓘ on the message footer.
// OpenCode has no native rate/TTFT field, but the daemon forwards the raw JSON
// untouched (pkg/state/store.go), so TextPart/ReasoningPart time.start and
// info.tokens.output arrive live even though our typed envelope doesn't name
// them. Returns null for non-assistant or in-flight (no time.completed) turns —
// call this ONLY for settled assistant messages so it never touches the
// streaming hot loop.
export interface TurnStats {
  tokPerSec: number | null;
  ttftMs: number | null;
  output: number;
}

export function turnStats(m: MessageView): TurnStats | null {
  const info = m.info as any;
  if (info.role !== "assistant") return null;
  const created = info.time?.created;
  const completed = info.time?.completed;
  if (!created || !completed) return null; // completed assistant turns only

  // TTFT derives from TextPart/ReasoningPart time.start; v2 schema (not yet
  // served) drops per-part time — revisit if/when switched.
  let firstStart: number | null = null;
  for (const pid of m.partOrder) {
    const p = m.parts[pid];
    if (!p || (p.type !== "text" && p.type !== "reasoning")) continue;
    const s = p.time?.start;
    if (typeof s === "number" && (firstStart === null || s < firstStart)) firstStart = s;
  }
  const ttftMs = firstStart !== null ? firstStart - created : null;

  const output = info.tokens?.output;
  const durMs = completed - created; // full turn (completed − created)
  const tokPerSec =
    typeof output === "number" && output > 0 && durMs > 0 ? output / (durMs / 1000) : null;

  return { tokPerSec, ttftMs, output: typeof output === "number" ? output : 0 };
}

// Format the per-turn perf tooltip ("42.3 tok/s · 380ms TTFT"). Returns "" when
// neither value is available so callers can gate a single <Show>.
export function fmtTurnStats(s: TurnStats): string {
  const parts: string[] = [];
  if (s.tokPerSec != null) parts.push(`${s.tokPerSec.toFixed(1)} tok/s`);
  if (s.ttftMs != null) {
    parts.push(s.ttftMs >= 1000 ? `${(s.ttftMs / 1000).toFixed(2)}s TTFT` : `${Math.round(s.ttftMs)}ms TTFT`);
  }
  return parts.join(" · ");
}
