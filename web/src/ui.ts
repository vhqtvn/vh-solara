// Shared top-level UI state (main view + dialog open-flags), lifted out of App so
// the command palette and global hotkeys can drive them.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

// Built-in views plus consumer-registered embedded views, keyed "view:<id>".
export type BuiltinView = "chat" | "changes" | "notes" | "preferences" | "code";
export type View = BuiltinView | string;
export const VIEW_PREFIX = "view:";
export const isEmbeddedView = (v: string) => v.startsWith(VIEW_PREFIX);
export const embeddedViewId = (v: string) => v.slice(VIEW_PREFIX.length);

export const [view, setView] = createSignal<View>("chat");
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
