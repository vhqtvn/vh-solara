import { Orientation } from "dockview-core";
import type { DockviewApi } from "dockview-core";
import { activeWorkspaceId, workspaceApiFor } from "./dockview/store";

// =============================================================================
// VIEWPORT-SHAPE AUTO-TRANSPOSE (i3 Phase 2)
//
// On device rotation or window resize, when the viewport shape crosses a
// threshold, flip the ACTIVE workspace's Dockview grid root orientation so the
// split direction matches the shape: a TALL (portrait) viewport stacks panes
// vertically (VERTICAL orientation); a WIDE (landscape) viewport puts them
// side-by-side (HORIZONTAL). SQUARE is ambiguous and never forces a flip.
//
// This is the survival-safe, reversible piece of the viewport-responsive i3
// vision. It is SURVIVAL-SAFE because the transpose primitive is the Dockview
// Gridview orientation setter, which calls flipNode(root) — a live-tree
// geometry rebuild that keeps every panel (and its keep-mounted iframe) in
// place; only the split axis changes. This was proven by Phase 1 Gate 1a + a
// throwaway probe: assertSurvived (mountTs/nonce/connId unchanged) passes on
// both panes across an orientation flip in both directions.
//
// DOCKVIEW API QUIRK (load-bearing). The transpose path is NOT
// `DockviewApi.orientation` (that property does not exist on DockviewApi — it
// belongs to GridviewApi; DockviewComponent.orientation is GETTER-only). The
// WORKING, survival-safe, IDEMPOTENT path is the Gridview instance reachable at
// `api.component.gridview.orientation`. Its setter guards
// `if (this.root.orientation === orientation) return;` before flipNode, so
// setting it to the current value is a true no-op (verified empirically + in
// source: gridview.js). The latent `setRootOrientation` DEV bridge in
// hostController writes the wrong (no-op) path; it is out of scope here and NOT
// fixed — this module reaches the gridview directly.
//
// SCOPE. v0 = orientation transpose ONLY. No per-shape layout defaults (tabbed
// vs grid), no persisted per-shape profiles, no SPA-side changes. The toggle
// defaults ON; the operator can disable via localStorage.
// =============================================================================

// ---- tunables (flagged for on-device adjustment) ---------------------------

/** Aspect-ratio threshold separating a clearly-tall/wide viewport from square.
 *  h/w > this → tall; w/h > this → wide; else square. 1.2 gives a ~17% asymmetry
 *  hysteresis band so a borderline window does not flutter between shapes on a
 *  single-pixel change. Adjust on-device if it false-triggers near the boundary. */
const SHAPE_RATIO = 1.2;
/** Debounce so a continuous resize drag (which fires many resize events) makes
 *  at most ONE transpose evaluation after the drag settles. ~200ms is below the
 *  rotation animation (~300ms) but above a frame's jitter; matches the
 *  keyboard-focus debounce order of magnitude. */
const DEBOUNCE_MS = 200;

/** localStorage key for the on/off toggle (default "on"). Read on EVERY
 *  evaluation so a DEV-bridge flip takes effect without a listener on storage. */
export const AUTOTRANSPOSE_STORAGE_KEY = "vh-host:autotranspose";

// ---- shape classification (pure) -------------------------------------------

export type ViewportShape = "tall" | "wide" | "square";

/** Classify a viewport by its aspect ratio. h/w > SHAPE_RATIO → tall (portrait);
 *  w/h > SHAPE_RATIO → wide (landscape); otherwise square. Pure + deterministic. */
export function classifyShape(w: number, h: number): ViewportShape {
  if (w <= 0 || h <= 0) return "square"; // degenerate — treat as ambiguous
  if (h / w > SHAPE_RATIO) return "tall";
  if (w / h > SHAPE_RATIO) return "wide";
  return "square";
}

/** The grid orientation a shape maps to. tall → VERTICAL (stack panes
 *  top-to-bottom); wide → HORIZONTAL (side-by-side); square → null (ambiguous,
 *  do NOT force a flip — leave the operator's current layout alone). */
export function targetOrientation(shape: ViewportShape): Orientation | null {
  if (shape === "tall") return Orientation.VERTICAL;
  if (shape === "wide") return Orientation.HORIZONTAL;
  return null;
}

// ---- toggle (localStorage-backed) ------------------------------------------

/** True iff auto-transpose is enabled. Reads localStorage on EVERY call so a
 *  toggle change (DEV bridge / future UI) takes effect without a storage
 *  listener. Defaults ON when the key is absent. */
export function autoTransposeEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  const v = localStorage.getItem(AUTOTRANSPOSE_STORAGE_KEY);
  // Absent → default ON. Explicit "off" (any case) → disabled. Anything else → ON.
  return v == null ? true : v.toLowerCase() !== "off";
}

/** Set the toggle. Persists immediately. */
export function setAutoTranspose(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTOTRANSPOSE_STORAGE_KEY, on ? "on" : "off");
}

// ---- dockview access (the survival-safe transpose path) --------------------

/** The Gridview instance behind a DockviewApi, reached via the runtime-only
 *  `api.component.gridview` path (the DockviewApi TS type does not expose it).
 *  Its `.orientation` setter is the survival-safe, IDEMPOTENT transpose
 *  primitive (see module header). Returns null when the path is absent (e.g. a
 *  not-yet-ready api). */
interface GridviewLike {
  orientation: Orientation;
}
function gridviewOf(api: DockviewApi): GridviewLike | null {
  const comp = (api as unknown as {
    component?: { gridview?: GridviewLike };
  }).component;
  return comp?.gridview ?? null;
}

/** Number of grid-level GROUPS on the active grid (mirrors
 *  HostController.gridPaneCount). Each grid group with an active panel counts
 *  once; a tabbed multi-panel group still counts once (it is ONE grid child).
 *  Used as the "is there a real split to transpose?" guard: a single pane or a
 *  single tabbed group (count < 2) has no visible split axis → transpose is a
 *  meaningless no-op, so we skip it entirely. */
function gridGroupCount(api: DockviewApi): number {
  let n = 0;
  for (const g of api.groups) {
    if (g.api.location.type === "grid") {
      n += g.activePanel ? 1 : g.panels.length;
    }
  }
  return n;
}

// ---- module state (singleton; one transpose effect per host window) --------

let installed = false;
let debounceTimer: number | undefined;
let resizeListener: (() => void) | null = null;
/** Counters for the DEV bridge / debounce test. evalCount increments on every
 *  applyTranspose RUN; flipCount increments ONLY when the orientation actually
 *  changed. Together they let the debounce e2e prove N rapid resize events →
 *  exactly ONE evaluation (coalesced) — the load-bearing debounce claim. */
let evalCount = 0;
let flipCount = 0;

/** Evaluate the current shape and transpose the ACTIVE workspace if needed.
 *  Pure w.r.t. the toggle: a no-op (returns early, still counts the eval) when
 *  disabled. Idempotent: setting the orientation to its current value is a true
 *  no-op (gridview setter guards on equality; this function ALSO pre-checks so
 *  flipCount reflects real changes only). Survival-safe: flipNode rebuilds the
 *  split axis in place; no iframe is reparented/moved/removed. */
function applyTranspose(): void {
  evalCount++;
  if (!autoTransposeEnabled()) return;
  const api = workspaceApiFor(activeWorkspaceId());
  if (!api) return;
  // 1 pane / 1 group → no split to transpose. Skip (also avoids a meaningless
  // flipNode on a single root child).
  if (gridGroupCount(api) < 2) return;
  const gv = gridviewOf(api);
  if (!gv) return;
  const shape = classifyShape(window.innerWidth, window.innerHeight);
  const target = targetOrientation(shape);
  if (target === null) return; // square — ambiguous, leave the layout alone
  if (gv.orientation === target) return; // already matches — idempotent no-op
  // SURVIVAL-SAFE transpose (proven: Phase 1 Gate 1a). flipNode rebuilds the
  // grid split axis; the keep-mounted iframes keep their identity.
  gv.orientation = target;
  flipCount++;
}

/** Resize/orientationchange entry: schedule a debounced evaluation. Rapid
 *  successive events reset the timer so only the LAST one in a burst runs. */
function onViewportChange(): void {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    applyTranspose();
  }, DEBOUNCE_MS);
}

// ---- DEV bridge (window.__hostViewport) -------------------------------------
// Drives the effect programmatically for deterministic headless e2e. The real
// device-rotation OUTCOME is not-demonstrable headlessly (no engine rotates);
// these hooks prove the MECHANISM (shape classify → gridview transpose →
// identity-survival) without depending on a real orientationchange. Gated
// behind import.meta.env.DEV (same pattern as keyboardFocus's __hostKbdFocus)
// so production builds never expose the surface (Vite dead-code-eliminates it;
// the preview-e2e asserts __host*=0 in prod).

interface ViewportDevBridge {
  /** Read the on/off toggle. */
  enabled(): boolean;
  /** Set the on/off toggle (persists to localStorage). */
  setEnabled(on: boolean): void;
  /** ClassifyShape of the current window dimensions. */
  currentShape(): ViewportShape;
  /** The ACTIVE workspace's grid orientation via the CORRECTED gridview read
   *  (NOT the broken api.orientation path). null when there is no active api or
   *  no gridview. */
  currentOrientation(): "HORIZONTAL" | "VERTICAL" | null;
  /** Flush any pending debounced evaluation + apply immediately. For tests that
   *  need a deterministic transpose without waiting for DEBOUNCE_MS. */
  transposeNow(): void;
  /** Number of applyTranspose RUNS (debounce coalescing signal). */
  evalCount(): number;
  /** Number of ACTUAL orientation changes applied (flipCount). */
  flipCount(): number;
}

const DEV_BRIDGE_KEY = "__hostViewport";

function installDevBridge(): void {
  if (!import.meta.env.DEV) return;
  const bridge: ViewportDevBridge = {
    enabled: () => autoTransposeEnabled(),
    setEnabled: (on: boolean) => setAutoTranspose(on),
    currentShape: () => classifyShape(window.innerWidth, window.innerHeight),
    currentOrientation: () => {
      const api = workspaceApiFor(activeWorkspaceId());
      if (!api) return null;
      const gv = gridviewOf(api);
      return gv ? (gv.orientation as "HORIZONTAL" | "VERTICAL") : null;
    },
    transposeNow: () => {
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      applyTranspose();
    },
    evalCount: () => evalCount,
    flipCount: () => flipCount,
  };
  (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY] = bridge;
}

function removeDevBridge(): void {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY];
}

// ---- install / uninstall (mirrors keyboardFocus.ts) ------------------------

/**
 * Install the viewport-shape auto-transpose effect. Wires window resize +
 * orientationchange listeners (the real on-device detection path) and the DEV
 * bridge (always available in DEV for the headless mechanism-proof). No-op in
 * non-browser environments. Idempotent.
 *
 * The effect is REVERSIBLE: it reads the `vh-host:autotranspose` localStorage
 * toggle on every evaluation (default ON); when "off" the listeners stay wired
 * but every evaluation short-circuits (no transpose). A future UI control or
 * the DEV bridge can flip the toggle at runtime.
 */
export function installAutoTranspose(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;
  resizeListener = onViewportChange;
  // resize fires on window dimension changes (desktop window resize + the
  // layout-viewport resize that accompanies a mobile rotation); orientationchange
  // fires on device rotation (mobile). Both route through the same debounced
  // evaluator. Passive + non-capture: we only read + schedule, never prevent.
  window.addEventListener("resize", resizeListener, { passive: true });
  window.addEventListener("orientationchange", resizeListener, { passive: true });
  installDevBridge();
}

/** Tear down the listeners + DEV bridge and clear any pending debounce. Used on
 *  hot-reload / unmount so a pending transpose never fires after teardown. */
export function uninstallAutoTranspose(): void {
  if (!installed) return;
  installed = false;
  if (resizeListener) {
    window.removeEventListener("resize", resizeListener);
    window.removeEventListener("orientationchange", resizeListener);
  }
  resizeListener = null;
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  removeDevBridge();
}
