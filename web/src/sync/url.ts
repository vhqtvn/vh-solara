// URL deep-linking. The selected session lives in the URL (?session=<id>) so it
// survives reloads and is shareable; the workspace lives in ?dir=. We push
// history entries on selection (back/forward walk session + project history) and
// apply the URL on load and on popstate (the popstate wiring lives in the sync
// barrel, which calls setApplyingUrl around its reentrant selection).
import { projectDir } from "./store";

// Phase 3 Step A (COEXIST) — the tree=2 client render-path feature flag.
// docs/design/server-owned-tree.md §10: the new server-owned tree stream is
// negotiated via a `?tree=2` query param (mirrors the `proj=1` capability
// precedent). The capability is determined at connect time and held for the
// life of the connection, so a plain URL query is the natural toggle: reload
// with `?tree=2` to opt into the new flat-map render path; reload without it
// (or `?tree=1`) to keep the EXACT existing proj=1 projection path. This is
// COEXIST-only — both paths stay compiled and reachable; Step B flips the
// default, Step C deletes the old path.
//
// Read once per call (no caching) so a reload re-evaluates it fresh; callers
// are connect() (once per connection) and SessionTree's render branch (cheap).
export function tree2Enabled(): boolean {
  try {
    const v = new URLSearchParams(location.search).get("tree");
    return v === "2";
  } catch {
    return false;
  }
}

export function currentUrlSession(): string | null {
  try {
    return new URLSearchParams(location.search).get("session");
  } catch {
    return null;
  }
}

let applyingUrl = false; // guard so popstate-driven selection doesn't re-push
// Set by the popstate handler while it applies the URL back into the store, so
// the resulting setSelectedId* doesn't push a fresh history entry over the one
// the user just navigated to.
export function setApplyingUrl(v: boolean) {
  applyingUrl = v;
}

// Write the current workspace + selected session to the URL. `replace` updates
// in place (used to normalize the URL on load); otherwise a history entry is
// pushed so back/forward walks selection + project history.
export function syncUrl(id: string | null, replace = false) {
  if (applyingUrl || typeof location === "undefined") return;
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    const dir = projectDir();
    if (dir) url.searchParams.set("dir", dir);
    else url.searchParams.delete("dir");
    if (url.search === location.search) return;
    if (replace) history.replaceState({ session: id, dir }, "", url);
    else history.pushState({ session: id, dir }, "", url);
  } catch {
    /* history unavailable — selection still works in-memory */
  }
}
