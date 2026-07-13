import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { state } from "../sync";
import { findModel, selectionFor } from "../models";
import { openArchiveConfirm } from "../sessionMenu";
import { displayName } from "../projectSettings";
import QuotaPanel from "./QuotaPanel";
import SessionTimingBlock from "./SessionTimingBlock";
import Icon from "./Icon";
import "./SessionInspector.css";

// Whole-session inspector: aggregate cost/token/message stats plus a per-turn
// breakdown. OpenCode exposes no provider quota endpoint, so this reports the
// session's own usage rather than account-wide quota (see notes).
export default function SessionInspector(props: { sessionId: string; onClose: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const sm = () => state.messages[props.sessionId];
  const session = () => state.sessions[props.sessionId];

  function archive() {
    // Route through the shared confirmation dialog (lists all related sessions).
    openArchiveConfirm(props.sessionId, session()?.title || props.sessionId);
    props.onClose();
  }

  const stats = createMemo(() => {
    const s = sm();
    let cost = 0,
      input = 0,
      output = 0,
      reasoning = 0,
      cacheR = 0,
      cacheW = 0,
      assistant = 0,
      user = 0;
    const turns: any[] = [];
    if (s) {
      for (const id of s.order) {
        const i = s.byId[id].info as any;
        if (i.role === "user") user++;
        if (i.role === "assistant") {
          assistant++;
          if (typeof i.cost === "number") cost += i.cost;
          const t = i.tokens || {};
          input += t.input || 0;
          output += t.output || 0;
          reasoning += t.reasoning || 0;
          cacheR += t.cache?.read || 0;
          cacheW += t.cache?.write || 0;
          turns.push({
            id,
            model: i.modelID || i.model?.modelID,
            cost: i.cost,
            tok: (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0),
            time: i.time?.created,
          });
        }
      }
    }
    return { cost, input, output, reasoning, cacheR, cacheW, assistant, user, total: s?.order.length || 0, turns };
  });

  const sel = () => selectionFor(props.sessionId);
  const model = () => {
    const s = sel();
    return s ? findModel(s.providerID, s.modelID) : undefined;
  };
  const fmt = (n: number) => n.toLocaleString();
  const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog inspector" role="dialog" aria-label="Session inspector" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <span class="dialog-title">Session inspector</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="dialog-body">
          <div class="insp-sub">{displayName(session()?.title || props.sessionId)}</div>
          <Show when={model()}>
            <div class="insp-sub dim">
              {model()!.name} · {model()!.provider}
              <Show when={model()!.contextK}> · {model()!.contextK}k context</Show>
            </div>
          </Show>

          <div class="insp-grid">
            <div class="insp-stat">
              <span class="insp-stat-val">${stats().cost.toFixed(4)}</span>
              <span class="insp-stat-key">Total cost</span>
            </div>
            <div class="insp-stat">
              <span class="insp-stat-val">{stats().total}</span>
              <span class="insp-stat-key">Messages</span>
            </div>
            <div class="insp-stat">
              <span class="insp-stat-val">{fmtTok(stats().input)}</span>
              <span class="insp-stat-key">Input tok</span>
            </div>
            <div class="insp-stat">
              <span class="insp-stat-val">{fmtTok(stats().output)}</span>
              <span class="insp-stat-key">Output tok</span>
            </div>
            <Show when={stats().reasoning > 0}>
              <div class="insp-stat">
                <span class="insp-stat-val">{fmtTok(stats().reasoning)}</span>
                <span class="insp-stat-key">Reasoning</span>
              </div>
            </Show>
            <Show when={stats().cacheR + stats().cacheW > 0}>
              <div class="insp-stat">
                <span class="insp-stat-val">{fmtTok(stats().cacheR + stats().cacheW)}</span>
                <span class="insp-stat-key">Cache R/W</span>
              </div>
            </Show>
          </div>

          <Show when={stats().turns.length > 0}>
            <div class="insp-section">Per turn</div>
            <div class="insp-turns">
              <For each={stats().turns}>
                {(t, i) => (
                  <div class="insp-turn">
                    <span class="insp-turn-n">#{i() + 1}</span>
                    <span class="insp-turn-model">{t.model || "—"}</span>
                    <span class="insp-turn-tok">{fmt(t.tok)} tok</span>
                    <Show when={typeof t.cost === "number" && t.cost > 0}>
                      <span class="insp-turn-cost">${t.cost.toFixed(4)}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="insp-section">Provider quota</div>
          <QuotaPanel />

          <div class="insp-section">Cold-open timing</div>
          <SessionTimingBlock sessionId={props.sessionId} />

          <div class="insp-section">Manage</div>
          <button type="button" class="insp-archive" onClick={archive}>
            <Icon name="layers" size={14} /> Archive session
            <span class="insp-archive-note">(with all subsessions)</span>
          </button>

          <p class="insp-note">
            Session totals above are for this session only; provider quota is account-wide, read live
            from each provider's usage API via your OpenCode credentials. Archiving removes a session
            and its subsessions from the live tree — browse or restore them from the sidebar's Archived.
          </p>
        </div>
      </div>
    </div>
  );
}
