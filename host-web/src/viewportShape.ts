import { Orientation } from "dockview-core";
import type { DockviewApi } from "dockview-core";
import { createSignal } from "solid-js";
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
// source: gridview.js). The `rootOrientation`/`setRootOrientation` DEV bridge
// in hostController now reads/writes this same gridview path (it used to write
// the broken `api.orientation` path — fixed).
//
// SCOPE. v0 = orientation transpose ONLY. No per-shape layout defaults (tabbed
// vs grid), no persisted per-shape profiles, no SPA-side changes. The toggle
// defaults ON; the operator can disable via localStorage.
//
// STARTUP NORMALIZATION (v0.1): besides the resize listeners, the orientation
// is normalized ONCE at each workspace host's mount (right after the cold
// restore, before the FLIP install) and ONCE on each workspace ACTIVATION — a
// restored layout whose orientation mismatches the viewport SHAPE (e.g. a
// horizontal split restored on a portrait device) is flipped immediately
// instead of staying wrong until the first resize. Per-event only (no
// continuous re-normalization): the debounced resize listeners own every
// shape change after that. Same guards as the resize path (toggle, ≥2 grid
// groups, decisive shape, mismatch) and the same idempotent setter, so a
// mount/activation normalize immediately followed by a resize evaluation is a
// harmless no-op repeat.
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

// ---- reactive mirror (the Settings toggle's live state) ----------------------
//
// localStorage stays the source of truth (applyTranspose keeps reading the key
// on every evaluation), but UI surfaces need a signal that tracks EVERY writer
// of the key, not just their own clicks:
//  - same-document writes (setAutoTranspose below — including the DEV bridge's
//    setEnabled and any future programmatic writer) update the signal directly;
//  - cross-document writes (a second browser tab on this origin) arrive via
//    the `storage` event, which fires only in NON-writer documents — so the
//    listener re-reads and refreshes the signal there.
// This mirrors the inner SPA's persistedSignal pattern (web/src/lib/store.ts),
// adapted to this module's plain "on"/"off" key format (no versioned envelope,
// so stored values and the DEV bridge semantics are unchanged).
const [autoTransposeState, setAutoTransposeState] = createSignal(autoTransposeEnabled());

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (ev: StorageEvent) => {
    if (ev.key !== AUTOTRANSPOSE_STORAGE_KEY) return;
    // Re-read through the same parse path: by the time the event fires here,
    // this document's localStorage already holds the other document's write.
    setAutoTransposeState(autoTransposeEnabled());
  });
}

/** Reactive view of the auto-transpose toggle (tracks same-document AND
 *  cross-document writers — never stale while a UI surface reads it). */
export function autoTransposeOn(): boolean {
  return autoTransposeState();
}

/** Set the toggle. Persists immediately and refreshes the reactive mirror. */
export function setAutoTranspose(on: boolean): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(AUTOTRANSPOSE_STORAGE_KEY, on ? "on" : "off");
  }
  setAutoTransposeState(on);
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

/** Number of grid-level GROUPS on the grid — the count of root-splitview
 *  children (mirrors the transpose guard's semantics: the root orientation
 *  flip only rearranges the split BETWEEN grid groups). A tabbed
 *  multi-panel group is ONE grid child and counts ONCE, whether or not it
 *  currently reports an activePanel. Used as the "is there a real split to
 *  transpose?" guard: a single pane or a single tabbed group (count < 2)
 *  has no visible split axis → transpose is a meaningless no-op, so we skip
 *  it entirely. */
function gridGroupCount(api: DockviewApi): number {
  let n = 0;
  for (const g of api.groups) {
    if (g.api.location.type === "grid") {
      n += 1;
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
 *  no-op (gridview setter guards on equality; the shared core ALSO pre-checks so
 *  flipCount reflects real changes only). Survival-safe: flipNode rebuilds the
 *  split axis in place; no iframe is reparented/moved/removed. */
function applyTranspose(): void {
  evalCount++;
  if (!autoTransposeEnabled()) return;
  const api = workspaceApiFor(activeWorkspaceId());
  if (!api) return;
  transposeApiIfNeeded(api);
}

/** Shared transpose core (resize evaluations AND startup normalization): flip
 *  `api`'s grid root orientation to the current viewport shape when there is a
 *  real split (≥2 grid groups), the shape is decisive (not square), and the
 *  orientation mismatches. Returns true iff the orientation actually changed
 *  (increments flipCount then). Pre-checks make every path idempotent — the
 *  gridview setter itself also guards on equality, so a repeat call after a
 *  mount/activation normalize is a true no-op. */
function transposeApiIfNeeded(api: DockviewApi): boolean {
  // 1 pane / 1 group → no split to transpose. Skip (also avoids a meaningless
  // flipNode on a single root child).
  if (gridGroupCount(api) < 2) return false;
  const gv = gridviewOf(api);
  if (!gv) return false;
  const shape = classifyShape(window.innerWidth, window.innerHeight);
  const target = targetOrientation(shape);
  if (target === null) return false; // square — ambiguous, leave the layout alone
  if (gv.orientation === target) return false; // already matches — idempotent no-op
  // SURVIVAL-SAFE transpose (proven: Phase 1 Gate 1a). flipNode rebuilds the
  // grid split axis; the keep-mounted iframes keep their identity.
  gv.orientation = target;
  flipCount++;
  return true;
}

/** ONE-SHOT startup/activation normalization for a SPECIFIC workspace api
 *  (NOT the active-workspace resolution of the resize path). Called by each
 *  DockviewHost at mount — AFTER its cold restore, BEFORE the FLIP install —
 *  and on every workspace ACTIVATION, so a restored layout whose orientation
 *  mismatches the viewport shape (horizontal split on a portrait device) is
 *  corrected immediately instead of staying wrong until the first resize.
 *  Toggle-gated (vh-host:autotranspose; default ON) and otherwise identical
 *  to the resize evaluation (same guards, same idempotent setter). Returns
 *  true iff the orientation was flipped. */
export function normalizeWorkspaceOrientation(api: DockviewApi): boolean {
  if (!autoTransposeEnabled()) return false;
  return transposeApiIfNeeded(api);
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
