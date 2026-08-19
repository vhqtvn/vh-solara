// Shared top-level UI state (main view + dialog open-flags), lifted out of App so
// the command palette and global hotkeys can drive them.
import { createRoot, createSignal } from "solid-js";
import { bindBackDismiss, pushBackSurface, releaseBackSurface, type BackSurface } from "./lib/backStack";
import { loadVersioned, saveVersioned } from "./lib/store";

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
// First-open default (ALL contexts — standalone and embedded host-shell iframe
// alike): the dock opens DOCKED at the bottom (300px default, height persisted
// via vh.term.height.v1); the user expands to overlay-full (.full in
// TerminalDock.css) explicitly via the Dock/Full-screen toggle. This REVERSES
// the earlier S1b embedded default (the first embedded open forced
// overlay-full so opening a terminal never permanently consumed pane vertical
// space) at operator request — docked-first is the desired behavior
// everywhere. termFull stays session-scoped (deliberately non-persisted) and
// initializes false, so bindBackDismiss(termFull, …) below never pushes a
// back-history token at load, before any terminal is open (pinned in
// termEmbeddedDefault.test.ts).
export const [termOpen, setTermOpen] = createSignal(false);
export const [termFull, setTermFull] = createSignal(false);
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
