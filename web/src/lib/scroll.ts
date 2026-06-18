import { loadVersioned, saveVersioned } from "./store";

// Per-session scroll offset, persisted so reopening a session resumes where you
// left off. Kept MINIMAL: only sessions scrolled away from the bottom are
// stored (the common "at bottom" case is the default and needs no entry), and
// entries are pruned when a session is archived.
const KEY = "vh.scroll.v1";
type Offsets = Record<string, number>;

let cache: Offsets = loadVersioned<Offsets>(KEY, 1, {}, (o) =>
  o && typeof o === "object" ? (o as Offsets) : {},
);

export function getScroll(id: string): number | undefined {
  return cache[id];
}

export function setScroll(id: string, top: number) {
  const cur = cache[id];
  if (top <= 4) {
    // At (or near) the top/bottom-follow default — don't persist; drop any prior.
    if (cur !== undefined) {
      delete cache[id];
      saveVersioned(KEY, 1, cache);
    }
    return;
  }
  const v = Math.round(top);
  if (cur === v) return;
  cache[id] = v;
  saveVersioned(KEY, 1, cache);
}

export function clearScroll(ids: string[]) {
  let changed = false;
  for (const id of ids) {
    if (cache[id] !== undefined) {
      delete cache[id];
      changed = true;
    }
  }
  if (changed) saveVersioned(KEY, 1, cache);
}
