// =============================================================================
// PURE FRACTION MATH — leaf module (NO imports, not even type-only).
//
// WHY A SEPARATE LEAF: both layoutPersistence.ts (v3 blob transforms) and
// proportions.ts (live-tree re-normalizer) need this math, but
// layoutPersistence MUST NOT import proportions — proportions imports ./store
// (call-time DEV-bridge values) and store imports layoutPersistence, so that
// edge closed an ESM module-init cycle (layoutPersistence → proportions →
// store → layoutPersistence) whose boot-time evaluation order could leave
// layoutPersistence's module consts in TDZ when store.ts ran its top-level
// initWorkspaces() → loadWorkspaceSet() (native ESM under vite dev). Keeping
// the math in a zero-import leaf makes that structurally impossible: every
// importer reaches a module that cannot reach back.
//
// Unit-tested via the DEV bridge in e2e (window.__hostProportions exposes
// these through proportions.ts's installProportionsDevBridge).
// =============================================================================

/** Convert sibling px sizes to fractions of their sum. Zero-size guard: a
 *  non-positive / non-finite sum (or any missing size) yields EQUAL
 *  fractions — a degenerate saved blob must still restore to something
 *  sane, never NaN. */
export function sizesToFractions(sizes: number[]): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const ok = sizes.every((s) => Number.isFinite(s) && s >= 0);
  const sum = ok ? sizes.reduce((a, b) => a + b, 0) : 0;
  if (!(sum > 0)) return new Array<number>(n).fill(1 / n);
  return sizes.map((s) => s / sum);
}

/** Convert fractions to integer px sizes that sum EXACTLY to `extent`
 *  (largest-remainder distribution: floor each share, then hand the
 *  integer remainder to the largest fractional remainders). A non-positive
 *  or non-finite extent, or empty/degenerate fractions, yields an equal
 *  integer split (last child absorbs the remainder) — never NaN. */
export function fractionsToSizes(fractions: number[], extent: number): number[] {
  const n = fractions.length;
  if (n === 0) return [];
  if (!Number.isFinite(extent) || extent <= 0) {
    const base = Math.floor(extent > 0 ? extent / n : 0);
    const out = new Array<number>(n).fill(base);
    out[n - 1] += Math.round(extent > 0 ? extent : 0) - base * n;
    return out;
  }
  const fr = sizesToFractions(fractions); // normalizes + zero-guards
  const total = Math.round(extent);
  const raw = fr.map((f) => f * total);
  const sizes = raw.map((x) => Math.floor(x));
  let left = total - sizes.reduce((a, b) => a + b, 0);
  // Largest remainder first; stable tie-break by index (deterministic).
  const order = raw
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  for (let k = 0; k < order.length && left > 0; k++) {
    sizes[order[k].i] += 1;
    left -= 1;
  }
  return sizes;
}
