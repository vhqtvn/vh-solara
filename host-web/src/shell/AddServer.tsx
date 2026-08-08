import { For, Show, createSignal } from "solid-js";
import { hostOps } from "../dockview/store";
import { runtimeServers } from "../state/serverList";
import s from "./AddServer.module.css";

/**
 * Runtime add/remove-server affordance. Minimal MVP: a trigger button opens a
 * small popover with a {url,label} form + the live catalog list (each entry has
 * a remove button). All actions go through the typed HostOps controller surface
 * (store.hostOps), NOT the DEV-only window.__host bridge, so this works in
 * production builds.
 *
 * SECURITY: the url is validated through isFleetEntry (http/https) inside
 * HostOps.addServer — a javascript:/data:/opaque value is rejected (null
 * return), an inline error is shown, and no pane opens. The url lands on an
 * unsandboxed iframe.src, so this guard is the iframe-src XSS boundary.
 */
export function AddServer() {
  const [open, setOpen] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [error, setError] = createSignal("");

  const submit = (e: Event) => {
    e.preventDefault();
    const u = url().trim();
    const l = label().trim();
    const id = hostOps()?.addServer?.(u, l);
    if (id) {
      // success: clear the form + error; keep the popover open for more adds.
      setUrl("");
      setLabel("");
      setError("");
    } else {
      // addServer rejected (isFleetEntry guard): not http/https / parse failure.
      setError("Enter a valid http:// or https:// URL");
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
        data-testid="add-server-btn"
        onClick={() => setOpen((v) => !v)}
      >
        ⊕
      </button>
      <Show when={open()}>
        <div class={s.popover} data-testid="add-server-popover">
          <form class={s.form} onSubmit={submit}>
            <input
              class={s.input}
              type="text"
              placeholder="https://srv.example.com"
              value={url()}
              aria-label="Server URL"
              data-testid="add-server-url"
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <input
              class={s.input}
              type="text"
              placeholder="label (optional)"
              value={label()}
              aria-label="Server label"
              data-testid="add-server-label"
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
            <button type="submit" class={s.addBtn} data-testid="add-server-submit">
              Add
            </button>
          </form>
          <Show when={error()}>
            <div class={s.error} data-testid="add-server-error" role="alert">
              {error()}
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
