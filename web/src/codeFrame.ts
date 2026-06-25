// Parent-side bridge to the code viewer, which runs in a same-origin iframe (so
// its heavy DOM — file tree, highlighted files — stays out of the main document).
// Communication is postMessage. The chat opens files across the boundary; the
// parent forwards theme changes so the framed viewer restyles live.
import { createSignal } from "solid-js";
import { codeDockOpen, setCodeDockOpen, codeMobileOverlay, setCodeMobileOverlay, setView, view } from "./ui";
import { isDesktop } from "./layout";

// The current path-like text selection (set by PathSelectionAction). When set,
// the header Code button opens it instead of toggling — a reliable trigger on
// mobile, where the OS selection menu covers the floating "Open file" action.
export const [pathSelection, setPathSelection] = createSignal<string | null>(null);

const ORIGIN = typeof location !== "undefined" ? location.origin : "*";
type Msg = { type: string; [k: string]: unknown };

let frame: HTMLIFrameElement | null = null;
let ready = false;
const pending: Msg[] = [];

function send(msg: Msg) {
  frame?.contentWindow?.postMessage(msg, ORIGIN);
}

// postToCodeFrame queues until the framed viewer reports ready, then delivers.
export function postToCodeFrame(msg: Msg) {
  if (ready && frame?.contentWindow) send(msg);
  else pending.push(msg);
}

// bindCodeFrame is called when the iframe element (re)loads.
export function bindCodeFrame(el: HTMLIFrameElement | null) {
  frame = el;
  ready = false;
}

let installed = false;
// installCodeFrameHost wires the one window listener for messages FROM the frame
// (currently just "ready", which flushes anything queued before it loaded).
export function installCodeFrameHost() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", (e) => {
    if (e.origin !== ORIGIN) return;
    if ((e.data as Msg)?.type === "vh-code:ready") {
      ready = true;
      while (pending.length) send(pending.shift()!);
    }
  });
}

// openFileAt (parent): peek a file/line WITHOUT leaving the current view — opens
// the side dock on desktop, a full-screen overlay on mobile — and tells the
// framed viewer to open it. Accepts a raw "path:line" reference. Called from chat.
export function openFileAt(pathOrRef: string, line?: number) {
  if (isDesktop()) setCodeDockOpen(true);
  else setCodeMobileOverlay(true);
  postToCodeFrame({ type: "vh-code:open", path: pathOrRef, line });
}

// Nudge the framed viewer to re-apply the (shared, same-origin) theme.
export function postCodeTheme() {
  postToCodeFrame({ type: "vh-code:theme" });
}

// Toggle the docked code browser (header button / Ctrl-B). On desktop it opens
// the side dock; from the full Code tab it converts to the dock beside chat. On
// mobile it toggles the full-screen overlay.
export function toggleCodeDock() {
  if (!isDesktop()) {
    setCodeMobileOverlay(!codeMobileOverlay());
    return;
  }
  if (view() === "code") {
    setView("chat");
    setCodeDockOpen(true);
    return;
  }
  setCodeDockOpen(!codeDockOpen());
}

// Whether the code browser is currently showing (dock / full / overlay).
export function codeShowing(): boolean {
  return view() === "code" || codeDockOpen() || codeMobileOverlay();
}
