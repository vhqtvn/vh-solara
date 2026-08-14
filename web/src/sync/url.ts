// URL deep-linking. The selected session lives in the URL (?session=<id>) so it
// survives reloads and is shareable; the workspace lives in ?dir=. Selection
// NEVER creates a history entry — the current entry is updated in place
// (replaceState) — so browser back dismisses overlays (lib/backStack.ts)
// instead of walking past session selections. Genuine legacy session entries
// pushed by older builds are still honored by the popstate wiring in the sync
// barrel (which calls setApplyingUrl around its reentrant selection and skips
// events owned by the back-stack manager).
import { registerCanonicalRepair } from "../lib/backStack";
import { projectDir } from "./store";

export function currentUrlSession(): string | null {
  try {
    return new URLSearchParams(location.search).get("session");
  } catch {
    return null;
  }
}

let applyingUrl = false; // guard so popstate-driven selection doesn't re-write
// Set by the popstate handler while it applies the URL back into the store, so
// the resulting setSelectedId* doesn't rewrite the URL over the entry the user
// just navigated to.
export function setApplyingUrl(v: boolean) {
  applyingUrl = v;
}

// Last URL syncUrl wrote — the canonical URL for the current selection. The
// back-stack manager calls this repair when one of its traversals lands on an
// entry whose URL was frozen at push time (transparent entries only get their
// URL refreshed when they are the topmost entry).
let lastCanonicalUrl = "";

// Write the current workspace + selected session to the URL, in place. If the
// current entry carries a back-stack token (an overlay is open), the token
// state is preserved — only the URL refreshes — so the token keeps working.
export function syncUrl(id: string | null) {
  if (applyingUrl || typeof location === "undefined") return;
  try {
    const url = new URL(location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    const dir = projectDir();
    if (dir) url.searchParams.set("dir", dir);
    else url.searchParams.delete("dir");
    if (url.search === location.search) return;
    const st = typeof history !== "undefined" ? history.state : null;
    const state =
      st && typeof st === "object" && "vhBack" in st
        ? st
        : { session: id, dir };
    history.replaceState(state, "", url);
    lastCanonicalUrl = url.href;
  } catch {
    /* history unavailable — selection still works in-memory */
  }
}

// Canonical-URL repair for the back-stack manager (see lib/backStack.ts).
// Preserves the landed entry's state (token or session entry); only the URL is
// restored so a stale frozen ?session= never sticks (and never re-selects).
registerCanonicalRepair(() => {
  if (!lastCanonicalUrl || typeof history === "undefined") return;
  try {
    if (new URL(lastCanonicalUrl, location.href).href !== location.href)
      history.replaceState(history.state, "", lastCanonicalUrl);
  } catch {
    /* ignore */
  }
});
