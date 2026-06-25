// Small UI preferences (versioned localStorage signals), kept out of the sync store.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

// Live message streaming: when on (default), in-flight assistant text renders
// token-by-token; when off ("block-by-block"), a part shows only once settled.
const STREAM_KEY = "vh.prefs.streamLive.v1";
const [streamLive, setStreamLiveSig] = createSignal<boolean>(
  loadVersioned<boolean>(STREAM_KEY, 1, true, (old) => !(old === 0 || old === "0" || old === false)),
);
export function setStreamLive(on: boolean) {
  setStreamLiveSig(on);
  saveVersioned(STREAM_KEY, 1, on);
}
export { streamLive };

// Session-list density: "compact" (single line per session, the original) or
// "detailed" (two lines — title row + a secondary line with direct-children
// running/idle counts, falling back to started-at when there are none).
const DENSITY_KEY = "vh.prefs.treeDensity.v1";
const [treeDensity, setTreeDensitySig] = createSignal<"compact" | "detailed">(
  loadVersioned<"compact" | "detailed">(DENSITY_KEY, 1, "compact", (o) =>
    o === "detailed" ? "detailed" : "compact",
  ),
);
export function setTreeDensity(v: "compact" | "detailed") {
  setTreeDensitySig(v);
  saveVersioned(DENSITY_KEY, 1, v);
}
export { treeDensity };

// Client UI zoom: the user's own scale control. On mobile we drive the actual
// viewport scale (a real "virtual viewport" zoom the user sets deliberately,
// replacing the disabled pinch-zoom); on desktop, where the viewport meta is
// ignored, we use CSS `zoom`. Clamped 0.5–1.6.
const SCALE_KEY = "vh.prefs.uiScale.v1";
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 1.6;
const [uiScale, setUiScaleSig] = createSignal<number>(loadVersioned<number>(SCALE_KEY, 1, 1));

const VIEWPORT_BASE = "width=device-width, viewport-fit=cover, interactive-widget=resizes-content";
function setViewportScale(scale: number) {
  const meta = document.querySelector('meta[name="viewport"]');
  // Lock the viewport at the user's scale (pinch stays disabled).
  meta?.setAttribute(
    "content",
    `${VIEWPORT_BASE}, initial-scale=${scale}, minimum-scale=${scale}, maximum-scale=${scale}, user-scalable=no`,
  );
}

export function applyScale() {
  const scale = uiScale();
  const root = document.documentElement;
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  // ui-zoom always drives the viewport meta's initial/minimum/maximum-scale —
  // the mechanism that actually scales on mobile (and webviews that honor it).
  setViewportScale(scale);
  if (coarse) {
    // Mobile: the meta scale above does the work; CSS zoom reset so they don't
    // compound, and --ui-zoom stays 1 (no app-height compensation needed).
    (root.style as any).zoom = "";
    root.style.setProperty("--ui-zoom", "1");
  } else {
    // Desktop: the viewport meta is ignored, so CSS `zoom` does the visible
    // scaling. --ui-zoom lets the app height (a fixed px from the visual
    // viewport, which zoom would otherwise render at <100%, leaving dead space)
    // divide it back so it still fills the screen.
    (root.style as any).zoom = String(scale);
    root.style.setProperty("--ui-zoom", String(scale));
  }
}
export function setUiScale(s: number) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));
  setUiScaleSig(clamped);
  saveVersioned(SCALE_KEY, 1, clamped);
  applyScale();
}
export { uiScale };

// Screen orientation: "system" (default — respect the device/OS, including its
// rotation lock) or "auto" (lock to "any" so the app rotates freely even when
// the OS rotation-lock is on). Only effective in an installed PWA / fullscreen
// on most browsers; calls are best-effort and ignored where unsupported.
const ORIENT_KEY = "vh.prefs.orientation.v1";
const [orientation, setOrientationSig] = createSignal<"system" | "auto">(
  loadVersioned<"system" | "auto">(ORIENT_KEY, 1, "system", (o) => (o === "auto" ? "auto" : "system")),
);
export function applyOrientation() {
  const so: any = typeof screen !== "undefined" ? (screen as any).orientation : null;
  if (!so) return;
  try {
    if (orientation() === "auto") {
      const p = so.lock?.("any");
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      so.unlock?.();
    }
  } catch {
    /* unsupported / requires fullscreen — ignore */
  }
}
export function setOrientation(v: "system" | "auto") {
  setOrientationSig(v);
  saveVersioned(ORIENT_KEY, 1, v);
  applyOrientation();
}
export { orientation };

// Chat reading width: the message column + composer max-width, driven through a
// --chat-width CSS var. "comfortable" is the original centered column (good for
// prose); "wide"/"full" reclaim the side space a centered column wastes on a
// large external monitor.
const CHATW_KEY = "vh.prefs.chatWidth.v1";
export type ChatWidth = "comfortable" | "wide" | "full";
const CHATW_PX: Record<ChatWidth, string> = { comfortable: "860px", wide: "1180px", full: "100%" };
const [chatWidth, setChatWidthSig] = createSignal<ChatWidth>(
  loadVersioned<ChatWidth>(CHATW_KEY, 1, "comfortable", (o) =>
    o === "wide" || o === "full" ? o : "comfortable"),
);
export function applyChatWidth() {
  document.documentElement.style.setProperty("--chat-width", CHATW_PX[chatWidth()]);
}
export function setChatWidth(v: ChatWidth) {
  setChatWidthSig(v);
  saveVersioned(CHATW_KEY, 1, v);
  applyChatWidth();
}
export { chatWidth };

// Chat bubbles: render YOUR turns as a right-aligned bubble (Claude/OpenChamber
// style) by toggling a root `chat-bubbles` class. Off → the original quiet
// full-width card. Default on.
const BUBBLE_KEY = "vh.prefs.chatBubbles.v1";
const [chatBubbles, setChatBubblesSig] = createSignal<boolean>(
  loadVersioned<boolean>(BUBBLE_KEY, 1, true, (old) => !(old === 0 || old === "0" || old === false)),
);
export function applyChatBubbles() {
  document.documentElement.classList.toggle("chat-bubbles", chatBubbles());
}
export function setChatBubbles(on: boolean) {
  setChatBubblesSig(on);
  saveVersioned(BUBBLE_KEY, 1, on);
  applyChatBubbles();
}
export { chatBubbles };

// View-tab display style in the header. "labels" (text, the default) and "icons"
// both use priority+ overflow (surplus tabs collapse into a ⋯ menu); "dropdown"
// is a single compact selector that scales to any number of views.
export type TabStyle = "labels" | "icons" | "dropdown";
const TABSTYLE_KEY = "vh.prefs.tabStyle.v1";
const [tabStyle, setTabStyleSig] = createSignal<TabStyle>(
  loadVersioned<TabStyle>(TABSTYLE_KEY, 1, "labels", (o) => (o === "icons" || o === "dropdown" ? o : "labels")),
);
export function setTabStyle(v: TabStyle) {
  setTabStyleSig(v);
  saveVersioned(TABSTYLE_KEY, 1, v);
}
export { tabStyle };

// Code peek dock: which side it docks (desktop) and its width (px), persisted.
const CODE_DOCK_SIDE_KEY = "vh.prefs.codeDockSide.v1";
const [codeDockSide, setCodeDockSideSig] = createSignal<"left" | "right">(
  loadVersioned<"left" | "right">(CODE_DOCK_SIDE_KEY, 1, "right", (o) => (o === "left" ? "left" : "right")),
);
export function setCodeDockSide(v: "left" | "right") {
  setCodeDockSideSig(v);
  saveVersioned(CODE_DOCK_SIDE_KEY, 1, v);
}
export { codeDockSide };

const CODE_DOCK_W_KEY = "vh.prefs.codeDockWidth.v1";
const [codeDockWidth, setCodeDockWidthSig] = createSignal<number>(loadVersioned<number>(CODE_DOCK_W_KEY, 1, 480));
export function setCodeDockWidth(px: number) {
  const clamped = Math.max(280, Math.min(900, Math.round(px)));
  setCodeDockWidthSig(clamped);
  saveVersioned(CODE_DOCK_W_KEY, 1, clamped);
}
export { codeDockWidth };

// Code view: syntax-highlight style (chroma style name; "" = follow the app
// theme via the shared sheet) and soft-wrap toggle. Persisted.
const CODE_STYLE_KEY = "vh.prefs.codeStyle.v1";
const [codeStyle, setCodeStyleSig] = createSignal<string>(loadVersioned<string>(CODE_STYLE_KEY, 1, ""));
export function setCodeStyle(v: string) {
  setCodeStyleSig(v);
  saveVersioned(CODE_STYLE_KEY, 1, v);
}
export { codeStyle };

const CODE_WRAP_KEY = "vh.prefs.codeWrap.v1";
const [codeWrap, setCodeWrapSig] = createSignal<boolean>(
  loadVersioned<boolean>(CODE_WRAP_KEY, 1, false, (o) => o === true || o === 1 || o === "1"),
);
export function setCodeWrap(on: boolean) {
  setCodeWrapSig(on);
  saveVersioned(CODE_WRAP_KEY, 1, on);
}
export { codeWrap };

// Notes feature: global enable for the Notes tab. Default OFF. A project can
// override per-repo via `.vh-solara/project.jsonc` "notes" (see projectSettings
// → notesVisible, which layers the per-project value over this global default).
const NOTES_KEY = "vh.prefs.notesEnabled.v1";
const [notesEnabled, setNotesEnabledSig] = createSignal<boolean>(
  loadVersioned<boolean>(NOTES_KEY, 1, false, (old) => old === true || old === 1 || old === "1"),
);
export function setNotesEnabled(on: boolean) {
  setNotesEnabledSig(on);
  saveVersioned(NOTES_KEY, 1, on);
}
export { notesEnabled };
