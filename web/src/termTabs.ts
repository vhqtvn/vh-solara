// Terminal tabs: per-project list of open terminals + which is active. Each tab
// maps to a server PTY id (see pkg/web/terminal.go):
//   - "shared"        — the default project shell (every viewer shares it)
//   - "session:<sid>" — a shell bound to an OpenCode session
//   - "t:<rand>"      — an ad-hoc extra shell
// The list is local UI state (which tabs YOU have open), persisted so a reload
// restores them; the shells themselves live server-side.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface TermTab {
  id: string;
  title: string;
  session?: string; // bound session id, if this is a session terminal
}

export const SHARED_TAB: TermTab = { id: "shared", title: "Shell" };

type TabsByDir = Record<string, TermTab[]>;
type ActiveByDir = Record<string, string>;

const LS_TABS = "vh.term.tabs.v1";
const LS_ACTIVE = "vh.term.active.v1";

const [tabsByDir, setTabsByDir] = createSignal<TabsByDir>(
  loadVersioned<TabsByDir>(LS_TABS, 1, {}, (o) => (o && typeof o === "object" ? (o as TabsByDir) : {})),
);
const [activeByDir, setActiveByDir] = createSignal<ActiveByDir>(
  loadVersioned<ActiveByDir>(LS_ACTIVE, 1, {}, (o) => (o && typeof o === "object" ? (o as ActiveByDir) : {})),
);

function persistTabs(next: TabsByDir) {
  setTabsByDir(next);
  saveVersioned(LS_TABS, 1, next);
}
function persistActive(next: ActiveByDir) {
  setActiveByDir(next);
  saveVersioned(LS_ACTIVE, 1, next);
}

// Tabs for a dir, always including the shared default first (reactive).
export function termTabs(dir: string): TermTab[] {
  const list = tabsByDir()[dir];
  if (!list || list.length === 0) return [SHARED_TAB];
  return list.some((t) => t.id === SHARED_TAB.id) ? list : [SHARED_TAB, ...list];
}

// The active tab id for a dir, defaulting to the first tab.
export function activeTermId(dir: string): string {
  const a = activeByDir()[dir];
  const tabs = termTabs(dir);
  return a && tabs.some((t) => t.id === a) ? a : tabs[0].id;
}

export function setActiveTermId(dir: string, id: string) {
  persistActive({ ...activeByDir(), [dir]: id });
}

// Materialize the stored list for a dir (with the shared default), so mutations
// write a concrete array back.
function listFor(dir: string): TermTab[] {
  return termTabs(dir).map((t) => ({ ...t }));
}

// Add an ad-hoc shell tab and activate it.
export function newAdHocTab(dir: string) {
  const list = listFor(dir);
  const n = list.filter((t) => t.id.startsWith("t:")).length + 1;
  const id = "t:" + (globalThis.crypto?.randomUUID?.() ?? String(n) + "-" + list.length);
  persistTabs({ ...tabsByDir(), [dir]: [...list, { id, title: `Shell ${n + 1}` }] });
  setActiveTermId(dir, id);
}

// Open (or focus) a terminal bound to a session.
export function bindSessionTab(dir: string, sessionId: string, title: string) {
  const id = "session:" + sessionId;
  const list = listFor(dir);
  if (!list.some((t) => t.id === id)) {
    persistTabs({ ...tabsByDir(), [dir]: [...list, { id, title: title || "Session", session: sessionId }] });
  }
  setActiveTermId(dir, id);
}

// Remove a tab. If it was active, activate a neighbor; never leave zero tabs
// (the shared default is re-seeded). Returns the tab that was removed.
export function removeTermTab(dir: string, id: string): TermTab | undefined {
  const list = listFor(dir);
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) return undefined;
  const removed = list[idx];
  let next = list.filter((t) => t.id !== id);
  if (next.length === 0) next = [{ ...SHARED_TAB }];
  persistTabs({ ...tabsByDir(), [dir]: next });
  if (activeTermId(dir) === id) {
    const neighbor = next[Math.min(idx, next.length - 1)];
    setActiveTermId(dir, neighbor.id);
  }
  return removed;
}
