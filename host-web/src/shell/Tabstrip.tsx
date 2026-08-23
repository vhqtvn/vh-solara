import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  activeWorkspaceId,
  addWorkspace,
  closeWorkspace,
  needsYouCount,
  needsYouCountFor,
  renameWorkspace,
  setActiveWorkspace,
  trayIds,
  workspaces,
  type Workspace,
} from "../dockview/store";
import { next } from "../attentionNext";
import { AddServer } from "./AddServer";
import { Layouts } from "./Layouts";
import { Settings } from "./Settings";
import s from "./Tabstrip.module.css";

/**
 * Top WORKSPACE tabstrip (i3 upper tabs = workspaces): brand + one tab per
 * workspace + "+" + "Add server" + the P3 NEXT hero button. Clicking a tab
 * switches the active workspace — a SURVIVAL-SAFE CSS-visibility-only switch
 * (App.tsx's overlay stack; no host is disposed, no iframe reloads). The "+"
 * creates a new empty workspace.
 *
 * P3 NEXT HERO BUTTON (moved here from the deleted bottom statusbar — operator
 * directive "no [FAB], just a button next to add server is enough"). It is the
 * attention-loop trigger: "which session needs me? → jump". It appears ONLY when
 * the active workspace has a needs-you pane (needsYouCount() > 0; ws-scoped
 * visibility — the locked choice), pulses to draw the eye, and on click calls
 * next() (attentionNext.ts — UNCHANGED): rank → cross-ws → restore-from-tray →
 * keyboard-rule → focus the highest-priority needy pane system-wide. It is the
 * ONLY statusbar element that survived the statusbar removal; everything else
 * (Q1-C liveness dot/label, server count, focus line, layout button, i3 control
 * cluster, attention-hub "N need you · M running" counts, renderer badge) was
 * deleted. next() routes through store.hostOps().next (production-capable — NOT
 * the DEV bridge).
 *
 * This RESTORES the pre-P4 workspace model (commits bd406bd/ca20b0a/497e36e
 * had replaced it with a pane-tab strip; the operator rejected that — tabs were
 * mirroring the visible pane layout, pointless). Workspaces are the i3 unit:
 * named containers you switch between; panes tile WITHIN a workspace.
 *
 * PER-TAB AFFORDANCES:
 *  - DELETE: a × on each tab. Fat-finger-safe two-step inline confirm (first tap
 *    enters a "delete?" state with ✓/✗; second tap confirms; auto-revert after a
 *    short timeout). The last remaining workspace is guarded (× disabled).
 *    Deleting a workspace DESTROYS its panes (intentional; not a survival op).
 *  - RENAME: long-press the label → inline edit. Commit on blur/Enter; cancel on
 *    Esc. Long-press over double-tap (double-tap conflicts with mobile zoom).
 *  - PER-TAB BADGE: needs-you count on EVERY tab (background ws's needy sessions
 *    are the ones the operator can't see). Rounded-rect number, GPU-cheap,
 *    distinct from Q1-C liveness.
 *
 * Layout ops within the active workspace go through the typed HostOps controller
 * surface (store.hostOps), not the DEV-only window.__host test bridge. The
 * statusbar's layout control cluster (split/tabbed/stacked/zoom/close) was
 * removed with the statusbar; the layout overlay (gesture-triggered) is the
 * primary command surface, and the HostOps setLayoutMode/toggleZoom/etc. remain
 * for the DEV bridge + future overlay work.
 */

/** Long-press threshold (ms) to enter rename mode. Long enough that a tap never
 *  triggers it; short enough to feel responsive on touch. */
const RENAME_PRESS_MS = 500;
/** Auto-revert window for the delete two-step confirm (ms). If the operator
 *  doesn't confirm within this window, the tab exits the confirming state. */
const DELETE_CONFIRM_MS = 3500;

export function Tabstrip() {
  return (
    <div class={s.tabstrip}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      <div class={s.tabs} data-testid="ws-tabs">
        <For each={workspaces()}>
          {(ws) => <WorkspaceTab ws={ws} />}
        </For>
      </div>
      <button
        type="button"
        class={s.plus}
        title="Add workspace"
        data-testid="ws-add"
        onClick={() => addWorkspace()}
      >
        +
      </button>
      <AddServer />
      {/* Saved-layouts popover (Layouts.tsx) — the de-confusion slice's new
          tabstrip surface: per-workspace ("this tab") layouts AND whole-session
          ("all tabs") master snapshots, each renamable. The manager moved OUT
          of Settings here (Settings used to carry both "Layout…" and
          "Layouts…" — two near-identical labels, different functions; its
          overlay trigger is now "Edit layout…"). Same tabstrip popover group
          as AddServer + Settings (mutually exclusive). */}
      <Layouts />
      {/* Settings gear (host-chrome popover: Edit layout…, reload + auto-rotate
          toggle). Sits after Layouts in the right cluster; see Settings.tsx. */}
      <Settings />
      {/* P3 NEXT hero button (moved from the deleted bottom statusbar). The
          attention-loop trigger: visible only when the active workspace has a
          needs-you pane (needsYouCount() > 0), pulses to draw the eye, and on
          click calls next() which routes to the highest-priority needy pane
          system-wide. Production-capable (hostOps().next, NOT the DEV bridge).
          GPU-cheap: a slow opacity pulse ONLY (no mask-image / backdrop-filter —
          AGENTS.md Firefox/WebRender rules); honored under prefers-reduced-motion. */}
      <Show when={needsYouCount() > 0}>
        <button
          type="button"
          class={s.nextBtn}
          data-testid="attention-next"
          aria-label="NEXT — needs attention"
          title="Focus the highest-priority session that needs you"
          onClick={() => next()}
        >
          NEXT
        </button>
      </Show>
      <Show when={trayIds().length > 0}>
        <span class={s.trayBadge} title="Collapsed panes (active workspace)">
          tray: {trayIds().length}
        </span>
      </Show>
    </div>
  );
}

/** One workspace tab. Owns its local interaction state: a two-step delete
 *  confirm + a long-press rename edit. Only ONE of confirming/editing is active
 *  at a time (rename cancels confirm and vice versa). */
function WorkspaceTab(props: { ws: Workspace }) {
  const active = () => activeWorkspaceId() === props.ws.id;
  const need = () => needsYouCountFor(props.ws.id);
  // The × is disabled when this is the last remaining workspace (never zero).
  const isLast = () => workspaces().length <= 1;

  // ---- delete two-step confirm ---------------------------------------------
  const [confirming, setConfirming] = createSignal(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const armConfirmTimer = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => setConfirming(false), DELETE_CONFIRM_MS);
  };
  const clearConfirmTimer = () => {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
  };
  const startConfirm = () => {
    if (isLast()) return; // guarded — can't delete the last workspace
    setEditing(false);
    clearPressTimer();
    setConfirming(true);
    armConfirmTimer();
  };
  const cancelConfirm = () => {
    setConfirming(false);
    clearConfirmTimer();
  };
  const confirmDelete = () => {
    clearConfirmTimer();
    setConfirming(false);
    closeWorkspace(props.ws.id);
  };

  // ---- rename via long-press → inline edit ---------------------------------
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let inputEl: HTMLInputElement | undefined;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  const beginEdit = () => {
    clearPressTimer();
    setConfirming(false);
    clearConfirmTimer();
    setDraft(props.ws.name);
    setEditing(true);
    // Focus after the input mounts. queueMicrotask runs after SolidJS renders
    // the <Show> branch. select() highlights the current name so a replacement
    // is one keystroke (touch-friendly).
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  };
  const commitEdit = () => {
    if (!editing()) return;
    const name = draft().trim();
    setEditing(false);
    if (name && name !== props.ws.name) renameWorkspace(props.ws.id, name);
  };
  const cancelEdit = () => {
    setEditing(false);
  };

  // Long-press detection: pointerdown arms a timer; if it elapses while still
  // pressed, enter rename. pointerup/leave/cancel clears an unfired timer so a
  // quick tap never triggers rename.
  const onLabelPointerDown = () => {
    if (editing() || confirming()) return;
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      beginEdit();
    }, RENAME_PRESS_MS);
  };
  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  };

  onCleanup(() => {
    clearConfirmTimer();
    clearPressTimer();
  });

  return (
    <div
      classList={{
        [s.tab]: true,
        [s.tabActive]: active(),
        [s.tabConfirming]: confirming(),
      }}
      data-testid="ws-tab"
      data-workspace={props.ws.id}
      data-active={active() ? "1" : "0"}
      data-confirming={confirming() ? "1" : "0"}
      data-editing={editing() ? "1" : "0"}
      // a11y: the tab was a <button> (focusable, Enter/Space to activate). It is
      // now a <div> because nested interactive buttons (×/✓/✗) cannot live
      // inside a <button>. Restore the keyboard + AT semantics explicitly so
      // workspace-switch + rename remain reachable without a pointer.
      role="tab"
      tabindex={editing() ? -1 : 0}
      aria-selected={active() ? "true" : "false"}
      aria-label={props.ws.name}
      // Clicking anywhere on the tab (that isn't a nested button or an active
      // edit/confirm state) switches the workspace. Nested × / ✓ / ✗ buttons
      // stopPropagation so they never trigger a switch. After a long-press
      // enters edit mode, editing() is true and the click is suppressed.
      onClick={() => {
        if (editing() || confirming()) return;
        setActiveWorkspace(props.ws.id);
      }}
      onKeyDown={(e) => {
        if (editing() || confirming()) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActiveWorkspace(props.ws.id);
        }
      }}
    >
      <Show
        when={editing()}
        fallback={
          <Show
            when={confirming()}
            fallback={
              <span
                class={s.tabLabel}
                data-testid="ws-tab-label"
                title={props.ws.name}
                onPointerDown={onLabelPointerDown}
                onPointerUp={clearPressTimer}
                onPointerLeave={clearPressTimer}
                onPointerCancel={clearPressTimer}
              >
                {props.ws.name}
              </span>
            }
          >
            <span class={s.tabConfirmLabel} title="Confirm delete?">
              Delete?
            </span>
          </Show>
        }
      >
        <input
          ref={inputEl}
          class={s.tabInput}
          data-testid="ws-rename-input"
          value={draft()}
          // Stop pointer events from re-entering the long-press arm while typing.
          onPointerDown={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          maxlength={80}
        />
      </Show>

      {/* PER-TAB needs-you badge (EVERY workspace, not just active). A
          background ws's needy sessions are the ones the operator can't see on
          the active grid — surfacing them here is the whole point. Hidden when
          the count is 0. Same rounded-rect number + amber as the prior badge;
          distinct from Q1-C liveness (dot) and the per-pane attention badge. */}
      <Show when={need() > 0}>
        <span
          class={s.needBadge}
          data-testid="ws-needs-you"
          data-workspace={props.ws.id}
          title={`${need()} session${need() === 1 ? "" : "s"} need you`}
        >
          {need()}
        </span>
      </Show>

      {/* Delete affordance. When NOT confirming: a single × (disabled on the
          last ws). When confirming: a ✓ confirm + a ✗ cancel, replacing the ×. */}
      <Show
        when={confirming()}
        fallback={
          <Show when={!editing()}>
            <button
              type="button"
              class={s.tabDel}
              data-testid="ws-delete"
              data-workspace={props.ws.id}
              disabled={isLast()}
              title={
                isLast()
                  ? "Can't delete the last workspace"
                  : `Delete "${props.ws.name}"`
              }
              // stopPropagation so the tap never also switches the workspace.
              onClick={(e) => {
                e.stopPropagation();
                startConfirm();
              }}
            >
              ×
            </button>
          </Show>
        }
      >
        <button
          type="button"
          class={s.tabDelConfirm}
          data-testid="ws-delete-confirm"
          data-workspace={props.ws.id}
          title="Confirm delete"
          onClick={(e) => {
            e.stopPropagation();
            confirmDelete();
          }}
        >
          ✓
        </button>
        <button
          type="button"
          class={s.tabDelCancel}
          data-testid="ws-delete-cancel"
          data-workspace={props.ws.id}
          title="Cancel"
          onClick={(e) => {
            e.stopPropagation();
            cancelConfirm();
          }}
        >
          ✕
        </button>
      </Show>
    </div>
  );
}
