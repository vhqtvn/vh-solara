import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
} from "dockview-core";
import type { HostOps, PaneHeaderState, PaneParams } from "./types";
import { iframeUrl } from "../state/mockData";
import {
  bindContentWindow,
  lookupContentWindow,
  unbindContentWindow,
} from "./store";
import { IFRAME_ORIGIN } from "../state/mockData";

/**
 * Per-pane content renderer. Builds a CUSTOM header (server label + view +
 * split/collapse/zoom/close affordances) over a single cross-origin <iframe>
 * that points at the (mock) vh-solara server page.
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
  private headerServer!: HTMLElement;
  private headerView!: HTMLElement;
  private btnCollapse!: HTMLButtonElement;
  private btnZoom!: HTMLButtonElement;
  private headerState: PaneHeaderState = {
    inTray: false,
    maximized: false,
    canCollapse: true,
  };

  constructor(private readonly ops: HostOps) {
    // Root container: header + body. This `.pane` element is what Dockview's
    // OverlayRenderContainer keeps mounted; the iframe lives inside it for the
    // panel's entire lifetime.
    this.element = document.createElement("div");
    this.element.className = "pane";
  }

  init(params: GroupPanelPartInitParameters): void {
    this.paneId = params.api.id;
    this.params = (params.params as PaneParams) ?? this.params;
    this.element.dataset.paneId = this.paneId;
    this.buildDom();
    this.buildIframe();
  }

  private buildDom(): void {
    const p = this.params!;
    this.element.innerHTML = "";

    const header = document.createElement("div");
    header.className = "pane-header";

    const brand = document.createElement("div");
    brand.className = "pane-brand";
    this.headerServer = document.createElement("span");
    this.headerServer.className = "pane-server";
    this.headerServer.textContent = p.server;
    this.headerServer.title = p.server;
    this.headerView = document.createElement("span");
    this.headerView.className = "pane-view";
    this.headerView.textContent = p.view;
    brand.appendChild(this.headerServer);
    brand.appendChild(this.headerView);
    header.appendChild(brand);

    const actions = document.createElement("div");
    actions.className = "pane-actions";

    const mk = (label: string, act: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `pane-btn pane-btn--${act}`;
      b.dataset.testid = `pane-${act}`;
      b.textContent = label;
      b.title = label;
      b.addEventListener("click", () => fn());
      actions.appendChild(b);
      return b;
    };

    mk("Split →", "split-right", () => this.ops.split?.(this.paneId, "right"));
    mk("Split ↓", "split-down", () => this.ops.split?.(this.paneId, "down"));
    this.btnCollapse = mk("Collapse", "collapse", () =>
      this.headerState.inTray
        ? this.ops.restore?.(this.paneId)
        : this.ops.collapse?.(this.paneId),
    );
    this.btnZoom = mk("Zoom", "zoom", () => this.ops.toggleZoom?.(this.paneId));
    mk("✕", "close", () => this.ops.closePane?.(this.paneId));

    header.appendChild(actions);
    this.element.appendChild(header);

    const body = document.createElement("div");
    body.className = "pane-body";
    this.element.appendChild(body);

    // Stash body for the iframe (added in buildIframe).
    body.setAttribute("data-body", "");
  }

  private buildIframe(): void {
    const p = this.params!;
    // EXACTLY ONE iframe, created once. Its src is set at creation and never
    // changed (changing src reloads). Geometry/visibility is owned by Dockview.
    const iframe = document.createElement("iframe");
    iframe.className = "pane-iframe";
    iframe.src = iframeUrl(p.server, p.view);
    iframe.title = `${p.server} · ${p.view}`;
    // No sandbox: the child keeps its real cross-origin (here :5174 vs the host
    // :5173 by port) so it can run its SPA + same-origin-to-itself WebSocket
    // unimpeded, exactly as a real embedded vh-solara server would. The real
    // embedding is gated server-side by the (deferred) --frame-ancestors CSP.
    iframe.setAttribute("loading", "eager");
    this.iframe = iframe;

    const body = this.element.querySelector<HTMLElement>('[data-body=""]')!;
    body.appendChild(iframe);

    // contentWindow is null until the element is connected to the document.
    // At init() time this element may still be detached (Dockview attaches it
    // to the overlay container shortly after init), so the synchronous bind
    // below can capture null. Bind reliably on the iframe `load` event too —
    // that fires once the element is attached and the document has loaded, by
    // which point contentWindow is guaranteed valid (and before the first
    // ~250ms heartbeat).
    iframe.addEventListener("load", () => {
      if (iframe.contentWindow) bindContentWindow(this.paneId, iframe.contentWindow);
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
    return this.element.querySelector<HTMLElement>('[data-body=""]')!;
  }

  /** Push tray/zoom affordance state so header buttons reflect it. */
  setHeaderState(s: PaneHeaderState): void {
    this.headerState = s;
    this.btnZoom.textContent = s.maximized ? "Restore" : "Zoom";
    this.btnCollapse.textContent = s.inTray ? "Restore" : "Collapse";
    this.btnCollapse.disabled = !s.inTray && !s.canCollapse;
    this.element.classList.toggle("is-tray", s.inTray);
    this.element.classList.toggle("is-maximized", s.maximized);
  }

  /** Visual active focus on the header (host focus routing). */
  setActive(active: boolean): void {
    this.element.classList.toggle("is-active", active);
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
    if (cw) {
      // Targeted to the known child origin (host knows :5174); never '*'.
      cw.postMessage(msg, IFRAME_ORIGIN);
    }
  }

  dispose(): void {
    unbindContentWindow(this.paneId);
  }
}
