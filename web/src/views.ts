// Consumer-registered embedded views: a generic reverse-proxy surface. The
// worker proxies each view's upstream under its path_prefix (see pkg/web/
// views.go) and exposes the list here; the SPA renders each as a selectable,
// sandboxed iframe (peer to chat). Nothing domain-specific lives here.
import { createSignal } from "solid-js";

export interface RegisteredView {
  view_id: string;
  title: string;
  path_prefix: string;
  upstream: string;
  sandbox?: string;
}

const [views, setViews] = createSignal<RegisteredView[]>([]);
export { views };

export async function refreshViews() {
  try {
    const r = await fetch("/vh/views");
    if (r.ok) setViews((await r.json()) as RegisteredView[]);
  } catch {
    /* offline / not supported — leave the list as-is */
  }
}
