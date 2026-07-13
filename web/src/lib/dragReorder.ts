// Generic drag-to-reorder helpers. Pure functions: they return new arrays and
// never mutate their inputs. Independent of persistence and the pinned model so
// they can be unit-tested in isolation and reused for any ordered list.
//
// Two shapes are supported:
//  - moveItem(arr, from, to): reorder by absolute indices.
//  - reorderRelative(arr, dragged, target, pos): drop `dragged` before/after a
//    target value — the natural shape for pointer DnD where you hit-test rows
//    and learn "the pointer is in the top/bottom half of row X".

/**
 * Move the item at index `from` to index `to` within a shallow copy of `arr`.
 * Returns a copy unchanged when either index is out of range or they are equal.
 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) {
    return arr.slice();
  }
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Reorder by dropping `dragged` immediately before or after `target`. Returns a
 * shallow copy; unchanged (same content, new array) when `dragged` equals
 * `target` or either is absent from the list.
 *
 * `pos: "before"` inserts dragged at target's current index; `"after"` inserts
 * it just past target. Implemented as remove-then-insert so the resulting index
 * is unambiguous regardless of which side of target the dragged item came from.
 */
export function reorderRelative<T>(
  arr: readonly T[],
  dragged: T,
  target: T,
  pos: "before" | "after",
): T[] {
  if (dragged === target || !arr.includes(dragged) || !arr.includes(target)) {
    return arr.slice();
  }
  const without = arr.filter((x) => x !== dragged);
  // target !== dragged, so target is still present in `without`.
  let toIdx = without.indexOf(target);
  if (pos === "after") toIdx += 1;
  // toIdx is in [0, without.length] — valid splice insertion points.
  return [...without.slice(0, toIdx), dragged, ...without.slice(toIdx)];
}
