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

// Captured exactly once, at script-run (== document load). NEVER reassigned.
const MOUNT_TS = Date.now();
const NONCE =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

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

function postToParent(msg: unknown): void {
  // Mock content; messages carry no secrets, so '*' target is acceptable for
  // Phase 1. The host→iframe direction is targeted precisely (host knows the
  // :5174 origin).
  parent.postMessage(msg, PARENT_ORIGIN);
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
  postToParent({
    type: "heartbeat",
    mountTs: MOUNT_TS,
    nonce: NONCE,
    uptime: Date.now() - MOUNT_TS,
    connId,
    src: location.href,
  });
}, HEARTBEAT_MS);

// ---- host → pane: focus / blur (visual ack of the contract) ---------------

window.addEventListener("message", (ev) => {
  const data = ev.data as { type?: string };
  if (data && data.type === "focus") {
    app.classList.add("is-focused");
  } else if (data && data.type === "blur") {
    app.classList.remove("is-focused");
  }
});
