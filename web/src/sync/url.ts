// URL deep-linking. The selected session lives in the URL (?session=<id>) so it
// survives reloads and is shareable; the workspace lives in ?dir=. We push
// history entries on selection (back/forward walk session + project history) and
// apply the URL on load and on popstate (the popstate wiring lives in the sync
// barrel, which calls setApplyingUrl around its reentrant selection).
import { projectDir } from "./store";

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
