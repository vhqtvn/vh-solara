// Sidebar UI state: the session-search query + the labels tag-filter state.
//
// The pin-authority cluster (pin membership + order, the PUT /vh/pins CAS
// facade, the legacy localStorage fallback, and the pins.snapshot /
// pins.updated stream entries) has fully migrated to ./pins.ts. This module
// now keeps ONLY the in-memory UI-only signals (zero coupling to the pin/label
// CAS authorities). All pin/label APIs must be imported from ./pins and
// ./labels directly — this module no longer re-exports them.
import { createSignal } from "solid-js";

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };

// ── Labels tag-filter state (slice 6) ─────────────────────────────────────────
// The tag AND-filter (selectedTagIds) + the filter chip-rail visibility
// (filterOpen). Owned HERE (not in the labels CAS facade) because this is pure
// local UI state: the filter is a presentational overlay on the tree, never
// persisted and never PUT to the server (labels are worker-wide; a per-browser
// filter view must not round-trip). Mirrors how searchQuery lives here while
// the pin/label authority lives in their own modules.
//
// selectedTagIds is the AND set: a root matches iff it carries EVERY id. Empty
// = no filter (everything matches). toggleTagFilter add/removes one id; the
// Sidebar chip rail binds aria-pressed to membership. clearTagFilter empties it
// (the chip rail's "Clear" button + auto-hide when the last chip is removed).
const [selectedTagIds, setSelectedTagIds] = createSignal<string[]>([]);
const [filterOpen, setFilterOpen] = createSignal(false);
export { selectedTagIds, setSelectedTagIds, filterOpen, setFilterOpen };

export function toggleTagFilter(tagId: string): void {
  const cur = selectedTagIds();
  if (cur.includes(tagId)) {
    setSelectedTagIds(cur.filter((t) => t !== tagId));
  } else {
    setSelectedTagIds([...cur, tagId]);
  }
}

export function clearTagFilter(): void {
  setSelectedTagIds([]);
}

