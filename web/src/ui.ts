// Shared top-level UI state (main view + dialog open-flags), lifted out of App so
// the command palette and global hotkeys can drive them.
import { createRoot, createSignal } from "solid-js";
import { bindBackDismiss, pushBackSurface, releaseBackSurface, type BackSurface } from "./lib/backStack";
import { loadVersioned, saveVersioned } from "./lib/store";
import { isEmbedded } from "./embedded";

// Built-in views plus consumer-registered embedded views, keyed "view:<id>".
export type BuiltinView = "chat" | "changes" | "notes" | "preferences" | "code";
export type View = BuiltinView | string;
export const VIEW_PREFIX = "view:";
export const isEmbeddedView = (v: string) => v.startsWith(VIEW_PREFIX);
export const embeddedViewId = (v: string) => v.slice(VIEW_PREFIX.length);

const [view, setViewCore] = createSignal<View>("chat");
export { view };
// App-like back semantics for view swaps: leaving chat for any other view
// (changes/notes/preferences/code/embedded) pushes a back-stack token whose
// close returns to the view we came from, so browser back unwinds chained
// swaps in LIFO order and always eventually returns to chat. Going to chat
// explicitly collapses the whole chain (topmost entry consumed, buried ones
// become orphans that auto-unwind — never ghosts).
let viewTokens: BackSurface[] = [];
export function setView(next: View) {
  const prev = view();
  if (next === prev) return;
  if (next === "chat") {
    const chain = viewTokens;
    viewTokens = [];
    for (let i = chain.length - 1; i >= 0; i--) releaseBackSurface(chain[i]);
  } else {
    const origin = prev;
    const tok = pushBackSurface(() => {
      viewTokens = viewTokens.filter((t) => t !== tok);
      setViewCore(origin);
    }, "view");
    if (tok) viewTokens.push(tok);
  }
  setViewCore(next);
}
// Code viewer peek: a side dock (desktop) beside the current view, or a
// full-screen overlay (mobile), opened by clicking a file:line in the chat. The
// Code TAB is the separate full "dig" mode (view === "code").
export const [codeDockOpen, setCodeDockOpen] = createSignal(false);
export const [codeMobileOverlay, setCodeMobileOverlay] = createSignal(false);
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [adminOpen, setAdminOpen] = createSignal(false);
// Hidden diagnostic-log viewer (cold-open timing ring buffer). Reached from the
// server-admin menu (right-click / long-press Settings), not a visible button.
export const [diagLogOpen, setDiagLogOpen] = createSignal(false);
// OpenCode process-logs viewer (always-accessible ring tail). Reached from the
// server-admin menu's Diagnostics section, sibling to the diagnostic log.
export const [ocLogsOpen, setOcLogsOpen] = createSignal(false);
// Performance diagnostics viewer (opt-in via Settings → General). Reached from
// the server-admin menu's Diagnostics section, only when perfDiagEnabled is on.
// Reads the always-on GET /vh/diag/latency probes on demand (open → fetch →
// render; close). No polling by default.
export const [perfDiagOpen, setPerfDiagOpen] = createSignal(false);
export const [paletteOpen, setPaletteOpen] = createSignal(false);
// Project switcher dialog open-flag, lifted global so the no-project empty
// state's CTA can open the switcher from outside the ProjectSwitcher component
// (it lives in App → .view-primary, a sibling of the sidebar switcher trigger).
export const [projSwitcherOpen, setProjSwitcherOpen] = createSignal(false);
// Terminal: a bottom dock that can expand to full-screen (always full on mobile).
//
// S1b embedded default: when this SPA runs inside the host shell's iframe
// (isEmbedded()), the dock's DEFAULT presentation on its first open in a
// session is overlay-full (.full in TerminalDock.css) — opening a terminal
// never permanently consumes pane vertical space. Standalone keeps the
// bottom-dock default. The default is applied at first OPEN, not by
// initializing the signal true: bindBackDismiss(termFull, …) below would
// otherwise push a back-history token at every embedded load — before any
// terminal is open — swallowing the first back press (pinned in
// termEmbeddedDefault.test.ts). Any explicit setTermFull (the Dock/Full-screen
// toggle, or a back-dismissal of the overlay) records the session's choice,
// which then wins over the default for the rest of the session — matching the
// signal's existing session-scoped (deliberately non-persisted) lifetime. No
// persistence is added.
const [termOpen, setTermOpenCore] = createSignal(false);
const [termFull, setTermFullCore] = createSignal(false);
export { termOpen, termFull };
// True once a terminal presentation exists for this session — either the
// embedded default was applied (first open) or the user toggled explicitly.
let termPresentationSet = false;
export function setTermOpen(v: boolean | ((prev: boolean) => boolean)) {
  const open = typeof v === "function" ? v(termOpen()) : v;
  if (open && !termPresentationSet) {
    termPresentationSet = true;
    if (isEmbedded()) setTermFullCore(true);
  }
  setTermOpenCore(open);
}
export function setTermFull(v: boolean | ((prev: boolean) => boolean)) {
  termPresentationSet = true;
  setTermFullCore(typeof v === "function" ? v(termFull()) : v);
}
// Toggleable on-screen key bar (esc/tab/ctrl/arrows). Persisted; default on.
const [termKeys, setTermKeysSig] = createSignal<boolean>(
  loadVersioned<boolean>("vh.term.keys.v1", 1, true, (o) => o !== false && o !== 0 && o !== "0"),
);
export { termKeys };
export function setTermKeys(v: boolean) {
  setTermKeysSig(v);
  saveVersioned("vh.term.keys.v1", 1, v);
}

// Ask the active chat composer to focus (ChatView listens). A plain DOM event
// avoids threading a ref through the tree.
export function focusComposer() {
  window.dispatchEvent(new CustomEvent("vh:focus-composer"));
}

// Back-dismissal for every global open-flag: while a flag is true a back-stack
// token is pushed; browser back closes the topmost surface (signal → false),
// never the session selection. Module-level root: these live for the app's
// whole lifetime, matching the signals themselves.
createRoot(() => {
  bindBackDismiss(settingsOpen, () => setSettingsOpen(false), "settings");
  bindBackDismiss(adminOpen, () => setAdminOpen(false), "admin");
  bindBackDismiss(diagLogOpen, () => setDiagLogOpen(false), "diaglog");
  bindBackDismiss(ocLogsOpen, () => setOcLogsOpen(false), "oclogs");
  bindBackDismiss(perfDiagOpen, () => setPerfDiagOpen(false), "perfdiag");
  bindBackDismiss(paletteOpen, () => setPaletteOpen(false), "palette");
  bindBackDismiss(projSwitcherOpen, () => setProjSwitcherOpen(false), "projswitch");
  bindBackDismiss(termOpen, () => setTermOpen(false), "term");
  bindBackDismiss(termFull, () => setTermFull(false), "termfull");
  bindBackDismiss(codeDockOpen, () => setCodeDockOpen(false), "codedock");
  bindBackDismiss(codeMobileOverlay, () => setCodeMobileOverlay(false), "codemobile");
});
