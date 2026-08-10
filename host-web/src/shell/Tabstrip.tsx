import { For, Show, createEffect } from "solid-js";
import { trayIds, boundOrigins } from "../dockview/store";
import {
  targetRecords,
  activeRegistryTarget,
  liveKeysSet,
  selectTab,
  dismissTarget,
} from "../dockview/hostController";
import type { TabRecord } from "../dockview/types";
import { AddServer } from "./AddServer";
import s from "./Tabstrip.module.css";

/**
 * Top FLAT tabstrip: brand + one tab per AttentionTarget record + AddServer +
 * tray badge. This REPLACES the workspace tabstrip (P4 Phase 2). The operator's
 * unit of attention is a SESSION, not a workspace — the strip shows the sessions
 * the operator has intentionally visited (Fork B: explicit-watch), in STABLE
 * INSERTION ORDER (decision #1: new tabs append; re-visit does not move).
 *
 * SURVIVAL: clicking a tab calls selectTab → findPaneAndWorkspaceForServer →
 * (activate owning workspace, CSS-only) → hostOps().selectTarget → an
 * SPA-INTERNAL route change (postMessage). The iframe src + element are NEVER
 * touched (proven mechanism; the e2e asserts iframe identity survives a tab
 * switch). Workspaces stay INTERNAL (the overlay stack of
 * DockviewHost-per-workspace is the rendering layer; it is NOT removed — only
 * the primary nav chrome changed).
 *
 * HONEST STATUS (load-bearing): a needs-you badge shows ONLY when a live pane
 * is currently reporting that exact target (liveKeys) AND its last-known
 * attention is needs_reply/needs_permission. A tab whose pane navigated away is
 * NOT live → no badge, dimmed/stale styling — it never claims current attention
 * it cannot honestly back.
 *
 * DECISION #4 (dismiss): every tab has a `×` that removes the registry record
 * ONLY (NOT the pane/session/iframe/workspace). Visible always on coarse
 * pointers (touch); hover/focus-revealed on fine pointers. stopPropagation so
 * dismissing does not select the tab.
 *
 * DECISION #7 (unavailable + cross-workspace + overflow): a tab whose server
 * has NO bound pane (boundOrigins) is aria-disabled + explanatory (click no-op).
 * scrollIntoView({inline:'nearest'}) on the active tab so selecting a partially-
 * offscreen tab surfaces it without jumping the strip. Overflow is a plain
 * horizontal scroll (NO mask-image/backdrop/animated gradients — Firefox/
 * WebRender GPU rules).
 */

export function Tabstrip() {
  return (
    <div class={s.tabstrip}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      <div class={s.tabs} data-testid="target-tabs">
        <For each={targetRecords()}>
          {(rec) => <TargetTab rec={rec} />}
        </For>
        {/* Empty-state hint (decision #7 holistic): no tabs yet → tell the
            operator how a tab appears (Fork B: open a session in a server
            pane). Shown inline so the strip is never a confusing blank gap. */}
        <Show when={targetRecords().length === 0}>
          <span class={s.emptyHint} data-testid="target-tabs-empty">
            No session tabs yet. Open a session in a server pane to add it here.
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

/** Stable key for a record (matches the registry's targetKey encoding). */
function recKey(rec: TabRecord): string {
  return `${rec.target.serverId}\u0000${rec.target.dir}\u0000${rec.target.session}`;
}

/** One target tab. Honest status: live badge only when a live pane currently
 *  reports this exact target AND its attention is needs_*. Stale (non-live)
 *  tabs show dimmed styling and NO badge. Clicking selects via the survival-safe
 *  SPA-internal route change. Dismiss (×) removes the registry record only.
 *  Unavailable (no bound pane) → aria-disabled + no-op click. */
function TargetTab(props: { rec: TabRecord }) {
  // Ref for scrollIntoView on active (decision #7 overflow).
  let tabEl!: HTMLDivElement;

  const active = () => {
    const at = activeRegistryTarget();
    return !!at && recKey(props.rec) === recKeyOf(at);
  };
  const live = () => liveKeysSet().has(recKey(props.rec));
  // DECISION #7 (unavailable-server): the tab's server has a bound pane iff its
  // origin is in boundOrigins() (reactive — re-evaluates when panes open/close).
  // When unavailable the tab is aria-disabled + explanatory; click is a no-op.
  const available = () => boundOrigins().has(props.rec.target.serverId);
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

  // DECISION #7 (overflow): when this tab becomes active, scroll it into view
  // (inline:'nearest') so selecting a partially-offscreen tab surfaces it
  // WITHOUT jumping the strip. Runs only on the active transition.
  createEffect(() => {
    if (active() && tabEl) {
      tabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  });

  const onSelect = () => {
    // Unavailable-server (decision #7): no bound pane → no-op. Do NOT issue a
    // selectTarget (nothing to post to) and do NOT mutate any iframe.
    if (!available()) return;
    // selectTab resolves the pane (+ owning workspace, activating it first if
    // needed) and issues a survival-safe selectTarget (SPA-internal route; no
    // iframe.src change). Sets the target active via visit().
    selectTab({
      serverId: props.rec.target.serverId,
      dir: props.rec.target.dir,
      session: props.rec.target.session,
    });
  };

  // DECISION #4 (dismiss): remove the registry record ONLY. stopPropagation so
  // the click does not bubble to the tab's onSelect (dismissing ≠ selecting).
  // NO pane/session/iframe/workspace mutation — dismissTarget clears the record
  // (+ clears active if this was the active tab). Persists via registry save.
  const onDismiss = (e: MouseEvent) => {
    e.stopPropagation();
    dismissTarget({
      serverId: props.rec.target.serverId,
      dir: props.rec.target.dir,
      session: props.rec.target.session,
    });
  };

  return (
    <div
      ref={tabEl}
      classList={{
        [s.tab]: true,
        [s.tabActive]: active(),
        [s.tabStale]: !live(),
        [s.tabUnavailable]: !available(),
      }}
      data-testid="target-tab"
      data-server={props.rec.target.serverId}
      data-dir={props.rec.target.dir}
      data-session={props.rec.target.session}
      data-active={active() ? "1" : "0"}
      data-live={live() ? "1" : "0"}
      data-available={available() ? "1" : "0"}
      data-pinned={props.rec.pinned ? "1" : "0"}
      role="tab"
      tabindex={available() ? 0 : -1}
      aria-selected={active() ? "true" : "false"}
      aria-disabled={available() ? undefined : "true"}
      aria-label={tabLabel(props.rec, live(), available())}
      title={tabTitle(props.rec, live(), available())}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (!available()) return;
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
      {/* DECISION #4: dismiss (×). aria-label names the tab so screen readers
          announce "Remove <title> from session tabs". Touch-safe target size
          (32×32 hit area) on coarse pointers. */}
      <button
        type="button"
        class={s.dismissBtn}
        data-testid="target-dismiss"
        aria-label={`Remove ${props.rec.title || fallbackHost(props.rec.target.serverId)} from session tabs`}
        title={`Remove from session tabs`}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

/** Key-from-a-target helper (avoids importing targetKey for the active match). */
function recKeyOf(t: { serverId: string; dir: string; session: string }): string {
  return `${t.serverId}\u0000${t.dir}\u0000${t.session}`;
}

function tabLabel(rec: TabRecord, live: boolean, available: boolean): string {
  const host = fallbackHost(rec.target.serverId);
  const title = rec.title || host;
  if (!available) return `${title} (server offline)`;
  return live ? title : `${title} (stale)`;
}

function tabTitle(rec: TabRecord, live: boolean, available: boolean): string {
  const host = fallbackHost(rec.target.serverId);
  const title = rec.title || host;
  const status = rec.liveStatus
    ? ` · ${rec.liveStatus.attention}/${rec.liveStatus.activity}`
    : "";
  if (!available) return `${title} (server has no open pane — open it to resume)`;
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
