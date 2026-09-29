import { For, Show, createEffect, createSignal, untrack, type Accessor } from "solid-js";
import { addWorkspace, hostOps, panes, focusedId } from "../dockview/store";
import { runtimeServers } from "../state/serverList";
import type { AddServerOutcome } from "../dockview/types";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import ts from "./Tabstrip.module.css";
import s from "./AddServer.module.css";

/**
 * Runtime add/remove-server affordance (decision #3 — `+` = "Add server").
 *
 * TWO composed surfaces since the priority-fit chrome merge (D3):
 *
 *  - <AddServer> — the server-add-only trigger + popover, surface id
 *    "add-server". Now mounted ONLY by App.tsx's empty-workspace overlay
 *    (App.tsx:157); its testids (add-server-btn / add-server-popover /
 *    add-server-url / …) and server-add-only semantics are UNCHANGED.
 *  - <AddMenu> — the STRIP's single merged "+" trigger (data-testid="ws-add",
 *    surface id "add-menu" — DISTINCT: popover.ts's registry is
 *    singleton-per-id, and both components can be mounted simultaneously
 *    whenever the active workspace is empty). Its popover offers "New
 *    workspace" (store addWorkspace — the old strip ws-add action) plus a
 *    "Connect server…" section embedding the SAME <AddServerForm> below.
 *
 * The two surfaces share TABSTRIP_POPOVER_GROUP, so at most one popover is
 * open at a time (mutual exclusion) and the shared form testids never appear
 * twice in the DOM.
 *
 * The operator-reported legibility fix is preserved verbatim inside the form:
 * heading + URL description (Fork B — explicit-watch), submit calls
 * HostOps.addServerWithOutcome (deterministic duplicate handling), and an
 * outcome line ("Already open" / "Opened" / "Added and opened") that STAYS
 * VISIBLE. CATALOG ROWS are two SIBLING real buttons (finding 3) with the
 * pick button's aria-label naming both label AND url.
 *
 * All actions go through the typed HostOps controller surface (store.hostOps),
 * NOT the DEV-only window.__host bridge, so this works in production builds.
 *
 * SECURITY: the url is validated through isFleetEntry (http/https) inside
 * HostOps.addServerWithOutcome — a javascript:/data:/opaque value is rejected
 * (null return), an inline error is shown, and no pane opens. The url lands on
 * an unsandboxed iframe.src, so this guard is the iframe-src XSS boundary.
 */

/** The shared add-server form (URL + optional label + submit + outcome +
 *  catalog). Owns its own state; prefills from the focused pane on each
 *  open TRANSITION of the hosting popover (untracked — later focus moves
 *  while open never wipe the operator's typing). Rendered inside exactly one
 *  open popover at a time (the surfaces share TABSTRIP_POPOVER_GROUP). */
function AddServerForm(props: { open: Accessor<boolean> }) {
  const [url, setUrl] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [error, setError] = createSignal("");
  const [outcome, setOutcome] = createSignal<AddServerOutcome | null>(null);

  // OPERATOR POINT #4: "default to prefill current server." Prefill the URL
  // field with the currently-active pane's server URL so the operator can
  // quickly open another window into the same box, or edit for a different
  // server. Label is left empty (the operator names the new window). Runs
  // once per open transition; the panes/focusedId reads are untracked so a
  // focus change while open cannot re-wipe the form.
  createEffect(() => {
    if (!props.open()) return;
    untrack(() => {
      const activePane = panes().find((p) => p.id === focusedId());
      setUrl(activePane?.url ?? "");
      setLabel("");
      setError("");
      setOutcome(null);
    });
  });

  const submit = (e: Event) => {
    e.preventDefault();
    const u = url().trim();
    const l = label().trim();
    const res = hostOps()?.addServerWithOutcome?.(u, l) ?? null;
    if (res) {
      // Success (one of the three deterministic outcomes): clear the form +
      // error; keep the outcome line + popover visible for more adds. Re-prefill
      // the URL from the now-active pane (the new pane became active on add).
      const activePane = panes().find((p) => p.id === focusedId());
      setUrl(activePane?.url ?? "");
      setLabel("");
      setError("");
      setOutcome(res);
    } else {
      // addServerWithOutcome rejected (isFleetEntry guard): not http/https.
      setError("Enter a valid http:// or https:// URL");
      setOutcome(null);
    }
  };

  const remove = (serverUrl: string) => {
    const ok = hostOps()?.removeServer?.(serverUrl);
    if (!ok) {
      setError("Can't remove the last server on the grid");
    } else {
      setError("");
    }
  };

  // Catalog pick → prefill the form with that row's {url,label} (the
  // operator's minimum: "at least it must auto fill the url"). Clears any
  // error/outcome so the form reads clean, then focuses + select-all's the
  // URL input for quick editing (change a port/path and re-add).
  let urlInputEl: HTMLInputElement | undefined;
  const prefill = (srv: { url: string; label: string }) => {
    setUrl(srv.url);
    setLabel(srv.label);
    setError("");
    setOutcome(null);
    urlInputEl?.focus();
    urlInputEl?.select();
  };
  // Selection guard (finding 5): a click event that ENDS a text-selection
  // drag over the row (the common-ancestor click rule fires click on mouseup)
  // must not overwrite the form or clobber the selection. The check is scoped
  // to selections anchored INSIDE the clicked button, so the select-all that
  // prefill() itself creates in the URL input never blocks the next pick.
  // Nearly unreachable now that the rows are user-select:none — kept for UA
  // quirks / forced selection (e.g. a11y tools).
  const pick = (e: MouseEvent, srv: { url: string; label: string }) => {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && e.currentTarget instanceof Node && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) {
      return;
    }
    prefill(srv);
  };

  return (
    <>
      <form class={s.form} onSubmit={submit}>
        <label class={s.field}>
          <span class={s.fieldLabel}>Server URL</span>
          <input
            ref={urlInputEl}
            class={s.input}
            type="text"
            placeholder="https://srv.example.com"
            value={url()}
            aria-label="Server URL"
            data-testid="add-server-url"
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          <span class={s.helper}>
            Connect another vh-solara server. Session tabs appear after you
            open a session in a server pane.
          </span>
        </label>
        <label class={s.field}>
          <span class={s.fieldLabel}>Label (optional)</span>
          <input
            class={s.input}
            type="text"
            placeholder="my-server"
            value={label()}
            aria-label="Server label"
            data-testid="add-server-label"
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
        <button type="submit" class={s.addBtn} data-testid="add-server-submit">
          Add server
        </button>
      </form>
      <Show when={error()}>
        <div class={s.error} data-testid="add-server-error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={outcome()}>
        <div
          class={s.outcome}
          data-testid="add-server-outcome"
          data-kind={outcome()!.kind}
          role="status"
        >
          {outcomeText(outcome()!)}
        </div>
      </Show>
      <Show when={runtimeServers().length > 0}>
        <div class={s.catalog} data-testid="server-catalog">
          <For each={runtimeServers()}>
            {(srv) => (
              /* A plain flex row (NO role/tabindex — finding 3): the row's
               * two affordances are SIBLING real buttons, so neither is an
               * interactive-inside-interactive violation and both are
               * reliably exposed to assistive tech. data-testid/data-url
               * stay on the row (a stable, layout-level marker). */
              <div class={s.catalogRow} data-testid="server-row" data-url={srv.url}>
                <button
                  type="button"
                  class={s.catalogPick}
                  // The accessible name carries BOTH the label and the url
                  // (finding 3: the old row aria-label hid the address).
                  aria-label={`Use ${srv.label} — ${srv.url}`}
                  title={`Fill the form with ${srv.label}`}
                  onClick={(e) => pick(e, srv)}
                >
                  <span class={s.catalogLabel} title={srv.url}>
                    {srv.label}
                  </span>
                  <span class={s.catalogUrl}>{srv.url}</span>
                </button>
                <button
                  type="button"
                  class={s.removeBtn}
                  title={`Remove ${srv.label}`}
                  aria-label={`Remove ${srv.label}`}
                  data-testid="remove-server"
                  data-url={srv.url}
                  // A sibling (not a descendant) of the pick button: no
                  // propagation to stop — removing never prefills.
                  onClick={() => remove(srv.url)}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** Server-add-only affordance, mounted by App.tsx's empty-workspace overlay.
 *  Surface id "add-server" (RETAINED — the overlay mount is unchanged). */
export function AddServer() {
  let wrapEl: HTMLDivElement | undefined;

  const surface = usePopoverSurface({
    id: "add-server",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
    // Prefill bookkeeping lives in AddServerForm's open-transition effect —
    // no other on-open sync is needed here.
  });

  return (
    <div class={s.wrap} ref={wrapEl}>
      <button
        type="button"
        class={s.trigger}
        title="Add server"
        aria-label="Add server"
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="add-server-btn"
        onClick={() => surface.togglePopover()}
      >
        <span class={s.triggerIcon} aria-hidden="true">+</span>
        <span class={s.triggerText}>Add server</span>
      </button>
      <Show when={surface.open()}>
        <div class={s.popover} data-testid="add-server-popover">
          <div class={s.heading}>Add a server</div>
          <AddServerForm open={surface.open} />
        </div>
      </Show>
    </div>
  );
}

/**
 * The STRIP's single merged "+" trigger (D3 — the chrome merge): one popover
 * offering "New workspace" (the old strip ws-add action, store.addWorkspace)
 * and a "Connect server…" section embedding the shared AddServerForm. Replaces
 * the TWO look-alike triggers that rendered as identical icons at phone width
 * (the old strip ws-add button + the strip AddServer mount).
 *
 *  - data-testid="ws-add" (the strip's workspace-add entry point — the folded
 *    and preview production specs click it).
 *  - SURFACE-ID CONTRACT: surface id "add-menu", DISTINCT from AddServer's
 *    "add-server" — popover.ts's registry is singleton-per-id, and both
 *    components are mounted simultaneously whenever the active workspace is
 *    empty (the overlay's gate). Same TABSTRIP_POPOVER_GROUP → at most one
 *    popover open, each independently dismissible.
 *  - Trigger/popover styling lives in Tabstrip.module.css (the strip chrome
 *    module); the form keeps AddServer.module.css.
 */
export function AddMenu() {
  let wrapEl: HTMLDivElement | undefined;

  const surface = usePopoverSurface({
    id: "add-menu",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
  });

  const newWorkspace = () => {
    // Close FIRST (never leave an open popover over a workspace-switching
    // strip), then mint the workspace — addWorkspace ACTIVATES the fresh
    // empty workspace, whose overlay AddServer co-mounts by design.
    surface.closePopover();
    addWorkspace();
  };

  return (
    <div class={ts.addMenuWrap} ref={wrapEl}>
      <button
        type="button"
        class={ts.plus}
        title="Add workspace or server"
        aria-label="Add workspace or server"
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="ws-add"
        onClick={() => surface.togglePopover()}
      >
        +
      </button>
      <Show when={surface.open()}>
        <div class={ts.addMenuPopover} data-testid="add-menu-popover" aria-label="Add workspace or server">
          <button
            type="button"
            class={ts.addMenuPrimary}
            data-testid="add-menu-new-workspace"
            onClick={newWorkspace}
          >
            New workspace
          </button>
          <div class={ts.addMenuSection}>
            <div class={ts.addMenuSectionLabel}>Connect server…</div>
            <AddServerForm open={surface.open} />
          </div>
        </div>
      </Show>
    </div>
  );
}

/** Outcome → visible line (decision #3). Stays visible after submit so the
 *  operator can tell what the + did (the core legibility fix). */
function outcomeText(o: AddServerOutcome): string {
  switch (o.kind) {
    case "already-open":
      return `Already open: ${o.label}`;
    case "opened":
      return `Opened ${o.label}`;
    case "added":
      return `Added and opened ${o.label}`;
  }
}
