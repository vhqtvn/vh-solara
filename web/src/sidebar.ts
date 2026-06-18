// Sidebar UI state: the session-search query and the set of pinned sessions
// (kept out of the sync store; pins are a local preference, persisted).
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };

const LS_PINNED = "vh.pinned.v1";
const [pinned, setPinnedSig] = createSignal<Set<string>>(
  new Set(loadVersioned<string[]>(LS_PINNED, 1, [], (o) => (Array.isArray(o) ? (o as string[]) : []))),
);
export { pinned };
export const isPinned = (id: string) => pinned().has(id);
export function togglePin(id: string) {
  const next = new Set(pinned());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setPinnedSig(next);
  saveVersioned(LS_PINNED, 1, [...next]);
}
