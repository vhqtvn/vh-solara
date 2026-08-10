import { For, Show } from "solid-js";
import { trayIds } from "../dockview/store";
import {
  targetRecords,
  activeRegistryTarget,
  liveKeysSet,
  selectTab,
} from "../dockview/hostController";
import type { TabRecord } from "../dockview/types";
import { AddServer } from "./AddServer";
import s from "./Tabstrip.module.css";

/**
 * Top FLAT tabstrip: brand + one tab per AttentionTarget record + AddServer +
 * tray badge. This REPLACES the workspace tabstrip (P4 Phase 2). The operator's
 * unit of attention is a SESSION, not a workspace — the strip shows the sessions
 * the operator has intentionally visited (Fork B: explicit-watch), most-recent
 * first.
 *
 * SURVIVAL: clicking a tab calls selectTab → findPaneForServer →
 * hostOps().selectTarget → an SPA-INTERNAL route change (postMessage). The
 * iframe src + element are NEVER touched (proven mechanism; the e2e asserts
 * iframe identity survives a tab switch). Workspaces stay INTERNAL (the overlay
 * stack of DockviewHost-per-workspace is the rendering layer; it is NOT removed
 * — only the primary nav chrome changed).
 *
 * HONEST STATUS (load-bearing): a needs-you badge shows ONLY when a live pane
 * is currently reporting that exact target (liveKeys) AND its last-known
 * attention is needs_reply/needs_permission. A tab whose pane navigated away is
 * NOT live → no badge, dimmed/stale styling — it never claims current attention
 * it cannot honestly back. The Q1-C document-liveness dot (per-pane header) is
 * a separate signal and is not shown here.
 *
 * What was REMOVED vs the workspace tabstrip (kept internal, not destroyed):
 * the add-workspace "+", the workspace delete/rename, the per-workspace
 * needs-you aggregate badge. The per-target indicators here REPLACE that badge.
 */

export function Tabstrip() {
  return (
    <div class={s.tabstrip}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      <div class={s.tabs}>
        <For each={targetRecords()}>
          {(rec) => <TargetTab rec={rec} />}
        </For>
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

/** Stable key for a record (matches the registry's targetKey encoding). */
function recKey(rec: TabRecord): string {
  return `${rec.target.serverId}\u0000${rec.target.dir}\u0000${rec.target.session}`;
}

/** One target tab. Honest status: live badge only when a live pane currently
 *  reports this exact target AND its attention is needs_*. Stale (non-live)
 *  tabs show dimmed styling and NO badge. Clicking selects via the survival-safe
 *  SPA-internal route change. */
function TargetTab(props: { rec: TabRecord }) {
  const active = () => {
    const at = activeRegistryTarget();
    return !!at && recKey(props.rec) === recKeyOf(at);
  };
  const live = () => liveKeysSet().has(recKey(props.rec));
  // The needs-you badge shows ONLY when live AND the last-known attention is
  // needs_reply/needs_permission. A stale record never shows a badge (it must
  // not claim current attention it cannot honestly back).
  const need = () =>
    live() &&
    !!props.rec.liveStatus &&
    (props.rec.liveStatus.attention === "needs_reply" ||
      props.rec.liveStatus.attention === "needs_permission");
  // Activity indicator dot for live tabs only (cheap, GPU-safe). Shows the
  // current activity for a live target; nothing for a stale one.
  const activityClass = () => {
    if (!live() || !props.rec.liveStatus) return "";
    switch (props.rec.liveStatus.activity) {
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

  const onSelect = () => {
    // selectTab resolves the pane bound to this target's server and issues a
    // survival-safe selectTarget (SPA-internal route; no iframe.src change).
    // No-op when no pane is bound (the tab is effectively unselectable — the
    // server's pane was closed). Phase 3 may add a disabled visual.
    selectTab({
      serverId: props.rec.target.serverId,
      dir: props.rec.target.dir,
      session: props.rec.target.session,
    });
  };

  return (
    <div
      classList={{
        [s.tab]: true,
        [s.tabActive]: active(),
        [s.tabStale]: !live(),
      }}
      data-testid="target-tab"
      data-server={props.rec.target.serverId}
      data-dir={props.rec.target.dir}
      data-session={props.rec.target.session}
      data-active={active() ? "1" : "0"}
      data-live={live() ? "1" : "0"}
      data-pinned={props.rec.pinned ? "1" : "0"}
      role="tab"
      tabindex={0}
      aria-selected={active() ? "true" : "false"}
      aria-label={tabLabel(props.rec, live())}
      title={tabTitle(props.rec, live())}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        class={`${s.actDot} ${activityClass()}`}
        data-testid="target-activity"
      />
      <span class={s.tabLabel} title={props.rec.title || props.rec.target.serverId}>
        {props.rec.title || fallbackHost(props.rec.target.serverId)}
      </span>
      <Show when={need()}>
        <span
          class={s.needBadge}
          data-testid="target-needs-you"
          title={
            props.rec.liveStatus?.attention === "needs_permission"
              ? "Permission requested"
              : "Reply needed"
          }
        >
          {props.rec.liveStatus?.attention === "needs_permission" ? "！" : "?"}
        </span>
      </Show>
    </div>
  );
}

/** Key-from-a-target helper (avoids importing targetKey for the active match). */
function recKeyOf(t: { serverId: string; dir: string; session: string }): string {
  return `${t.serverId}\u0000${t.dir}\u0000${t.session}`;
}

function tabLabel(rec: TabRecord, live: boolean): string {
  const host = fallbackHost(rec.target.serverId);
  const title = rec.title || host;
  return live ? title : `${title} (stale)`;
}

function tabTitle(rec: TabRecord, live: boolean): string {
  const host = fallbackHost(rec.target.serverId);
  const title = rec.title || host;
  const status = rec.liveStatus
    ? ` · ${rec.liveStatus.attention}/${rec.liveStatus.activity}`
    : "";
  return live ? `${title}${status}` : `${title} (stale — not currently displayed)`;
}

function fallbackHost(serverId: string): string {
  try {
    const h = new URL(serverId).host;
    return h || serverId;
  } catch {
    return serverId;
  }
}
