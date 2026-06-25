// Small UI preferences (versioned localStorage signals), kept out of the sync
// store. Each is a persistedSignal (hydrate on load, persist on set); setters
// that also touch the DOM wrap it with the side effect.
import { persistedSignal, boolMigrate } from "./lib/store";

// Live message streaming: when on (default), in-flight assistant text renders
// token-by-token; when off ("block-by-block"), a part shows only once settled.
export const [streamLive, setStreamLive] = persistedSignal<boolean>("vh.prefs.streamLive.v1", 1, true, boolMigrate(true));

// Session-list density: "compact" (single line per session, the original) or
// "detailed" (two lines — title row + a secondary line with direct-children
// running/idle counts, falling back to started-at when there are none).
export const [treeDensity, setTreeDensity] = persistedSignal<"compact" | "detailed">(
  "vh.prefs.treeDensity.v1",
  1,
  "compact",
  (o) => (o === "detailed" ? "detailed" : "compact"),
);

// Client UI zoom: the user's own scale control. On mobile we drive the actual
// viewport scale (a real "virtual viewport" zoom the user sets deliberately);
// on desktop, where the viewport meta is ignored, we use CSS `zoom`. Clamped.
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 1.6;
const [uiScale, setUiScaleRaw] = persistedSignal<number>("vh.prefs.uiScale.v1", 1, 1);
export { uiScale };

const VIEWPORT_BASE = "width=device-width, viewport-fit=cover, interactive-widget=resizes-content";
function setViewportScale(scale: number) {
  const meta = document.querySelector('meta[name="viewport"]');
  // Seed the user's UI-zoom as the baseline, but DON'T lock it — pinch-zoom must
  // stay available (WCAG 1.4.4). Allow a generous range around the baseline.
  const min = Math.max(0.25, scale * 0.5).toFixed(2);
  const max = Math.min(10, scale * 4).toFixed(2);
  meta?.setAttribute("content", `${VIEWPORT_BASE}, initial-scale=${scale}, minimum-scale=${min}, maximum-scale=${max}`);
}

export function applyScale() {
  const scale = uiScale();
  const root = document.documentElement;
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  // ui-zoom always drives the viewport meta's initial/min/max-scale — the
  // mechanism that actually scales on mobile (and webviews that honor it).
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
  setUiScaleRaw(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100)));
  applyScale();
}

// Screen orientation: "system" (respect the device/OS, incl. its rotation lock)
// or "auto" (lock to "any" so the app rotates freely). Only effective in an
// installed PWA / fullscreen on most browsers; best-effort, ignored elsewhere.
const [orientation, setOrientationRaw] = persistedSignal<"system" | "auto">(
  "vh.prefs.orientation.v1",
  1,
  "system",
  (o) => (o === "auto" ? "auto" : "system"),
);
export { orientation };
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
  setOrientationRaw(v);
  applyOrientation();
}

// Chat reading width: the message column + composer max-width, via --chat-width.
// "comfortable" is the original centered column; "wide"/"full" reclaim side space.
export type ChatWidth = "comfortable" | "wide" | "full";
const CHATW_PX: Record<ChatWidth, string> = { comfortable: "860px", wide: "1180px", full: "100%" };
const [chatWidth, setChatWidthRaw] = persistedSignal<ChatWidth>(
  "vh.prefs.chatWidth.v1",
  1,
  "comfortable",
  (o) => (o === "wide" || o === "full" ? o : "comfortable"),
);
export { chatWidth };
export function applyChatWidth() {
  document.documentElement.style.setProperty("--chat-width", CHATW_PX[chatWidth()]);
}
export function setChatWidth(v: ChatWidth) {
  setChatWidthRaw(v);
  applyChatWidth();
}

// Chat bubbles: render YOUR turns as a right-aligned bubble by toggling a root
// `chat-bubbles` class. Off → the original quiet full-width card. Default on.
const [chatBubbles, setChatBubblesRaw] = persistedSignal<boolean>("vh.prefs.chatBubbles.v1", 1, true, boolMigrate(true));
export { chatBubbles };
export function applyChatBubbles() {
  document.documentElement.classList.toggle("chat-bubbles", chatBubbles());
}
export function setChatBubbles(on: boolean) {
  setChatBubblesRaw(on);
  applyChatBubbles();
}

// View-tab display style in the header. "labels" (text, default) and "icons"
// both use priority+ overflow; "dropdown" is a single compact selector.
export type TabStyle = "labels" | "icons" | "dropdown";
export const [tabStyle, setTabStyle] = persistedSignal<TabStyle>(
  "vh.prefs.tabStyle.v1",
  1,
  "labels",
  (o) => (o === "icons" || o === "dropdown" ? o : "labels"),
);

// Code tree: show git-ignored entries (node_modules, build output, …). Off by
// default so the tree stays clean; toggle in the viewer to reveal them (dimmed).
export const [codeShowIgnored, setCodeShowIgnored] = persistedSignal<boolean>(
  "vh.prefs.codeShowIgnored.v1",
  1,
  false,
  boolMigrate(false),
);

// Code tree: compact single-child folder chains (a/b/c as one row), VS Code's
// "compact folders". On by default — keeps deep package trees shallow.
export const [codeFlatten, setCodeFlatten] = persistedSignal<boolean>("vh.prefs.codeFlatten.v1", 1, true, boolMigrate(true));

// Code viewer: show the files sidebar (the tree column). Toggle to give the open
// file the full width on desktop. Visible by default.
export const [codeSidebarOpen, setCodeSidebarOpen] = persistedSignal<boolean>(
  "vh.prefs.codeSidebarOpen.v1",
  1,
  true,
  boolMigrate(true),
);

// Code sidebar: show the search box. Toggled from the tree's filter menu so the
// sidebar can be all-tree when search isn't needed. Visible by default.
export const [codeShowSearch, setCodeShowSearch] = persistedSignal<boolean>(
  "vh.prefs.codeShowSearch.v1",
  1,
  true,
  boolMigrate(true),
);

// Code peek dock: which side it docks (desktop) and its width (px), persisted.
export const [codeDockSide, setCodeDockSide] = persistedSignal<"left" | "right">(
  "vh.prefs.codeDockSide.v1",
  1,
  "right",
  (o) => (o === "left" ? "left" : "right"),
);

const [codeDockWidth, setCodeDockWidthRaw] = persistedSignal<number>("vh.prefs.codeDockWidth.v1", 1, 480);
export { codeDockWidth };
export function setCodeDockWidth(px: number) {
  setCodeDockWidthRaw(Math.max(280, Math.min(900, Math.round(px))));
}

// Code view: syntax-highlight style (chroma style name; "" = follow the app
// theme via the shared sheet) and soft-wrap toggle. Persisted.
export const [codeStyle, setCodeStyle] = persistedSignal<string>("vh.prefs.codeStyle.v1", 1, "");
export const [codeWrap, setCodeWrap] = persistedSignal<boolean>("vh.prefs.codeWrap.v1", 1, false, boolMigrate(false));

// Notes feature: global enable for the Notes tab. Default OFF. A project can
// override per-repo via `.vh-solara/project.jsonc` "notes".
export const [notesEnabled, setNotesEnabled] = persistedSignal<boolean>(
  "vh.prefs.notesEnabled.v1",
  1,
  false,
  boolMigrate(false),
);
