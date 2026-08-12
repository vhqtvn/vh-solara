import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
} from "dockview-core";
import type { HostOps, PaneParams, PaneHeaderState } from "./types";
import {
  bindContentWindow,
  bindPaneOrigin,
  lookupContentWindow,
  noteIframeLoad,
  sendHandshake,
  unbindContentWindow,
} from "./store";

/**
 * Per-pane content renderer. Builds a CHROMELESS pane: a single cross-origin
 * <iframe> filling the slot + a thin focus border when active. NO title text,
 * NO per-pane buttons (the operator: "every pixel matters; title takes space
 * without benefit"). Layout ops (split/mode/zoom/close) live in the statusbar
 * control cluster + the i3 keyboard shortcuts, not on the pane itself.
 *
 * A Dockview group with multiple panels keeps its NATIVE tab strip (the tabbed/
 * stacked affordance — see dockviewOverrides.css which un-hides it for multi-
 * panel groups). The per-pane header this renderer used to draw is GONE.
 *
 * LOAD-BEARING RULE (the whole architecture's guarantee): create exactly ONE
 * <iframe> element and NEVER reparent, replace, or remove+re-add it. Dockview's
 * `renderer: 'always'` (OverlayRenderContainer) keeps this element permanently
 * mounted and changes only its geometry/visibility — so a split/swap/drag/
 * switch-tab/zoom/collapse+restore must NOT touch the iframe element here. Any
 * code that would do `iframe.remove()` + re-add reloads the iframe and breaks
 * the multi-server contract. The only sanctioned "reload" is the negative-
 * control test hook `naiveReload()`, which exists solely to prove the gate
 * catches that mistake.
 */
export class IframeRenderer implements IContentRenderer {
  readonly element: HTMLElement;

  private paneId = "";
  private params: PaneParams | undefined;
  private iframe!: HTMLIFrameElement;
  // Body wrapper that holds the iframe. Kept so naiveReload (the NEGATIVE
  // control) can re-add a fresh iframe to PROVE a reload — never used by any
  // production path.
  private body!: HTMLElement;

  constructor(private readonly ops: HostOps) {
    // Root container: body only (header removed — chromeless panes). This
    // `.pane` element is what Dockview's OverlayRenderContainer keeps mounted;
    // the iframe lives inside it for the panel's entire lifetime.
    this.element = document.createElement("div");
    this.element.className = "pane";
  }

  init(params: GroupPanelPartInitParameters): void {
    this.paneId = params.api.id;
    this.params = (params.params as PaneParams) ?? this.params;
    this.element.dataset.paneId = this.paneId;
    // Bind the configured server origin for the constraint-#3 origin check.
    // Derived from params.url (mock :5174 or a real server origin).
    try {
      bindPaneOrigin(this.paneId, new URL(this.params!.url).origin);
    } catch {
      // malformed url: leave origin unbound → routeMessage treats a missing
      // expected origin as "do not origin-reject" (defensive; seed urls are
      // validated http/https so this is unreachable in practice).
    }
    this.buildDom();
    this.buildIframe();
  }

  private buildDom(): void {
    this.element.innerHTML = "";
    // Chromeless: body + a hidden overlay-source badge. The focus border is
    // drawn by the `.is-active` class on `.pane` (see pane.css) — a 3px accent
    // outline + a 5px top edge, no permanent header. The `.pane-badge`
    // ("ACTIVE · <label>") is shown ONLY while the layout overlay is open for
    // THIS pane (the LayoutOverlay component toggles `.is-overlay-source` on
    // the matching `.pane` element imperatively); it is not a recreated header.
    const body = document.createElement("div");
    body.className = "pane-body";
    this.element.appendChild(body);
    this.body = body;

    const badge = document.createElement("div");
    badge.className = "pane-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = `ACTIVE · ${this.params?.label ?? "server"}`;
    this.element.appendChild(badge);
  }

  private buildIframe(): void {
    const p = this.params!;
    // EXACTLY ONE iframe, created once. Its src is set at creation (from
    // params.url, with any stored route query appended) and never changed
    // (changing src reloads). Geometry/visibility is owned by Dockview.
    // params.url is the FULL iframe src — mock content page url in mock mode,
    // a real server origin in real-fleet mode (VITE_SERVERS). A stored route
    // (a ?dir=...&session=... query captured from the SPA's route emission) is
    // appended so the SPA deep-links itself on cold restore (reload). src is
    // set ONCE here; runtime route changes update params WITHOUT touching src.
    const iframe = document.createElement("iframe");
    iframe.className = "pane-iframe";
    let src = p.url;
    if (p.route) {
      try {
        const u = new URL(p.url);
        // p.route is a query string (e.g. "?dir=/x&session=1" or "dir=/x").
        // Setting .search replaces any existing query; leading '?' is optional.
        u.search = p.route.startsWith("?") ? p.route.slice(1) : p.route;
        src = u.href;
      } catch {
        // Malformed url/route — fall back to the bare params.url (survival-safe).
        src = p.url;
      }
    }
    iframe.src = src;
    iframe.title = p.label;
    // No sandbox: the child keeps its real cross-origin (mock :5174 vs host
    // :5173 by port; real servers are cross-origin by domain) so it can run its
    // SPA + same-origin-to-itself connections unimpeded, exactly as a real
    // embedded vh-solara server would. Real embedding is gated server-side by
    // the --frame-ancestors CSP.
    iframe.setAttribute("loading", "eager");
    this.iframe = iframe;
    this.body.appendChild(iframe);

    // contentWindow is null until the element is connected to the document.
    // At init() time this element may still be detached (Dockview attaches it
    // to the overlay container shortly after init), so the synchronous bind
    // below can capture null. Bind reliably on the iframe `load` event too —
    // that fires once the element is attached and the document has loaded, by
    // which point contentWindow is guaranteed valid (and before the first
    // ~250ms heartbeat).
    iframe.addEventListener("load", () => {
      if (iframe.contentWindow) bindContentWindow(this.paneId, iframe.contentWindow);
      // Document-liveness protocol (docs/heartbeat-protocol.md §3.1 + §4): on
      // every load (initial + reload), mark a pending load so the next
      // heartbeat establishes a fresh identity, then issue a fresh challenge
      // nonce. Both the real SPA and the mock stand-in echo this nonce; the
      // host verifies the first post-load heartbeat carries it (constraint #4).
      noteIframeLoad(this.paneId);
      sendHandshake(this.paneId);
    });
    if (iframe.contentWindow) bindContentWindow(this.paneId, iframe.contentWindow);
  }

  // ---- controller hooks ----------------------------------------------------

  /** The iframe element (used by the negative-control test hook). */
  getIframe(): HTMLIFrameElement {
    return this.iframe;
  }

  /** Body element (naiveReload re-adds a fresh iframe here to PROVE a reload). */
  getBody(): HTMLElement {
    return this.body;
  }

  /** Push tray/zoom affordance state. With no header buttons, this only toggles
   *  the `.is-tray` / `.is-maximized` classes on the pane root (kept so the
   *  focus border can tint a trayed/maximized pane if desired). */
  setHeaderState(s: PaneHeaderState): void {
    this.element.classList.toggle("is-tray", s.inTray);
    this.element.classList.toggle("is-maximized", s.maximized);
  }

  /** Visual active focus border (host focus routing). Re-triggers a one-shot
   *  opacity pulse on the focus indicator (the top-edge pseudo-element) when a
   *  pane becomes active, ONCE per activation — so a focus change is glanceable
   *  without a permanent animation (GPU-cheap: a 200ms opacity on a pseudo-
   *  element; omitted under prefers-reduced-motion). */
  setActive(active: boolean): void {
    this.element.classList.toggle("is-active", active);
    if (active) {
      // Re-trigger the one-shot pulse by removing the class, forcing a reflow,
      // then re-adding it (a finite CSS animation does not re-run on a no-op
      // class toggle without an intervening reflow).
      this.element.classList.remove("pane-focus-pulse");
      void this.element.offsetWidth; // force reflow
      this.element.classList.add("pane-focus-pulse");
    }
  }

  /** Deliver host→pane focus/blur over the postMessage contract. */
  sendFocus(): void {
    this.postToPane({ type: "focus" });
  }
  sendBlur(): void {
    this.postToPane({ type: "blur" });
  }

  private postToPane(msg: unknown): void {
    const cw = lookupContentWindow(this.paneId) ?? this.iframe?.contentWindow;
    if (!cw || !this.params) return;
    // Target the child's own origin, derived from the pane url (mock :5174 or a
    // real server origin). Never '*' — a targeted origin is both safer and lets
    // the message actually deliver to a listening child (the mock content page).
    // A real SPA does not listen, so a targeted-but-ignored message is a harmless
    // no-op (the host must not crash when a pane sends no heartbeat).
    let origin: string;
    try {
      origin = new URL(this.params.url).origin;
    } catch {
      return; // malformed url: drop the message rather than broadcast to '*'
    }
    cw.postMessage(msg, origin);
  }

  dispose(): void {
    unbindContentWindow(this.paneId);
  }
}
