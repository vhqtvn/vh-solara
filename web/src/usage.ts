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

// Per-turn model performance for a SETTLED assistant turn: pure output decode
// tok/s and time-to-first-token (TTFT), surfaced behind a hover ⓘ on the
// message footer. OpenCode has no native rate/TTFT field, but the daemon
// forwards the raw JSON untouched (pkg/state/store.go), so TextPart/ReasoningPart
// time.start/.end and info.tokens.output arrive live even though our typed
// envelope doesn't name them. tok/s is the PURE decode rate = output tokens over
// the union of text-part [time.start,time.end] intervals (excludes TTFT, tools,
// shell, subagents, and reasoning time). Returns null for non-assistant or
// in-flight (no time.completed) turns — call this ONLY for settled assistant
// messages so it never touches the streaming hot loop.
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

  // TTFT = earliest TextPart/ReasoningPart time.start − info.time.created.
  // OpenCode v2 KEEPS per-part `time` (TextPart.time / ReasoningPart.time in
  // packages/core/src/session/legacy.ts SessionLegacy), so this stays valid.
  let firstStart: number | null = null;
  for (const pid of m.partOrder) {
    const p = m.parts[pid];
    if (!p || (p.type !== "text" && p.type !== "reasoning")) continue;
    const s = p.time?.start;
    if (typeof s === "number" && (firstStart === null || s < firstStart)) firstStart = s;
  }
  const ttftMs = firstStart !== null ? Math.max(0, firstStart - created) : null;

  // Pure output decode rate = tokens.output / (union of TEXT-part decode
  // intervals [time.start, time.end]). Upstream sets TextPart.time.start/.end
  // via live AI-SDK stream events (packages/opencode/src/session/processor.ts),
  // bracketing first→last decoded token — the only decode-proximate timing on
  // the wire (no provider-level decode-duration field exists). The union (merge
  // of overlapping intervals) EXCLUDES TTFT, tool/shell/subagent state.time, and
  // reasoning-part time: only actual output decoding counts.
  //
  // NUMERATOR CAVEAT: wire tokens.output is already visible-only upstream
  // (reasoning subtracted in getUsage) EXCEPT for providers that don't break
  // out reasoning (e.g. Anthropic), where output is reasoning-inclusive and
  // cannot be separated from the wire alone — documented here, not fixable.
  const output = info.tokens?.output;
  let tokPerSec: number | null = null;
  if (typeof output === "number" && output > 0) {
    const intervals: Array<[number, number]> = [];
    let incomplete = false; // a text part has start but no end → decode not finalized
    for (const pid of m.partOrder) {
      const p = m.parts[pid] as any;
      if (!p || p.type !== "text") continue;
      const s = p.time?.start;
      const e = p.time?.end;
      if (typeof s !== "number") continue; // no timing → not a decode interval
      if (typeof e !== "number") {
        // start present, end missing → in-flight/aborted → suppress the rate.
        incomplete = true;
        break;
      }
      // Drop zero/negative-duration intervals (start >= end): they encode no
      // decode-active time (single-token / clock-jitter parts) and would
      // otherwise divide by ~0. Deterministic drop, no minimum floor applied.
      if (e > s) intervals.push([s, e]);
    }
    if (!incomplete) {
      const unionMs = unionIntervalMs(intervals);
      tokPerSec = unionMs > 0 ? output / (unionMs / 1000) : null;
    }
  }

  return { tokPerSec, ttftMs, output: typeof output === "number" ? output : 0 };
}

// Union duration (ms) of [start, end] intervals: sort then merge overlaps so the
// gap between two text parts (e.g. an intervening tool call) is NOT counted as
// decode time. Touching intervals (start === prev end) merge with no gap, which
// yields the same total as summing them separately.
function unionIntervalMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e; // extend the merged run
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
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
