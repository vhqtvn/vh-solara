// Cross-origin mock "vh-solara server" content.
//
// SURVIVAL CONTRACT (load-bearing for the whole multi-server architecture):
// a <iframe> that is moved/reparented in the DOM RELOADS in current browsers.
// The host container therefore keeps each iframe element permanently mounted
// (Dockview renderer:'always') and changes only geometry/visibility. This page
// makes that guarantee *observable*:
//
//   - mountTs + nonce are captured ONCE per document load. They change iff the
//     iframe document was destroyed and recreated (a reload).
//   - a WebSocket to the echo server (:5175) is opened per load; the server
//     assigns an incrementing connId. connId changes iff the socket reconnected
//     (which, for a never-unloaded iframe, only happens on a real reload).
//   - the page heartbeats all three to its parent at ~4 Hz.
//
// Survived ⇔ mountTs + nonce UNCHANGED, uptime CLIMBING, connId STABLE.
// The two negative controls (naive remove+re-add; toJSON→fromJSON reswap) each
// force a reload, so all three change — proving the gate actually detects one.

const PARENT_ORIGIN =
  new URLSearchParams(location.search).get("parent") ?? "*";

// mountTs captured exactly once, at script-run (== document load). NEVER
// reassigned. Changes iff the iframe document was destroyed and recreated.
const MOUNT_TS = Date.now();
// nonce is the host's handshake CHALLENGE echoed back (constraint #4: the host
// knows the expected value before accepting a heartbeat). Captured from the
// inbound handshake exactly once per load (the host issues one handshake per
// load); null until the handshake arrives, so heartbeats hold off until then
// (mirrors the real SPA in web/src/heartbeat.ts). Changes on reload because a
// reload is a new document that receives a fresh handshake with a fresh nonce.
let nonce: string | null = null;

const params = new URLSearchParams(location.search);
const SERVER = params.get("server") ?? "unknown";
const VIEW = (params.get("view") ?? "chat") as MockView;

type MockView = "chat" | "terminal" | "diff" | "sessions";

// ---- view rendering --------------------------------------------------------

const app = document.getElementById("app")!;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderChat(root: HTMLElement, server: string): void {
  root.appendChild(el("div", "view-label", `chat · ${server}`));
  const msgs: Array<[string, string]> = [
    ["user", "Summarize the auth flow in pkg/web/auth.go."],
    ["assistant", "It uses a host-scoped SameSite=Lax cookie issued on /vh/login."],
    ["user", "And the WebSocket?"],
    ["assistant", "Same cookie; the upgrade handshake re-validates it server-side."],
  ];
  const list = el("div", "chat-list");
  for (const [role, text] of msgs) {
    const row = el("div", `chat-msg chat-${role}`);
    row.appendChild(el("span", "chat-role", role));
    row.appendChild(el("span", "chat-text", text));
    list.appendChild(row);
  }
  root.appendChild(list);
}

function renderTerminal(root: HTMLElement, server: string): void {
  root.appendChild(el("div", "view-label", `terminal · ${server}`));
  const lines = [
    "$ git status",
    "On branch main\nnothing to commit, working tree clean",
    "$ go build ./...",
    "$ go test ./pkg/state/...",
    "ok  github.com/vhqtvn/vh-solara/pkg/state",
    "$ ",
  ];
  const body = el("div", "term-body");
  for (const l of lines) body.appendChild(el("div", "term-line", l));
  root.appendChild(body);
}

function renderDiff(root: HTMLElement, server: string): void {
  root.appendChild(el("div", "view-label", `diff · ${server}`));
  const body = el("div", "diff-body");
  const lines: Array<[string, string]> = [
    ["hunk", "@@ -12,7 +12,9 @@ func handleLogin(w http.ResponseWriter, r *http.Request) {"],
    ["ctx", " \tctx := r.Context()"],
    ["ctx", " \tname := r.FormValue(\"user\")"],
    ["del", "-\tif name != \"\" {"],
    ["del", "-\t\tsessions[name] = newSession()"],
    ["del", "-\t}"],
    ["add", "+\tsess := newSession(name)"],
    ["add", "+\tcookie := http.Cookie{Name: \"vh-sess\", Value: sess.ID(),"],
    ["add", "+\t\tHttpOnly: true, SameSite: http.SameSiteLaxMode}"],
    ["ctx", " \thttp.SetCookie(w, &cookie)"],
  ];
  for (const [kind, text] of lines) {
    body.appendChild(el("div", `diff-line diff-${kind}`, text));
  }
  root.appendChild(body);
}

function renderSessions(root: HTMLElement, server: string): void {
  root.appendChild(el("div", "view-label", `sessions · ${server}`));
  const tree: Array<[number, string]> = [
    [0, "▾ srv-A · main"],
    [1, "● session-1 (chat, running)"],
    [1, "● session-2 (git diff)"],
    [2, "↳ sub: review pkg/web/auth.go"],
    [0, "▸ srv-A · feature/x"],
    [0, "▸ srv-B · main"],
  ];
  const body = el("div", "tree-body");
  for (const [depth, label] of tree) {
    const node = el("div", "tree-node");
    node.style.setProperty("--depth", String(depth));
    node.textContent = label;
    body.appendChild(node);
  }
  root.appendChild(body);
}

function renderView(): void {
  app.innerHTML = "";
  app.dataset.server = SERVER;
  app.dataset.view = VIEW;
  switch (VIEW) {
    case "chat":
      renderChat(app, SERVER);
      break;
    case "terminal":
      renderTerminal(app, SERVER);
      break;
    case "diff":
      renderDiff(app, SERVER);
      break;
    case "sessions":
      renderSessions(app, SERVER);
      break;
    default:
      app.appendChild(el("div", "view-label", `${VIEW} · ${SERVER}`));
  }
}

renderView();

// ---- pane → host: title + route (minimal postMessage contract) -----------

// Q2-A: the host origin is captured from the inbound handshake's
// MessageEvent.origin (browser-validated). Until the handshake arrives, fall
// back to the ?parent= query param / '*' (non-secret mock payload). This mirrors
// what the real SPA does (web/src/heartbeat.ts) — the mock is the faithful
// embedded-SPA stand-in. The mock echoes the host's handshake challenge nonce
// (constraint #4) and heartbeats once the nonce is captured; connId (WS negative
// control) is optional. See docs/heartbeat-protocol.md §7.
let hostOrigin: string | null = null;

function postToParent(msg: unknown): void {
  // Mock content; messages carry no secrets. Reply to the captured host origin
  // when known (Q2-A); otherwise the ?parent= param or '*' fallback. The host→
  // iframe direction is targeted precisely (host knows the :5174 origin).
  parent.postMessage(msg, hostOrigin ?? PARENT_ORIGIN);
}

postToParent({ type: "title", title: `${SERVER} · ${VIEW}` });
postToParent({ type: "route" });

// ---- WebSocket echo (connId = reload signal) ------------------------------

let connId: number | null = null;
let socket: WebSocket | null = null;
const WS_URL = "ws://127.0.0.1:5175";

function connectWs(): void {
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    socket = null;
    return;
  }
  socket.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data) as { type?: string; connId?: number };
      if (data.type === "welcome" && typeof data.connId === "number") {
        connId = data.connId;
      }
    } catch {
      /* ignore non-JSON frames */
    }
  });
  socket.addEventListener("close", () => {
    // A dropped socket WITHOUT a document reload is unusual here; if it
    // happens, connId stays stale (no false reload signal). A real reload
    // re-runs this whole script → fresh mountTs/nonce + a fresh socket.
  });
}
connectWs();

// ---- heartbeat → parent (~4 Hz) -------------------------------------------

const HEARTBEAT_MS = 250;
window.setInterval(() => {
  // Hold off until the host has handshaked (challenge nonce captured). Mirrors
  // the real SPA (web/src/heartbeat.ts): the host is waiting for the issued
  // challenge on the first post-load heartbeat, so a heartbeat before the
  // handshake would carry no echoable nonce.
  if (nonce === null) return;
  postToParent({
    type: "heartbeat",
    mountTs: MOUNT_TS,
    nonce,
    uptime: Date.now() - MOUNT_TS,
    connId,
    src: location.href,
  });
}, HEARTBEAT_MS);

// ---- host → pane: focus / blur (visual ack of the contract) ---------------

window.addEventListener("message", (ev) => {
  const data = ev.data as { type?: string; nonce?: string };
  if (data && data.type === "vh-host-handshake") {
    // F1 (inbound source-guard): mirror the real SPA (web/src/heartbeat.ts)
    // EXACTLY — only the actual parent window may establish the heartbeat
    // target. A handshake from any other source (e.g. an untrusted sibling
    // frame that grabbed this window via window.parent.frames[index]) is
    // ignored, so it cannot capture this document's origin/nonce or redirect
    // its heartbeats. The mock MUST stay faithful to the production emitter:
    // the survival + heartbeat gates depend on identical behavior here.
    // event.source for the real host handshake is window.parent (the host calls
    // this contentWindow's postMessage directly in sendHandshake/postToPane).
    if (ev.source !== window.parent) return;
    // Q2-A: capture the browser-validated host origin for targeted replies.
    // Constraint #4: capture the host's challenge nonce and echo it in every
    // heartbeat (the host verifies the first post-load heartbeat carries this
    // value). One handshake per load ⇒ nonce is stable for the document's life
    // and changes on reload (new document ⇒ new handshake ⇒ new nonce).
    hostOrigin = ev.origin;
    if (typeof data.nonce === "string") nonce = data.nonce;
  } else if (data && data.type === "focus") {
    app.classList.add("is-focused");
  } else if (data && data.type === "blur") {
    app.classList.remove("is-focused");
  }
});
