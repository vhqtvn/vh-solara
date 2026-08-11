import { For, Show, createEffect, createSignal } from "solid-js";
import { panes, focusedId, trayIds, hostOps } from "../dockview/store";
import type { PaneVm } from "../dockview/types";
import { AddServer } from "./AddServer";
import s from "./Tabstrip.module.css";

/**
 * Top FLAT tabstrip (tabs = panes = windows model): brand + one tab per PANE +
 * AddServer + tray badge. The operator's unit of attention is a WINDOW (a pane),
 * not a session — each tab IS a pane (browser-tab style). This REPLACES the
 * session-tab model (targetRegistry-over-persistent-panes) that was rejected
 * after on-device operator testing.
 *
 * OPERATOR POINTS (1-5, authoritative):
 *  #1 TAB TITLE = the pane's `label` (server/project from params.label), NOT
 *     the session title. The label is the prefix that identifies the server.
 *  #2 RENAME = edit the label inline (double-click → input → Enter/blur commits,
 *     Escape cancels). Persists via scheduleSave. SURVIVAL-SAFE: rename mutates
 *     the label via updateParameters WITHOUT remounting the pane/reloading the
 *     iframe (mirrors the renameWorkspace field-only mutation pattern).
 *  #3 NO SESSION TITLE in the tab. The session title drove tabs that were too
 *     long and hid the server identity. Dropped entirely.
 *  #4 ADD prefill: the AddServer form prefills the current pane's server URL
 *     (handled in AddServer.tsx).
 *  #5 CLOSE = dispose the pane (closePane → removePanel). This DESTROYS the
 *     iframe — that is the operator's intent (close = close window). NOT a
 *     survival violation (survival = layout ops don't reload; close is an
 *     explicit destroy). Closing to empty is allowed (the empty-state overlay
 *     shows — the browser-tab "new tab page" equivalent).
 *
 * SELECT = activate the pane (focusPane → setActive); visibility/focus ONLY;
 * the iframe stays mounted; survival-safe (assertSurvived holds across select).
 *
 * NEEDS-YOU BADGE = the pane's current session attention (P1 status bridge,
 * per-pane already). Shows ONLY when the pane has a live status with
 * needs_reply/needs_permission. Honest-status is naturally satisfied: the
 * status is per-pane and always reflects the latest reported session (it is
 * overwritten on navigate, so a stale session's status never lingers).
 *
 * GPU-SAFE: overflow is a plain horizontal scroll. NO mask-image,
 * backdrop-filter, or animated gradients (Firefox/WebRender GPU rules). The
 * activity dot is a static colored circle (no animation). The needs-you badge
 * is a static rounded rect.
 */
export function Tabstrip() {
  return (
    <div class={s.tabstrip}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      <div class={s.tabs} data-testid="pane-tabs">
        <For each={panes()}>
          {(pane) => <PaneTab pane={pane} />}
        </For>
        <Show when={panes().length === 0}>
          <span class={s.emptyHint} data-testid="pane-tabs-empty">
            No servers open. Click + Add server to connect.
          </span>
        </Show>
      </div>
      <AddServer />
      <Show when={trayIds().length > 0}>
        <span class={s.trayBadge} title="Collapsed panes (active workspace)">
          tray: {trayIds().length}
        </span>
      </Show>
    </div>
  );
}

/**
 * One pane tab. Title = pane.label (operator point #1). Select = focusPane
 * (survival-safe). Close = closePane (dispose, operator point #5). Rename =
 * inline double-click edit (operator point #2, survival-safe). Needs-you badge
 * = pane.status?.attention (P1, honest per-pane).
 */
function PaneTab(props: { pane: PaneVm }) {
  let tabEl!: HTMLDivElement;
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const active = () => props.pane.id === focusedId();

  // Needs-you badge: ONLY when the pane has a live status with needs_reply or
  // needs_permission. Honest by construction (the status is always the latest
  // reported session for THIS pane — it is overwritten on navigate, so a stale
  // session's attention never lingers on this tab).
  const need = () =>
    !!props.pane.status &&
    (props.pane.status.attention === "needs_reply" ||
      props.pane.status.attention === "needs_permission");

  // Activity dot: cheap static colored circle (GPU-safe). Communicates the
  // pane's current session activity. Distinct from the Q1-C document-liveness
  // indicator (per-pane header) and from the needs-you badge.
  const activityClass = () => {
    if (!props.pane.status) return "";
    switch (props.pane.status.activity) {
      case "running":
        return s.actRunning;
      case "error":
        return s.actError;
      case "done_unread":
        return s.actUnread;
      default:
        return "";
    }
  };

  // scrollIntoView on the active transition so selecting a partially-offscreen
  // tab surfaces it WITHOUT jumping the strip.
  createEffect(() => {
    if (active() && tabEl) {
      tabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  });

  const onSelect = () => {
    hostOps()?.focusPane?.(props.pane.id);
  };

  // CLOSE (operator point #5): dispose the pane. This DESTROYS the iframe —
  // correct (close = close window). stopPropagation so closing does not select.
  // Survival of OTHER panes is unaffected (Dockview keeps them mounted).
  const onClose = (e: MouseEvent) => {
    e.stopPropagation();
    hostOps()?.closePane?.(props.pane.id);
  };

  // RENAME (operator point #2): double-click the label to edit inline.
  const startRename = (e: MouseEvent) => {
    e.stopPropagation();
    setDraft(props.pane.label);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing()) return;
    const trimmed = draft().trim();
    setEditing(false);
    if (trimmed && trimmed !== props.pane.label) {
      hostOps()?.renamePane?.(props.pane.id, trimmed);
    }
  };

  const cancelRename = () => {
    setEditing(false);
  };

  return (
    <div
      ref={tabEl}
      classList={{
        [s.tab]: true,
        [s.tabActive]: active(),
      }}
      data-testid="pane-tab"
      data-tab-pane-id={props.pane.id}
      data-active={active() ? "1" : "0"}
      data-label={props.pane.label}
      role="tab"
      tabindex={0}
      aria-selected={active() ? "true" : "false"}
      aria-label={props.pane.label}
      title={props.pane.label}
      onClick={onSelect}
      onDblClick={startRename}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        class={`${s.actDot} ${activityClass()}`}
        data-testid="pane-activity"
      />
      <Show
        when={!editing()}
        fallback={
          <input
            class={s.renameInput}
            data-testid="pane-rename-input"
            value={draft()}
            autofocus
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
        }
      >
        <span class={s.tabLabel} title={props.pane.label}>
          {props.pane.label}
        </span>
      </Show>
      <Show when={need()}>
        <span
          class={s.needBadge}
          data-testid="pane-needs-you"
          title={
            props.pane.status?.attention === "needs_permission"
              ? "Permission requested"
              : "Reply needed"
          }
        >
          {props.pane.status?.attention === "needs_permission" ? "！" : "?"}
        </span>
      </Show>
      {/* CLOSE (operator point #5): dispose the pane (×). aria-label names the
          pane so screen readers announce "Close <label>". Touch-safe target
          size (32×32 hit area) on coarse pointers. */}
      <button
        type="button"
        class={s.dismissBtn}
        data-testid="pane-close"
        aria-label={`Close ${props.pane.label}`}
        title={`Close ${props.pane.label}`}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
