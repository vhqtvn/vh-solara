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

// ---- pane → host: session-attention status echo (tail-follow) ---------------
// Stand-in for the real SPA's statusEmitter (web/src/statusEmitter.ts): once
// the host handshake establishes the reply origin, report a {type:"status"}
// message idempotent-on-change. The mock models only the tail-follow facet
// (`following`); dir/session/title/attention/activity carry the honest neutral
// values (the mock has no session tree). `following` flips when the modeled
// reader scrolls away from / back to the tail (the click affordance below) and
// when a valid host tail command lands, so the host's Tail row round-trips
// through the SAME status bridge the real SPA uses.
//
// TAB-PAIRS: the payload also carries the two per-pane aggregate fields the
// real emitter now sends. The mock has no session tree, so it reports the
// honest neutral (0|0); e2e drives arbitrary values through the host's DEV
// bridge (probeStatus routes a full payload through the REAL router), which is
// the deterministic stand-in for "the SPA's store derived these counts".
let tailFollowing = true;

function postStatus(): void {
  postToParent({
    type: "status",
    dir: "",
    session: "",
    title: "",
    attention: "none",
    activity: "unknown",
    following: tailFollowing,
    runningCount: 0,
    unreadCount: 0,
  });
}

// Model the reader's scroll position: a click in the mock's chat area toggles
// between "reading history" (following=false — the reader scrolled up) and
// "at the tail" (following=true — scrolled back to the bottom). This is the
// deterministic e2e hook for reaching following=false WITHOUT a real scroll
// container; the real SPA produces the same transition via its scroll
// classifier. Surfaced in the DOM (data-tail-following) so a gate can assert
// the modeled state directly.
app.addEventListener("click", () => {
  tailFollowing = !tailFollowing;
  app.dataset.tailFollowing = String(tailFollowing);
  postStatus();
});
app.dataset.tailFollowing = String(tailFollowing);

// ---- pane-activate forward (mock stand-in for web/src/hostGesture.ts) -------
// The REAL SPA forwards {type:"host-gesture",gesture:"pane-activate"} on every
// focus/pointerdown/focusin inside the pane (capture-phase listeners) — the
// cross-origin activation bridge (a tap inside a cross-origin iframe does not
// bubble to the host). The mock mirrors the pointerdown forward (the tap path)
// so lane-7 e2e can exercise the REAL gesture → postMessage → router chain:
// a genuine click inside this iframe posts the same CLOSED payload the real
// SPA posts, and the host's activation + anchored-popover dismissal react
// identically (routeMessage derives the pane from event.source; the payload
// carries no ids).
document.addEventListener(
  "pointerdown",
  () => {
    postToParent({ type: "host-gesture", gesture: "pane-activate" });
  },
  // Capture phase — mirrors the real SPA: an element/library handler calling
  // stopPropagation on the bubble path cannot block the forward.
  true,
);

// P4 reverse-nav (mock stand-in for the real SPA's selectListener): the host
// posts {type:'vh-host-select',dir,session} to direct this mock pane to a
// specific {dir, session} WITHOUT reloading (a survival-safe SPA-internal route
// change). The mock stand-in cannot run setSelectedId/switchProject (it is not
// the real SPA), so it models the round-trip the real SPA's heartbeat loop
// produces: capture the target as the mock's current route + re-emit
// {type:'route',route} so the host's route-capture (updateRoute) observes the
// round-trip. Source-guards + payload-allowlist mirror the real SPA's
// selectListener EXACTLY so this stays a faithful stand-in (the survival +
// reverse-nav gates depend on identical behavior here).
let currentRoute = "";

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
    // The handshake establishes the reply origin: report the initial status
    // (tail-follow state), mirroring the real SPA's statusEmitter which starts
    // its idempotent-on-change emission once the origin is captured.
    postStatus();
  } else if (data && data.type === "focus") {
    app.classList.add("is-focused");
  } else if (data && data.type === "blur") {
    app.classList.remove("is-focused");
  } else if (data && data.type === "vh-host-select") {
    // F1 (inbound source-guard): mirror the real SPA's selectListener
    // (web/src/selectListener.ts) EXACTLY — only the actual parent window may
    // drive a select. An untrusted sibling pane that grabbed this window's
    // WindowProxy must not hijack the mock's route (which would spoof the
    // round-trip the survival/reverse-nav gates assert on). event.source for
    // the real host select is window.parent.
    if (ev.source !== window.parent) return;
    // CF1 payload allowlist: dir + session MUST be strings (drop everything
    // else — a poison field never reaches the route). Mirrors the real SPA.
    const sel = data as { dir?: unknown; session?: unknown };
    if (typeof sel.dir !== "string" || typeof sel.session !== "string") return;
    // Model the round-trip: capture the target as the mock's current route +
    // re-emit {type:'route',route} exactly as the real SPA's heartbeat-loop
    // emission would after an SPA-internal setSelectedId/switchProject. The
    // host's routeMessage captures it via updateRoute (survival-safe — params
    // only, no src change). Surface in the DOM so a gate can assert the select
    // was received (deterministic, not network-bound).
    currentRoute = `?dir=${encodeURIComponent(sel.dir)}&session=${encodeURIComponent(sel.session)}`;
    app.dataset.route = currentRoute;
    app.dataset.selectDir = sel.dir;
    app.dataset.selectSession = sel.session;
    postToParent({ type: "route", route: currentRoute });
  } else if (data && data.type === "vh-host-tail") {
    // Tail/follow command (mock stand-in for the real SPA's tailListener,
    // web/src/tailListener.ts). F1 (inbound source-guard): mirror the real
    // listener EXACTLY — only the actual parent window may drive a tail
    // command; an untrusted sibling pane that grabbed this window's WindowProxy
    // must not hijack the modeled follow state. event.source for the real host
    // tail is window.parent.
    if (ev.source !== window.parent) return;
    // CF1 payload allowlist: following MUST be a boolean (drop everything else
    // — a poison field never reaches the modeled state). Mirrors the real SPA.
    const tail = data as { following?: unknown };
    if (typeof tail.following !== "boolean") return;
    // READ-FIRST VERDICT (mirror the real listener): only following=true is
    // dispatched — force-unfollow is not durably expressible in the real
    // ChatView (its RO/self-heal recoveries re-engage an at-bottom
    // following=false), so a validated false is a deliberate no-op here too.
    if (tail.following) {
      tailFollowing = true;
      app.dataset.tailFollowing = "true";
      // Round-trip: re-report the status so the host's Tail row flips from the
      // REPORTED state (the same status bridge the real SPA's emitter uses).
      postStatus();
    }
  }
});
