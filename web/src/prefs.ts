// Small UI preferences (versioned localStorage signals), kept out of the sync
// store. Each is a persistedSignal (hydrate on load, persist on set). The
// DOM-affecting ones apply REACTIVELY (see the createRenderEffect block at the
// bottom): the signal is the single source of truth, so setters just set it and
// there's no boot list to keep in sync in index.tsx.
import { createRenderEffect, createRoot } from "solid-js";
import { persistedSignal, boolMigrate } from "./lib/store";

// Live message streaming: when on (default), in-flight assistant text renders
// token-by-token; when off ("block-by-block"), a part shows only once settled.
export const [streamLive, setStreamLive] = persistedSignal<boolean>("vh.prefs.streamLive.v1", 1, true, boolMigrate(true));

// Session-list density: "compact" (single line per session, the original) or
// "detailed" (two lines — title row + a secondary line with direct-children
// running/idle counts, falling back to started-at when there are none).
//
// NOTE: currently INERT under tree=2. The only functional consumer was the
// deleted proj=1 `Node` render; the tree=2 `TreeRow` does NOT read
// `treeDensity()`, so the Settings→Appearance "Detailed" option has no effect
// today. The pref (and its Settings control) is RETAINED as the placeholder for
// a future tree=2 detailed-density variant (an explicitly-deferred feature,
// out of scope here) — removing it would delete a user-visible Settings control
// (a minor UX/behavior change) while the feature remains planned. Do NOT
// half-implement density without wiring TreeRow to read this signal.
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
export const MAX_SCALE = 2.0; // 200% — the WCAG 1.4.4 reference level for text resize / zoom.
const [uiScale, setUiScaleRaw] = persistedSignal<number>("vh.prefs.uiScale.v1", 1, 1);
export { uiScale };

const VIEWPORT_BASE = "width=device-width, viewport-fit=cover, interactive-widget=resizes-content";
function setViewportScale(scale: number) {
  const meta = document.querySelector('meta[name="viewport"]');
  // Pinch-zoom is DISABLED on purpose. A pinch shrinks visualViewport.height,
  // which --app-h (see viewport.ts) feeds straight into .app's height
  // (styles.css: calc(var(--app-h) / var(--ui-zoom))) — so a pinch pushes the
  // composer up off the bottom and leaves dead space below .app. Locking
  // minimum-scale = maximum-scale = the UI-zoom baseline (plus user-scalable=no)
  // keeps visualViewport.height stable; it then only changes for the keyboard /
  // orientation, which is exactly the case --app-h was built to track. The UI-zoom
  // slider (Settings) remains the single, deliberate zoom control, so WCAG 1.4.4
  // (resize text/zoom) is still satisfied — just not via a gesture that breaks the
  // layout model.
  const s = scale.toFixed(2);
  meta?.setAttribute(
    "content",
    `${VIEWPORT_BASE}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`,
  );
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

// Performance diagnostics viewer: opt-in surface that shows the always-on
// server-side latency probes (GET /vh/diag/latency) in a dialog the operator
// can read and copy. Default OFF so a normal user sees zero UI for it; the
// probes themselves are always collected (low-overhead aggregations — most hot
// paths are atomic/lock-free; the tunnel write path samples a lock-free global
// active-stream gauge per write and defers its only per-session yamux
// NumStreams() read to threshold-gated ≥100ms slow-write incidents; see
// pkg/diagnostics and pkg/tunnel/websocket.go). Enabling only adds a
// "Performance" entry to the server-admin menu's Diagnostics section; it does
// NOT change collection.
export const [perfDiagEnabled, setPerfDiagEnabled] = persistedSignal<boolean>(
  "vh.prefs.perfDiagEnabled.v1",
  1,
  false,
  boolMigrate(false),
);

// Apply the DOM-affecting prefs reactively: each render-effect runs once now
// (synchronous initial apply, before first paint) and again whenever its signal
// changes. Replaces the manual apply() calls in setters + the boot list in
// index.tsx. Guarded for non-DOM (unit-test) contexts.
if (typeof document !== "undefined") {
  createRoot(() => {
    createRenderEffect(applyScale);
    createRenderEffect(applyChatWidth);
    createRenderEffect(applyChatBubbles);
    createRenderEffect(applyOrientation);
  });
}
