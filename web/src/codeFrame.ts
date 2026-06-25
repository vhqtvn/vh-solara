// Parent-side bridge to the code viewer, which runs in a same-origin iframe (so
// its heavy DOM — file tree, highlighted files — stays out of the main document).
// Communication is postMessage. The chat opens files across the boundary; the
// parent forwards theme changes so the framed viewer restyles live.
import { setView } from "./ui";

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

// openFileAt (parent): switch to the Code tab and tell the framed viewer to open
// the file/line. Accepts a raw "path:line" reference. Called from the chat.
export function openFileAt(pathOrRef: string, line?: number) {
  setView("code");
  postToCodeFrame({ type: "vh-code:open", path: pathOrRef, line });
}

// Nudge the framed viewer to re-apply the (shared, same-origin) theme.
export function postCodeTheme() {
  postToCodeFrame({ type: "vh-code:theme" });
}
