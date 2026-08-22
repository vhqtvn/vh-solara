import type { DockviewApi } from "dockview-core";
import { workspaceApiFor, activeWorkspaceId } from "./store";
import { fractionsToSizes, sizesToFractions } from "./fractionMath";

// The pure fraction math lives in the ZERO-IMPORT leaf ./fractionMath (both
// this module and layoutPersistence.ts consume it; keeping it a leaf is what
// breaks the layoutPersistence → proportions → store → layoutPersistence ESM
// module-init cycle). Re-exported here so this module's public surface is
// unchanged for existing importers.
export { sizesToFractions, fractionsToSizes } from "./fractionMath";

// =============================================================================
// PROPORTIONAL SPLIT GEOMETRY — fractions, not pixels.
//
// WHY THIS MODULE EXISTS (probe-evidenced, 2026-08-23 zz-probe-split):
// dockview's splitview redistributes container resizes PROPORTIONALLY only
// while each branch's Splitview has saved `_proportions` (saveProportions
// runs on sash-end / relayout / descriptor-construct). The orientation FLIP
// path (Gridview.orientation setter → flipNode — used by the auto-transpose
// on tall/wide viewport crossings, i.e. BY WINDOW RESIZES) rebuilds every
// branch splitview WITHOUT saving proportions. The flip itself is
// fraction-preserving (its own math is proportional), but every resize AFTER
// the flip falls back to splitview's LAST-VIEW-ABSORBS policy and the split
// shares drift — measured 60/40 → 50.9/49.1 → 47.3/52.7 across two resize
// steps — and the drift becomes sticky (the next sash touch re-saves the
// drifted sizes as the new proportions).
//
// This module keeps an authoritative FRACTIONAL snapshot per workspace
// (recaptured on every legitimate layout mutation via onDidLayoutChange —
// which never fires for a pure container resize) and re-applies it through
// LIVE-TREE APIs ONLY on a debounced resize-end:
//
//   • BranchNode.resizeChild(i, px) → Splitview.resizeView → relayout →
//     saveProportions — the SAME primitive a programmatic resize uses, and
//     it re-establishes dockview's own proportional regime as a side effect.
//   • NO fromJSON (cold-only HARD RULE — layoutPersistence.ts), no panel
//     disposal, no iframe reparenting: the same operation class as a sash
//     drag, so pane identity survives (asserted by the proportions e2e).
//
// The same fraction math backs layout persistence v3 (px→fraction on save,
// fraction→px on cold restore) — see layoutPersistence.ts.
// =============================================================================

/** Debounce for the resize-end re-normalize. Same order as viewportShape's
 *  transpose debounce (~200ms): a burst of resize events coalesces into ONE
 *  re-normalize after the drag settles. Tunable. */
const RENORMALIZE_DEBOUNCE_MS = 200;

// ---- pure fraction math: MOVED to ./fractionMath (leaf module) --------------
// sizesToFractions / fractionsToSizes are imported + re-exported above; their
// definitions live in the zero-import leaf so layoutPersistence can consume
// them WITHOUT importing this module (which would close the module-init
// cycle described in fractionMath.ts).

// ---- live gridview access (same runtime path as viewportShape.ts) ---------

/** Minimal live-tree shape we need from dockview's runtime. The public
 *  DockviewApi type does not expose the Gridview; `api.component.gridview`
 *  is the established runtime path in this codebase (viewportShape.ts). */
interface LiveBranch {
  size: number;
  children: unknown[];
  getChildSize(index: number): number;
  resizeChild(index: number, size: number): void;
}
interface LiveGridview {
  root: unknown;
}
function gridviewOf(api: DockviewApi): LiveGridview | null {
  const comp = (api as unknown as {
    component?: { gridview?: LiveGridview };
  }).component;
  return comp?.gridview ?? null;
}
function asBranch(node: unknown): LiveBranch | null {
  if (typeof node !== "object" || node === null) return null;
  const b = node as Partial<LiveBranch>;
  if (typeof b.getChildSize !== "function" || typeof b.resizeChild !== "function") {
    return null;
  }
  if (!Array.isArray(b.children) || typeof b.size !== "number") return null;
  return b as LiveBranch;
}

// ---- fractional snapshot of a live tree ------------------------------------

/** A branch's child fractions + the recursive snapshots of branch children.
 *  Leaves carry no entry; shape-matched against the live tree on apply. */
export interface FracNode {
  f: number[];
  c: FracNode[];
}

/** Capture the fractional split geometry of `api`'s grid tree (the GRID only
 *  — floating/popout groups live outside the gridview and keep their own
 *  absolute geometry). Returns null when the runtime path is unavailable. */
export function captureApiFractions(api: DockviewApi): FracNode | null {
  const gv = gridviewOf(api);
  const root = gv?.root;
  if (!gv || root === undefined) return null;
  const branch = asBranch(root);
  if (!branch) return { f: [], c: [] };
  return captureBranch(branch);
}

function captureBranch(branch: LiveBranch): FracNode {
  const sizes = branch.children.map((_, i) => branch.getChildSize(i));
  return {
    f: sizesToFractions(sizes),
    c: branch.children.map((child) => {
      const b = asBranch(child);
      return b ? captureBranch(b) : { f: [], c: [] };
    }),
  };
}

/** Re-apply a captured fractional snapshot to `api`'s LIVE tree through
 *  BranchNode.resizeChild (→ Splitview.resizeView → relayout →
 *  saveProportions — which also heals dockview's post-flip lost-proportions
 *  regime). Children are set in index order 0..n-2; the LAST child of each
 *  branch absorbs the remainder, so siblings end up summing exactly to the
 *  branch extent. Shape-mismatch (a mutation raced the snapshot) aborts the
 *  walk for that subtree — the next onDidLayoutChange recaptures. Returns
 *  true when any resize was issued. */
export function applyApiFractions(api: DockviewApi, snap: FracNode): boolean {
  const gv = gridviewOf(api);
  const branch = gv ? asBranch(gv.root) : null;
  if (!branch) return false;
  return applyBranch(branch, snap);
}

function applyBranch(branch: LiveBranch, snap: FracNode): boolean {
  const n = branch.children.length;
  if (snap.c.length !== n || snap.f.length !== n) return false; // shape drifted
  let touched = false;
  if (n >= 2 && Number.isFinite(branch.size) && branch.size > 0) {
    const targets = fractionsToSizes(snap.f, branch.size);
    for (let i = 0; i < n - 1; i++) {
      const t = targets[i];
      if (Number.isFinite(t) && t >= 0) {
        try {
          branch.resizeChild(i, t);
          touched = true;
        } catch {
          // index raced a mutation — the next recapture re-syncs
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const child = branch.children[i];
    const b = asBranch(child);
    if (b && applyBranch(b, snap.c[i])) touched = true;
  }
  return touched;
}

// ---- per-workspace re-normalizer (install/uninstall per DockviewHost) ------

export interface ProportionsHandle {
  /** Flush any pending debounced re-normalize and apply NOW (deterministic
   *  e2e path; also the DEV bridge's renormalizeNow). Applies the STORED
   *  snapshot (user-intent fractions), not a fresh capture — so a drift can
   *  actually be corrected. */
  renormalizeNow(): boolean;
  /** Uninstall listeners. Idempotent. */
  dispose(): void;
}

/** Installed handles by workspace id — lets the DEV bridge resolve the ACTIVE
 *  workspace's handle. Mirrors the controllers registry pattern. */
const handles = new Map<string, ProportionsHandle>();

/** Install the debounced resize-end proportional re-normalizer for ONE
 *  workspace api (keyed by workspace id for the DEV bridge). Keeps a
 *  fractional snapshot recaptured on every onDidLayoutChange (user mutations
 *  — sash drags, splits, closes; a pure container resize never fires it, so
 *  drift is never blessed into the snapshot) and re-applies it on window
 *  resize-end. Skips while a group is maximized (the grid is deliberately
 *  all-hidden-but-one; applying split fractions would fight the maximize).
 *  Returns a handle for cleanup. */
export function installProportionalResize(
  api: DockviewApi,
  workspaceId: string,
): ProportionsHandle {
  let snapshot: FracNode | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const capture = (): void => {
    if (disposed || api.hasMaximizedGroup()) return;
    snapshot = captureApiFractions(api);
  };

  const apply = (): boolean => {
    if (disposed) return false;
    if (api.hasMaximizedGroup()) return false;
    if (!snapshot) snapshot = captureApiFractions(api);
    if (!snapshot) return false;
    return applyApiFractions(api, snapshot);
  };

  const onResize = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      apply();
    }, RENORMALIZE_DEBOUNCE_MS);
  };

  const sub = api.onDidLayoutChange(capture);
  window.addEventListener("resize", onResize, { passive: true });

  // Seed the snapshot from the cold-restored/seeded geometry so the FIRST
  // resize (before any user mutation) already has authoritative fractions.
  capture();

  const handle: ProportionsHandle = {
    renormalizeNow: (): boolean => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return apply();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("resize", onResize);
      sub.dispose();
      snapshot = null;
      if (handles.get(workspaceId) === handle) handles.delete(workspaceId);
    },
  };
  handles.set(workspaceId, handle);
  return handle;
}

// ---- DEV bridge (window.__hostProportions) ----------------------------------
// Pure-function test surface (host-web has NO vitest; unit-grade asserts run
// through page.evaluate — the repo's established pattern for host-web logic)
// plus deterministic re-normalize/inspect hooks for e2e. DEV-gated like
// __host / __hostViewport / __hostKbdFocus; absent in prod (the preview e2e
// asserts __host*=0 — this bridge follows the same rule).

const DEV_BRIDGE_KEY = "__hostProportions";

interface ProportionsDevBridge {
  sizesToFractions(sizes: number[]): number[];
  fractionsToSizes(fractions: number[], extent: number): number[];
  /** Fractional snapshot of the ACTIVE workspace's grid tree (fresh
   *  capture — a read, not the stored intent). */
  capture(): FracNode | null;
  /** Flush + re-apply the STORED snapshot (user-intent fractions) to the
   *  ACTIVE workspace now — the deterministic e2e path for the
   *  re-normalizer (corrects drift; a fresh capture would be a no-op). */
  renormalizeNow(): boolean;
}

/** Install the DEV bridge (idempotent). Exposed for main.tsx (same install
 *  point as the other DEV bridges). */
export function installProportionsDevBridge(): void {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as Record<string, unknown>;
  if (w[DEV_BRIDGE_KEY]) return;
  const bridge: ProportionsDevBridge = {
    sizesToFractions,
    fractionsToSizes,
    capture: (): FracNode | null => {
      const api = workspaceApiFor(activeWorkspaceId());
      return api ? captureApiFractions(api) : null;
    },
    renormalizeNow: (): boolean => {
      const h = handles.get(activeWorkspaceId());
      return h ? h.renormalizeNow() : false;
    },
  };
  w[DEV_BRIDGE_KEY] = bridge;
}
