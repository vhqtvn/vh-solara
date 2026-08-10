import { For, Show, createSignal } from "solid-js";
import { hostOps } from "../dockview/store";
import { runtimeServers } from "../state/serverList";
import type { AddServerOutcome } from "../dockview/types";
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
 * All actions go through the typed HostOps controller surface (store.hostOps),
 * NOT the DEV-only window.__host bridge, so this works in production builds.
 *
 * SECURITY: the url is validated through isFleetEntry (http/https) inside
 * HostOps.addServerWithOutcome — a javascript:/data:/opaque value is rejected
 * (null return), an inline error is shown, and no pane opens. The url lands on
 * an unsandboxed iframe.src, so this guard is the iframe-src XSS boundary.
 */
export function AddServer() {
  const [open, setOpen] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [error, setError] = createSignal("");
  const [outcome, setOutcome] = createSignal<AddServerOutcome | null>(null);

  const submit = (e: Event) => {
    e.preventDefault();
    const u = url().trim();
    const l = label().trim();
    const res = hostOps()?.addServerWithOutcome?.(u, l) ?? null;
    if (res) {
      // Success (one of the three deterministic outcomes): clear the form +
      // error; keep the outcome line + popover visible for more adds.
      setUrl("");
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

  return (
    <div class={s.wrap}>
      <button
        type="button"
        class={s.trigger}
        title="Add server"
        aria-label="Add server"
        data-testid="add-server-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <span class={s.triggerIcon} aria-hidden="true">+</span>
        <span class={s.triggerText}>Add server</span>
      </button>
      <Show when={open()}>
        <div class={s.popover} data-testid="add-server-popover">
          <div class={s.heading}>Add a server</div>
          <form class={s.form} onSubmit={submit}>
            <label class={s.field}>
              <span class={s.fieldLabel}>Server URL</span>
              <input
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
                  <div class={s.catalogRow}>
                    <span class={s.catalogLabel} title={srv.url}>
                      {srv.label}
                    </span>
                    <span class={s.catalogUrl}>{srv.url}</span>
                    <button
                      type="button"
                      class={s.removeBtn}
                      title={`Remove ${srv.label}`}
                      aria-label={`Remove ${srv.label}`}
                      data-testid="remove-server"
                      data-url={srv.url}
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
