import { For, Show, createSignal } from "solid-js";
import { hostOps, panes, focusedId } from "../dockview/store";
import { runtimeServers } from "../state/serverList";
import type { AddServerOutcome } from "../dockview/types";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import s from "./AddServer.module.css";

/**
 * Runtime add/remove-server affordance (decision #3 — `+` = "Add server").
 *
 * The operator reported the bare `⊕` glyph "does nothing" — the real issue was
 * legibility: the pane-creation mechanism worked, but there was no label, no
 * heading, no helper text, and no outcome feedback. This rewrite fixes all of
 * that:
 *  - the trigger reads "+ Add server" on desktop (icon + aria-label on narrow);
 *  - the popover has a heading "Add a server" + a URL description explaining
 *    that session tabs appear AFTER the operator opens a session in a server
 *    pane (Fork B — explicit-watch);
 *  - submit calls HostOps.addServerWithOutcome (deterministic-duplicate
 *    handling) and shows an outcome line ("Already open" / "Opened" / "Added
 *    and opened") that STAYS VISIBLE so the operator can tell what happened.
 *
 * OPEN/CLOSE goes through the shared surface stack (popover.ts): Escape closes
 * (topmost-only), a pointerdown outside the wrap closes, and the tabstrip
 * group keeps this popover mutually exclusive with Settings — exactly one
 * tabstrip popover open at a time (finding 1).
 *
 * CATALOG ROWS are two SIBLING real buttons (finding 3): the pick button
 * (label + url → click prefills the form) and the ✕ remove button. They are
 * NOT nested — a button's descendants are presentational to ARIA, which
 * flattened the old row[role=button] > button✕ structure and hid Remove from
 * screen readers. The pick button's aria-label names both the label AND the
 * url so the server address is announced.
 *
 * All actions go through the typed HostOps controller surface (store.hostOps),
 * NOT the DEV-only window.__host bridge, so this works in production builds.
 *
 * SECURITY: the url is validated through isFleetEntry (http/https) inside
 * HostOps.addServerWithOutcome — a javascript:/data:/opaque value is rejected
 * (null return), an inline error is shown, and no pane opens. The url lands on
 * an unsandboxed iframe.src, so this guard is the iframe-src XSS boundary.
 */
export function AddServer() {
  let wrapEl: HTMLDivElement | undefined;

  const [url, setUrl] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [error, setError] = createSignal("");
  const [outcome, setOutcome] = createSignal<AddServerOutcome | null>(null);

  const surface = usePopoverSurface({
    id: "add-server",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
    // OPERATOR POINT #4: "default to prefill current server." Prefill the URL
    // field with the currently-active pane's server URL so the operator can
    // quickly open another window into the same box, or edit for a different
    // server. Label is left empty (the operator names the new window).
    onOpen: () => {
      const activePane = panes().find((p) => p.id === focusedId());
      setUrl(activePane?.url ?? "");
      setLabel("");
      setError("");
      setOutcome(null);
    },
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
