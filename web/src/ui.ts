// Shared top-level UI state (main view + dialog open-flags), lifted out of App so
// the command palette and global hotkeys can drive them.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

// Built-in views plus consumer-registered embedded views, keyed "view:<id>".
export type BuiltinView = "chat" | "changes" | "notes";
export type View = BuiltinView | string;
export const VIEW_PREFIX = "view:";
export const isEmbeddedView = (v: string) => v.startsWith(VIEW_PREFIX);
export const embeddedViewId = (v: string) => v.slice(VIEW_PREFIX.length);

export const [view, setView] = createSignal<View>("chat");
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [adminOpen, setAdminOpen] = createSignal(false);
export const [paletteOpen, setPaletteOpen] = createSignal(false);
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
