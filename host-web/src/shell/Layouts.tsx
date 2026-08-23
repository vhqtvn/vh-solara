import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import {
  NAMED_LAYOUT_NAME_MAX,
  TAB_TITLE_MAX,
  deleteNamedLayout,
  listMasterLayouts,
  listTabLayouts,
  normalizeLayoutName,
} from "../dockview/namedLayouts";
import { activeWorkspaceId, hostOps, panes, workspaces } from "../dockview/store";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import s from "./Layouts.module.css";

/**
 * SAVED-LAYOUTS popover (tabstrip "Layouts" button) — the manager the
 * operator reported as confusing when it lived inside Settings as "Layouts…"
 * one item under the overlay trigger "Layout…" (two near-identical labels,
 * two different functions; the de-confusion split: the overlay trigger is now
 * Settings → "Edit layout…" and THIS popover owns everything about SAVED
 * layouts).
 *
 * OPEN/CLOSE goes through the shared surface stack (popover.ts) — the same
 * primitive AddServer + Settings use: Escape closes (topmost-only), a
 * pointerdown outside the wrap closes, and the tabstrip group keeps the three
 * popovers mutually exclusive. Known limit (same as every host popover): a
 * pointerdown inside a CROSS-ORIGIN IFRAME never reaches this document, so
 * tapping a pane does not close it — Escape + any host-chrome tap do.
 *
 * TWO SCOPES (segmented toggle, default "This tab"):
 *  - THIS TAB: per-workspace layouts. A save carries BOTH a layout name and a
 *    TAB TITLE (the workspace name applied when the layout loads; defaults to
 *    the current workspace's name). Load is ADDITIVE + safe: the layout
 *    instantiates as a NEW cold-mounted workspace (staged-slot path; fromJSON
 *    at mount, never on a live tree) named after the TAB TITLE — existing
 *    workspaces untouched.
 *  - ALL TABS: master snapshots of the WHOLE session (every workspace's name
 *    + arrangement + which was active). Load is DESTRUCTIVE (replaces the
 *    session) → a two-step inline confirm on the Load button (the
 *    workspace-delete confirm pattern: first tap arms "Replace all tabs?" +
 *    ✓/✕, auto-reverts after ~3.5s).
 *
 * Rows support RENAME via an explicit pencil button (chosen over
 * tap-name-to-edit: the name is inside the row's Load button — a tap there
 * must LOAD, not edit; the pencil is unambiguous and touch-friendly). A
 * rename COLLISION is refused by storage + surfaced as an inline error (no
 * silent overwrite). Delete stays single-tap × (the v1 default — a saved
 * layout is a re-creatable snapshot).
 *
 * All saves/loads route through the typed HostOps surface (store.hostOps —
 * production-capable), NOT the DEV bridge. GPU-cheap CSS only (plain
 * bg/border/shadow — no mask-image/backdrop-filter/contain).
 */

/** Auto-revert window for the master-load two-step confirm (ms) — the same
 *  ~3.5s the tabstrip's workspace-delete confirm uses. */
const MASTER_CONFIRM_MS = 3500;

export function Layouts() {
  let wrapEl: HTMLDivElement | undefined;

  // ---- scope + form state ----------------------------------------------------
  const [scope, setScope] = createSignal<"tab" | "master">("tab");
  const [layoutName, setLayoutName] = createSignal("");
  const [tabTitle, setTabTitle] = createSignal("");

  // Refresh token: bumped on every local mutation (save/delete/rename) + on
  // open, so the list memos re-read localStorage. (Cross-document writes
  // while the popover is open are not tracked — single-tab posture, same as
  // the rest of the shell's popovers.)
  const [rev, setRev] = createSignal(0);
  const tabList = createMemo(() => {
    void rev();
    return listTabLayouts();
  });
  const masterList = createMemo(() => {
    void rev();
    return listMasterLayouts();
  });

  const surface = usePopoverSurface({
    id: "layouts",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
    // Reset on every open: This-tab scope, a cleared name, and the tab-title
    // prefilled with the CURRENT workspace's name (the natural default — the
    // save is usually "this tab, titled as it is").
    onOpen: () => {
      setScope("tab");
      setLayoutName("");
      setTabTitle(activeWsName());
      setRev((n) => n + 1);
    },
  });

  /** The ACTIVE workspace's name (read inside expressions so the prefill is
   *  derived at open time; the form's copy stays whatever the operator typed). */
  const activeWsName = (): string => {
    const id = activeWorkspaceId();
    return workspaces().find((w) => w.id === id)?.name ?? "";
  };

  // ---- this-tab save form guards (live while open — panes()/workspaces()
  //      are read inside these + the JSX expressions so SolidJS tracks) ------
  const canSaveTab = (): boolean =>
    panes().length > 0 && normalizeLayoutName(layoutName()) !== "";

  /** All-tabs save: needs ≥1 workspace (never-zero makes 0 unreachable in
   *  practice; the guard documents the intent + keeps the UI honest if that
   *  invariant ever changes) and a non-empty name. */
  const canSaveMaster = (): boolean =>
    workspaces().length > 0 && normalizeLayoutName(layoutName()) !== "";

  const saveHint = (): string => {
    if (scope() === "master") {
      if (workspaces().length === 0) return "No workspaces to snapshot.";
      if (normalizeLayoutName(layoutName()) === "") return "Enter a name to save every tab's arrangement.";
      return "";
    }
    if (panes().length === 0) return "No panes to save — the active workspace is empty.";
    if (normalizeLayoutName(layoutName()) === "") return "Enter a name to save the current arrangement.";
    return "";
  };

  const doSave = () => {
    if (scope() === "master") {
      if (!canSaveMaster()) return; // aria-disabled guard — full no-op
      const ok = hostOps()?.saveMasterLayout?.(layoutName()) ?? false;
      if (ok) {
        setLayoutName("");
        setRev((n) => n + 1);
      }
      return;
    }
    if (!canSaveTab()) return; // aria-disabled guard — full no-op
    // The tab title is passed through; the storage layer owns the empty→name
    // fallback (an emptied title field saves as the layout's name).
    const ok = hostOps()?.saveLayout?.(layoutName(), tabTitle()) ?? false;
    if (ok) {
      // Clear the name; re-default the title to the current workspace's name
      // (the list refresh showing the entry + its title subtitle is the
      // confirmation). Same-name saves overwrite (documented in namedLayouts).
      setLayoutName("");
      setTabTitle(activeWsName());
      setRev((n) => n + 1);
    }
  };

  // ---- row actions -----------------------------------------------------------
  const doLoadTab = (name: string) => {
    const id = hostOps()?.loadLayout?.(name);
    // Close on a successful instantiation: the new workspace activates (the
    // popover's result is the workspace, not more popover). A failed lookup
    // (null — no such saved layout) keeps the popover open.
    if (id) surface.closePopover();
  };

  const doLoadMaster = (name: string) => {
    const ok = hostOps()?.loadMasterLayout?.(name);
    if (ok) surface.closePopover();
  };

  const doDelete = (name: string) => {
    // Pure storage mutation (production posture, not the DEV bridge).
    // Single-tap delete is the deliberate default (a saved layout is a
    // re-creatable snapshot; the workspace-delete confirm is for
    // non-recoverable state).
    deleteNamedLayout(name);
    setRev((n) => n + 1);
  };

  const doRename = (oldName: string, newName: string): boolean => {
    const ok = hostOps()?.renameLayout?.(oldName, newName) ?? false;
    if (ok) setRev((n) => n + 1);
    return ok;
  };

  return (
    <div class={s.wrap} ref={wrapEl}>
      <button
        type="button"
        class={s.trigger}
        title="Layouts"
        aria-label="Layouts"
        aria-haspopup="menu"
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="layouts-btn"
        onClick={() => surface.togglePopover()}
      >
        <span class={s.triggerIcon} aria-hidden="true">▦</span>
        <span class={s.triggerText}>Layouts</span>
      </button>
      <Show when={surface.open()}>
        <div class={s.popover} data-testid="layouts-popover" aria-label="Layouts">
          <div class={s.heading}>Layouts</div>
          <div class={s.scopeToggle} role="group" aria-label="Layout scope">
            <button
              type="button"
              class={scope() === "tab" ? `${s.scopeBtn} ${s.scopeBtnOn}` : s.scopeBtn}
              aria-pressed={scope() === "tab" ? "true" : "false"}
              data-testid="layouts-scope-tab"
              onClick={() => setScope("tab")}
            >
              This tab
            </button>
            <button
              type="button"
              class={scope() === "master" ? `${s.scopeBtn} ${s.scopeBtnOn}` : s.scopeBtn}
              aria-pressed={scope() === "master" ? "true" : "false"}
              data-testid="layouts-scope-all"
              onClick={() => setScope("master")}
            >
              All tabs
            </button>
          </div>

          <Show
            when={scope() === "tab"}
            fallback={
              <div class={s.saveForm} data-testid="layouts-save-master">
                <label class={s.field}>
                  <span class={s.fieldLabel}>Layout name</span>
                  <input
                    class={s.nameInput}
                    type="text"
                    maxlength={NAMED_LAYOUT_NAME_MAX}
                    placeholder="e.g. morning fleet"
                    value={layoutName()}
                    aria-label="Layout name"
                    data-testid="layout-name-input"
                    onInput={(e) => setLayoutName(e.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  class={canSaveMaster() ? s.saveBtn : `${s.saveBtn} ${s.saveBtnDisabled}`}
                  data-testid="layout-save"
                  aria-disabled={canSaveMaster() ? undefined : "true"}
                  onClick={() => doSave()}
                >
                  Save all tabs
                </button>
                <Show when={saveHint()}>
                  <div class={s.saveHint} data-testid="layout-save-hint">
                    {saveHint()}
                  </div>
                </Show>
              </div>
            }
          >
            <div class={s.saveForm} data-testid="layouts-save-tab">
              <label class={s.field}>
                <span class={s.fieldLabel}>Layout name</span>
                <input
                  class={s.nameInput}
                  type="text"
                  maxlength={NAMED_LAYOUT_NAME_MAX}
                  placeholder="e.g. morning"
                  value={layoutName()}
                  aria-label="Layout name"
                  data-testid="layout-name-input"
                  onInput={(e) => setLayoutName(e.currentTarget.value)}
                />
              </label>
              <label class={s.field}>
                <span class={s.fieldLabel}>Tab title</span>
                <input
                  class={s.nameInput}
                  type="text"
                  maxlength={TAB_TITLE_MAX}
                  placeholder="workspace name on load"
                  value={tabTitle()}
                  aria-label="Tab title"
                  data-testid="layout-tabtitle-input"
                  onInput={(e) => setTabTitle(e.currentTarget.value)}
                />
                <span class={s.helper}>The workspace name applied when this layout loads.</span>
              </label>
              <button
                type="button"
                class={canSaveTab() ? s.saveBtn : `${s.saveBtn} ${s.saveBtnDisabled}`}
                data-testid="layout-save"
                aria-disabled={canSaveTab() ? undefined : "true"}
                onClick={() => doSave()}
              >
                Save current
              </button>
              <Show when={saveHint()}>
                <div class={s.saveHint} data-testid="layout-save-hint">
                  {saveHint()}
                </div>
              </Show>
            </div>
          </Show>

          <div class={s.list} data-testid="layout-list">
            <Show when={scope() === "tab"} fallback={
              <>
                <For each={masterList()}>
                  {(entry) => (
                    <MasterRow
                      name={entry.name}
                      tabs={entry.tabs}
                      savedAt={entry.savedAt}
                      onLoad={doLoadMaster}
                      onDelete={doDelete}
                      onRename={doRename}
                    />
                  )}
                </For>
                <Show when={masterList().length === 0}>
                  <div class={s.empty} data-testid="layout-empty">
                    No saved layouts yet.
                  </div>
                </Show>
              </>
            }>
              <For each={tabList()}>
                {(entry) => (
                  <TabRow
                    name={entry.name}
                    tabTitle={entry.tabTitle}
                    savedAt={entry.savedAt}
                    onLoad={doLoadTab}
                    onDelete={doDelete}
                    onRename={doRename}
                  />
                )}
              </For>
              <Show when={tabList().length === 0}>
                <div class={s.empty} data-testid="layout-empty">
                  No saved layouts yet.
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** Coarse relative age for a saved layout (cheap, no ticker — computed at
 *  render; a stale minute while the popover stays open is fine). */
function relTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Row-level state shared by both scopes' rows (rename edit + collision
 *  error). Returned state is per-ROW (each row instantiates its own). */
function useRowState(onRename: (oldName: string, newName: string) => boolean) {
  const [renaming, setRenaming] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal("");
  let inputEl: HTMLInputElement | undefined;

  const beginRename = (name: string) => {
    setDraft(name);
    setError("");
    setRenaming(true);
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  };
  const commitRename = (oldName: string) => {
    if (!renaming()) return;
    const name = draft().trim();
    setRenaming(false);
    if (!name || name === oldName) return; // empty / unchanged — plain cancel
    if (!onRename(oldName, name)) {
      // Refused (collision or invalid): no change to the stored entry; the
      // inline error is the feedback. Stays until the row is interacted with
      // again or the popover closes/reopens.
      setError(`"${name}" is already used — pick another name.`);
    }
  };
  const cancelRename = () => setRenaming(false);

  return {
    renaming, draft, setDraft, error, setError,
    beginRename, commitRename, cancelRename,
    refInput: (el: HTMLInputElement) => (inputEl = el),
  };
}

/** A THIS-TAB row: name (+ "→ tab:" subtitle when the title differs from the
 *  name) + relative time; actions Load (row main), ✎ rename, × delete. */
function TabRow(props: {
  name: string;
  tabTitle: string;
  savedAt: number;
  onLoad(name: string): void;
  onDelete(name: string): void;
  onRename(oldName: string, newName: string): boolean;
}) {
  const row = useRowState(props.onRename);
  return (
    <div class={s.row} data-testid="layout-row" data-name={props.name} data-scope="tab">
      <Show
        when={row.renaming()}
        fallback={
          <button
            type="button"
            class={s.rowMain}
            aria-label={`Load layout ${props.name}`}
            title={`Load ${props.name} as a new workspace`}
            data-testid="layout-load"
            onClick={() => props.onLoad(props.name)}
          >
            <span class={s.rowText}>
              <span class={s.rowName}>{props.name}</span>
              <Show when={props.tabTitle !== props.name}>
                <span class={s.rowSub} data-testid="layout-row-tabtitle">
                  → tab: {props.tabTitle}
                </span>
              </Show>
            </span>
            <span class={s.rowMeta}>{relTime(props.savedAt)}</span>
          </button>
        }
      >
        <input
          ref={row.refInput}
          class={s.renameInput}
          data-testid="layout-rename-input"
          value={row.draft()}
          maxlength={NAMED_LAYOUT_NAME_MAX}
          onInput={(e) => row.setDraft(e.currentTarget.value)}
          onBlur={() => row.commitRename(props.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              row.commitRename(props.name);
            } else if (e.key === "Escape") {
              e.preventDefault();
              row.cancelRename();
            }
          }}
        />
      </Show>
      <Show when={!row.renaming()}>
        <button
          type="button"
          class={s.actBtn}
          aria-label={`Rename layout ${props.name}`}
          title={`Rename ${props.name}`}
          data-testid="layout-rename"
          onClick={() => row.beginRename(props.name)}
        >
          ✎
        </button>
        <button
          type="button"
          class={s.delBtn}
          aria-label={`Delete layout ${props.name}`}
          title={`Delete ${props.name}`}
          data-testid="layout-delete"
          onClick={() => props.onDelete(props.name)}
        >
          ×
        </button>
      </Show>
      <Show when={row.error()}>
        <div class={s.rowError} data-testid="layout-rename-error" role="alert">
          {row.error()}
        </div>
      </Show>
    </div>
  );
}

/** An ALL-TABS (master) row: name + "N tabs" subtitle + relative time. The
 *  Load action is a TWO-STEP confirm (destructive session replace): the first
 *  tap swaps the row into "Replace all tabs?" + ✓/✕; ✓ runs the load, ✕ (or
 *  the ~3.5s timeout) reverts. Mirrors the workspace-delete confirm. */
function MasterRow(props: {
  name: string;
  tabs: number;
  savedAt: number;
  onLoad(name: string): void;
  onDelete(name: string): void;
  onRename(oldName: string, newName: string): boolean;
}) {
  const row = useRowState(props.onRename);

  // ---- two-step confirm state (mirrors Tabstrip's workspace-delete) -------
  const [confirming, setConfirming] = createSignal(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const armConfirmTimer = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => setConfirming(false), MASTER_CONFIRM_MS);
  };
  const clearConfirmTimer = () => {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
  };
  const startConfirm = () => {
    row.cancelRename();
    setConfirming(true);
    armConfirmTimer();
  };
  const cancelConfirm = () => {
    setConfirming(false);
    clearConfirmTimer();
  };
  const confirmLoad = () => {
    clearConfirmTimer();
    setConfirming(false);
    props.onLoad(props.name);
  };
  onCleanup(() => clearConfirmTimer());

  return (
    <div
      class={confirming() ? `${s.row} ${s.rowConfirming}` : s.row}
      data-testid="layout-row"
      data-name={props.name}
      data-scope="master"
      data-confirming={confirming() ? "1" : "0"}
    >
      <Show
        when={row.renaming()}
        fallback={
          <Show
            when={!confirming()}
            fallback={
              <span class={s.confirmLabel} title="Replace every workspace?">
                Replace all tabs?
              </span>
            }
          >
            <button
              type="button"
              class={s.rowMain}
              aria-label={`Load master layout ${props.name}`}
              title={`Replace every workspace with ${props.name}`}
              data-testid="layout-load"
              onClick={() => startConfirm()}
            >
              <span class={s.rowText}>
                <span class={s.rowName}>{props.name}</span>
                <span class={s.rowSub}>
                  {props.tabs} tab{props.tabs === 1 ? "" : "s"}
                </span>
              </span>
              <span class={s.rowMeta}>{relTime(props.savedAt)}</span>
            </button>
          </Show>
        }
      >
        <input
          ref={row.refInput}
          class={s.renameInput}
          data-testid="layout-rename-input"
          value={row.draft()}
          maxlength={NAMED_LAYOUT_NAME_MAX}
          onInput={(e) => row.setDraft(e.currentTarget.value)}
          onBlur={() => row.commitRename(props.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              row.commitRename(props.name);
            } else if (e.key === "Escape") {
              e.preventDefault();
              row.cancelRename();
            }
          }}
        />
      </Show>
      <Show
        when={!row.renaming() && !confirming()}
        fallback={
          <Show when={confirming() && !row.renaming()}>
            <button
              type="button"
              class={s.confirmBtn}
              data-testid="layout-load-confirm"
              title="Replace every workspace with this snapshot"
              onClick={() => confirmLoad()}
            >
              ✓
            </button>
            <button
              type="button"
              class={s.cancelBtn}
              data-testid="layout-load-cancel"
              title="Cancel"
              onClick={() => cancelConfirm()}
            >
              ✕
            </button>
          </Show>
        }
      >
        <button
          type="button"
          class={s.actBtn}
          aria-label={`Rename layout ${props.name}`}
          title={`Rename ${props.name}`}
          data-testid="layout-rename"
          onClick={() => row.beginRename(props.name)}
        >
          ✎
        </button>
        <button
          type="button"
          class={s.delBtn}
          aria-label={`Delete layout ${props.name}`}
          title={`Delete ${props.name}`}
          data-testid="layout-delete"
          onClick={() => props.onDelete(props.name)}
        >
          ×
        </button>
      </Show>
      <Show when={row.error()}>
        <div class={s.rowError} data-testid="layout-rename-error" role="alert">
          {row.error()}
        </div>
      </Show>
    </div>
  );
}
