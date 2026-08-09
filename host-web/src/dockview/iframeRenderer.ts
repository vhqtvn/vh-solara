import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
} from "dockview-core";
import type { Attention, Activity, HostOps, LivenessState, PaneHeaderState, PaneParams } from "./types";
import {
  bindContentWindow,
  bindPaneOrigin,
  livenessFor,
  lookupContentWindow,
  noteIframeLoad,
  sendHandshake,
  statusFor,
  titleFor,
  unbindContentWindow,
} from "./store";

/**
 * Per-pane content renderer. Builds a CUSTOM header (a single `.pane-label` +
 * split/collapse/zoom/close affordances) over a single cross-origin <iframe>
 * whose src is the pane's {url,label} — in MOCK mode the mock content page
 * url; in REAL-fleet mode (VITE_SERVERS) a real server origin.
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
  private headerLabel!: HTMLElement;
  private btnCollapse!: HTMLButtonElement;
  private btnZoom!: HTMLButtonElement;
  // Per-pane document-liveness indicator (Q1-C). Updated on a ~2 Hz timer that
  // reads livenessFor(paneId) so staleness + the reloaded window expire without
  // another heartbeat arriving.
  private livenessDot!: HTMLElement;
  private livenessLabel!: HTMLElement;
  private livenessTimer: number | undefined;
  // P1 session-attention badge (DISTINCT from Q1-C liveness: a rounded-rect
  // badge with a glyph, not a circle dot). Shown only when the pane's current
  // (dir,session) needs operator input (needs_permission / needs_reply). The
  // same periodic refresh reflects the real session title (via the status
  // message's title field, stored in titleByPane) over the raw server label.
  private statusBadge!: HTMLElement;
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
    this.startLivenessIndicator();
  }

  private buildDom(): void {
    const p = this.params!;
    this.element.innerHTML = "";

    const header = document.createElement("div");
    header.className = "pane-header";

    const brand = document.createElement("div");
    brand.className = "pane-brand";
    // Per-pane document-liveness indicator (Q1-C). dot color + label reflect
    // livenessFor(paneId). NEVER realtime/SSE wording — see
    // docs/heartbeat-protocol.md §6.
    const live = document.createElement("div");
    live.className = "pane-liveness";
    live.setAttribute("data-testid", "pane-liveness");
    this.livenessDot = document.createElement("span");
    this.livenessDot.className = "pane-liveness-dot";
    this.livenessLabel = document.createElement("span");
    this.livenessLabel.className = "pane-liveness-label";
    live.appendChild(this.livenessDot);
    live.appendChild(this.livenessLabel);
    brand.appendChild(live);
    this.headerLabel = document.createElement("span");
    this.headerLabel.className = "pane-label";
    this.headerLabel.textContent = p.label;
    this.headerLabel.title = p.label;
    brand.appendChild(this.headerLabel);
    // P1 session-attention badge. A rounded-rect badge with a glyph (NOT a
    // circle dot — visually + semantically distinct from the Q1-C liveness
    // indicator). Hidden until a status lands; updated by updateStatus() on the
    // periodic refresh. The slow opacity pulse is the ONLY animation (no
    // mask-image / backdrop-filter — AGENTS.md Firefox/WebRender GPU rules).
    this.statusBadge = document.createElement("span");
    this.statusBadge.className = "pane-status-badge";
    this.statusBadge.setAttribute("data-testid", "pane-status-badge");
    this.statusBadge.hidden = true;
    brand.appendChild(this.statusBadge);
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

  /** Start the ~2 Hz per-pane header refresh: Q1-C liveness (dot + label) AND
   *  P1 session-attention (title over server label + attention badge). Both are
   *  read from the store on the same timer; neither touches the iframe element
   *  (survival-unchanged). */
  private startLivenessIndicator(): void {
    this.updateLiveness();
    this.updateStatus();
    if (typeof window !== "undefined") {
      this.livenessTimer = window.setInterval(() => {
        this.updateLiveness();
        this.updateStatus();
      }, 500);
    }
  }

  /** Reflect livenessFor(paneId) into the dot + label (Q1-C states). */
  private updateLiveness(): void {
    const state: LivenessState = livenessFor(this.paneId);
    this.livenessDot.setAttribute("data-state", state);
    this.livenessLabel.textContent = liveLabel(state);
    this.livenessLabel.setAttribute("data-state", state);
  }

  /** Reflect P1 session-attention into the header: the real session title (via
   *  the status message's title field, falling back to the server label) drives
   *  `.pane-label`, and a distinct attention badge shows when the pane's current
   *  (dir,session) needs operator input. Activity tints the label so a glance
   *  distinguishes running / done / error / idle. */
  private updateStatus(): void {
    const st = statusFor(this.paneId);
    const title = titleFor(this.paneId);
    // Title over server label (augments, never suppresses the Q1-C indicator).
    const label = title || this.params?.label || "";
    this.headerLabel.textContent = label;
    this.headerLabel.title = label;
    const activity: Activity | "none" = st?.activity ?? "none";
    if (activity === "none") {
      this.headerLabel.removeAttribute("data-activity");
    } else {
      this.headerLabel.setAttribute("data-activity", activity);
    }
    const attention: Attention = st?.attention ?? "none";
    if (attention === "none") {
      this.statusBadge.hidden = true;
      this.statusBadge.classList.remove("is-pulsing");
      this.statusBadge.removeAttribute("data-attention");
      this.statusBadge.textContent = "";
    } else {
      this.statusBadge.hidden = false;
      this.statusBadge.setAttribute("data-attention", attention);
      // Glyph distinguishes the two attention kinds (capability grant vs
      // clarifying question); the rounded-rect shape + color distinguish P1
      // attention from the Q1-C circle dot. Wording never overlaps Q1-C.
      this.statusBadge.textContent = attention === "needs_permission" ? "!" : "?";
      // Slow opacity pulse (the only animation) draws the eye to needs-input.
      this.statusBadge.classList.add("is-pulsing");
    }
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
    if (this.livenessTimer !== undefined && typeof window !== "undefined") {
      window.clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    unbindContentWindow(this.paneId);
  }
}

/** Q1-C visible label for a per-pane liveness state. */
function liveLabel(s: LivenessState): string {
  switch (s) {
    case "alive":
      return "document alive";
    case "reloaded":
      return "reloaded";
    case "no-signal":
      return "no recent signal";
  }
}
