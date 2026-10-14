import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// Plain CSS side-effect import: classes are global (e2e queries them); a
// pure-:global .module.css would be tree-shaken from the production bundle
// (docs/ai/web-css-architecture.md §3 rule 7).
import "./TerminalPane.css";
import { projectDir } from "../sync";
import { termKeys } from "../ui";
import { monoFontStack } from "../font";
import { uiZoom } from "../lib/zoom";
import { pointerToCell, documentRewriteApplies, rewriteMouseEvent, rewriteWheelEvent } from "../lib/termPointer";
import {
  classifyTermInput,
  composeStripVisible,
  disposeTermCompose,
  isStaleInput,
  loadTermCompose,
  saveTermCompose,
  toComposeText,
  toWireText,
} from "../lib/termCompose";
import { einkProfile } from "../prefs";
import { PAGE_OVERLAP_FRACTION } from "../lib/paging";
import { TerminalPanePagingControls } from "./TerminalPanePagingControls";

// A real terminal: xterm.js over a WebSocket-backed PTY (/vh/term/ws). Input
// flows through term.onData() so IME/composition resolves to final bytes (the
// thing openchamber gets wrong); the PTY is sized on connect + every resize so
// vim and width-aware tools work. A mobile key bar supplies Esc/Tab/Ctrl/arrows.
// `termId` selects which server PTY to attach to (tabs); session/title are
// optional labels for the management UI.
//
// Resilience (send-net-resilience slice 4b): while the private ws is down — or
// SUSPECTED half-open (OPEN socket, TERM_STALE_MS of silence) — typed text
// routes into a visible compose buffer shown as NOT SENT and never reaches the
// PTY/ws except through an explicit user send (debate-2 Q4: queue-and-replay
// of raw PTY input is prohibited — later blind execution of stale keystrokes
// is worse than loss). The live path is unchanged: while sendable(), typing
// passes straight through with zero friction.
const ARROW_FINAL: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

// E-ink terminal posture (display profile, default OFF): a light "dark ink
// on light paper" palette + a steady cursor. Every ANSI ink is drawn from
// the e-ink theme's grayscale ramp (#000/#3a3a3a/#555555/#6e6e6e) — all ≥AA
// contrast on #ffffff paper, so nothing is dark-on-dark and no ink is a
// subtle gray a monochrome panel cannot resolve. "White"/"yellow" (light
// inks written against the default dark background) collapse to dark inks
// to stay legible on paper. Surface appearance only — PTY traffic, input,
// and the renderer are untouched.
const TERM_THEME_DARK = { background: "#0b0f17" }; // exact pre-profile palette
const TERM_THEME_EINK = {
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#c8c8c8",
  black: "#000000",
  red: "#3a3a3a",
  green: "#3a3a3a",
  yellow: "#555555",
  blue: "#000000",
  magenta: "#555555",
  cyan: "#555555",
  white: "#555555",
  brightBlack: "#6e6e6e",
  brightRed: "#000000",
  brightGreen: "#3a3a3a",
  brightYellow: "#6e6e6e",
  brightBlue: "#000000",
  brightMagenta: "#555555",
  brightCyan: "#555555",
  brightWhite: "#000000",
};
const termTheme = (eink: boolean) => (eink ? TERM_THEME_EINK : TERM_THEME_DARK);

// Terminal history-paging geometry (eink UX Slice 2) — the LINE-domain
// translation of web/src/lib/paging.ts. The chat helpers are px-based
// (scrollTop/scrollHeight/clientHeight); the xterm normal buffer pages in
// whole LINES (scrollLines/scrollToBottom over viewportY/baseY), so only the
// design constant PAGE_OVERLAP_FRACTION (15% context retained across a page
// boundary) ports over unchanged — the px clamp bands [24,96] and the 24px
// step floor are viewport-pixel choices with no line equivalent (a 1-line
// overlap floor replaces them: at least one context row survives every turn,
// and the step can never degenerate to ≤ 0 lines).
const termPageOverlapLines = (rows: number): number =>
  Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.round(rows * PAGE_OVERLAP_FRACTION)) : 1;
const termPageStepLines = (rows: number): number => Math.max(1, rows - termPageOverlapLines(rows));

export default function TerminalPane(props: { termId?: string; session?: string; title?: string }) {
  let host!: HTMLDivElement;
  let cellCursor!: HTMLDivElement;
  // The .xterm-screen element — the ONE rect every xterm coordinate consumer
  // (selection, mouse reporting, linkifier) subtracts. Queried once after
  // term.open(); xterm never replaces it during the terminal's lifetime.
  let screenEl: HTMLElement | null = null;
  let term: Xterm | undefined;
  let fit: FitAddon | undefined;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let liveTimer: number | undefined;
  let lastRecv = 0; // ms timestamp of the last byte/keepalive from the server
  let backoff = 500; // ms, doubles per failed attempt up to a cap
  let intentional = false; // true when WE closed it (hide/cleanup) — don't auto-reconnect
  // A half-open link (tunnel/proxy silently dropped, no close frame reaches us)
  // leaves the socket "open" while no bytes flow. The server sends a keepalive
  // every ~15s; TERM_STALE_MS of silence (lib/termCompose) first flips the pane
  // to a visible held state so typed input buffers instead of feeding a dead
  // socket; if we then go this long (LIVENESS_MS) with no traffic at all,
  // assume the link is dead and reconnect (replays scrollback).
  const LIVENESS_MS = 45000;
  const enc = new TextEncoder();
  // connecting = first/manual attempt; reconnecting = auto-retrying after a drop;
  // disconnected = stopped (shell exited / gave up) and waiting for the user.
  const [status, setStatus] = createSignal<"connecting" | "open" | "reconnecting" | "disconnected">("connecting");
  const [ctrl, setCtrl] = createSignal(false); // sticky Ctrl for the next key
  // Suspected HALF-OPEN link: the socket still reads OPEN but no byte (PTY
  // output or the server's 15s text keepalive) has arrived for TERM_STALE_MS.
  // Reuses the existing lastRecv watchdog bookkeeping — no parallel health
  // system. While stale (or down), typed TEXT routes into the visible compose
  // buffer below instead of vanishing; see sendable().
  const [stale, setStale] = createSignal(false);
  // Compose buffer (slice 4b): held, visible, explicitly-sent text. Survives
  // pane remounts (tab switches / dock close) via the module-level store; a
  // pane-local signal would silently drop held text on those casual gestures.
  const [compose, setCompose] = createSignal(loadTermCompose(projectDir(), props.termId));
  let composeEl: HTMLTextAreaElement | undefined;
  // E-ink history paging (UX Slice 2): render state for the paging toolbar,
  // mounted ONLY while einkProfile() is ON. parked = the reader is viewing
  // history (normal-buffer viewportY < baseY — xterm's isUserScrolling
  // posture, where new output does NOT drag the viewport to the tail);
  // alt = a full-screen application owns the ALTERNATE buffer, which has no
  // scrollback (BufferSet builds it with maxLength = rows), so history
  // paging is unavailable there. Both derive from the documented xterm
  // buffer/scroll surfaces only — no escape-sequence interception.
  const [histParked, setHistParked] = createSignal(false);
  const [histAlt, setHistAlt] = createSignal(false);
  const syncHist = () => {
    if (!term) return;
    setHistAlt(term.buffer.active.type === "alternate");
    const n = term.buffer.normal;
    setHistParked(n.viewportY < n.baseY);
  };
  // Paging actions: viewport-only xterm APIs — ZERO PTY/ws bytes (no
  // term.write, no ws.send), no reconnect, no remount. scrollLines(-step)
  // parks the reader (isUserScrolling=true in BufferService); scrollToBottom
  // (and any downward page that reaches the tail) resumes following. In the
  // alternate buffer the buttons are disabled with a visible explanation;
  // the guards here are defense-in-depth (the alt screen has no scrollback,
  // so scrollLines there is a no-op anyway). The actions NEVER touch focus:
  // the toolbar buttons preventDefault pointerdown (no focus transfer out of
  // the xterm textarea), so the terminal keeps focus across paging clicks —
  // deliberate, because refocusing would emit ESC[O/ESC[I PTY bytes under
  // an app's DECSET 1004 focus reporting (see TerminalPanePagingControls).
  const histPrev = () => {
    if (!term || term.buffer.active.type === "alternate") return;
    term.scrollLines(-termPageStepLines(term.rows));
  };
  const histNext = () => {
    if (!term || term.buffer.active.type === "alternate") return;
    term.scrollLines(termPageStepLines(term.rows));
  };
  const histLatest = () => {
    if (!term || term.buffer.active.type === "alternate") return;
    term.scrollToBottom();
  };

  const send = (s: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(s));
  };
  // Input can safely take the live path only while the link is OPEN and not
  // suspected dead. Everything else buffers — never silently discarded.
  const sendable = () => status() === "open" && !stale();
  const updateCompose = (v: string) => {
    setCompose(v);
    saveTermCompose(projectDir(), props.termId, v);
  };
  const bufferInput = (d: string) => {
    // Gestures (ESC/TAB/arrows/^C/… control bytes) are NEVER buffered: they
    // are not reviewable text, and deferring them for later execution is the
    // prohibited queue-and-replay hazard (debate-2 Q4). The visibly-held pane
    // state is the honest surface for them; text continues to accumulate.
    if (classifyTermInput(d) !== "text") return;
    updateCompose(compose() + toComposeText(d));
    if (composeEl) composeEl.scrollTop = composeEl.scrollHeight;
  };
  // Explicit send — the ONLY path buffered text ever reaches the PTY. One
  // ws write of exactly what the user reviewed; never automatic.
  const sendComposed = () => {
    const t = compose();
    if (!t || !sendable()) return;
    send(toWireText(t));
    updateCompose("");
    term?.focus();
  };
  const clearComposed = () => updateCompose("");
  const sendResize = () => {
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
    }
  };
  // Accessory-bar key → escape/control sequence, then refocus the terminal.
  // While buffering: textual bar keys ("|", "~") append to the compose buffer;
  // gesture keys are visibly disabled in the bar (nothing silently drops).
  const key = (seq: string) => {
    if (sendable()) {
      send(seq);
      term?.focus();
    } else if (classifyTermInput(seq) === "text") {
      bufferInput(seq);
      composeEl?.focus();
    }
  };
  // Arrow key sequence honoring the app's cursor-key mode: full-screen apps
  // (vim/less/htop) enable DECCKM and then expect ESC O A, not ESC [ A. Physical
  // arrows handle this in xterm automatically; the on-screen bar must mirror it
  // or arrows misbehave inside vim (the common mobile case).
  const arrowSeq = (d: string) => {
    const app = !!(term as unknown as { modes?: { applicationCursorKeysMode?: boolean } })?.modes?.applicationCursorKeysMode;
    return (app ? "\x1bO" : "\x1b[") + ARROW_FINAL[d];
  };

  // Reconnect after an *unexpected* drop (proxy/idle timeout, network blip,
  // laptop sleep) so the terminal doesn't silently go dead. The PTY lives
  // server-side across disconnects and replays its scrollback on attach, so
  // reconnecting restores the same shell. While the socket is down, typed
  // input is NOT discarded — it routes into the visible compose buffer (see
  // sendable/bufferInput) and only reaches the PTY through an explicit send.
  function scheduleReconnect() {
    if (intentional || !projectDir()) return;
    if (document.visibilityState === "hidden") return; // the visibility handler reconnects on return
    setStatus("reconnecting");
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      backoff = Math.min(backoff * 2, 8000);
      connect();
    }, backoff);
  }

  function connect() {
    if (!projectDir() || (ws && ws.readyState <= WebSocket.OPEN)) return; // need a dir; already (re)connecting
    clearTimeout(reconnectTimer);
    intentional = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    if (status() !== "reconnecting") setStatus("connecting"); // keep the "Reconnecting…" label across retries
    // Reset so the server's scrollback replay rebuilds the screen cleanly
    // (avoids doubling content on a reconnect).
    term?.reset();
    const q = new URLSearchParams({ dir: projectDir(), id: props.termId || "shared" });
    if (props.session) q.set("session", props.session);
    if (props.title) q.set("title", props.title);
    ws = new WebSocket(`${proto}://${location.host}/vh/term/ws?${q.toString()}`);
    ws.binaryType = "arraybuffer";
    lastRecv = Date.now();
    ws.onopen = () => { backoff = 500; lastRecv = Date.now(); setStale(false); setStatus("open"); sendResize(); term?.focus(); };
    // Any frame — PTY output OR the server's text keepalive — proves the link is
    // live; text keepalives are ignored for rendering but refresh the watchdog.
    ws.onmessage = (e) => { lastRecv = Date.now(); setStale(false); if (e.data instanceof ArrayBuffer && term) term.write(new Uint8Array(e.data)); };
    ws.onclose = (e) => {
      ws = null;
      // 1000 = clean server close (shell exited / session ended) — stay down
      // and surface it; anything else is an abnormal drop, so auto-retry.
      if (e.code === 1000) {
        // The shell is GONE forever (D-4b-3): dispose the compose-store
        // entry — held text can never reach a dead shell, and a same-id
        // shell spawned later is a NEW shell that must not inherit stale
        // holds. This pane's signal keeps the text VISIBLE for copy; only
        // the cross-remount store entry dies. (Shells killed with no pane
        // attached — another browser's kill, the idle reaper — are never
        // observed here; that residual is documented in lib/termCompose.)
        disposeTermCompose(projectDir(), props.termId);
        setStatus("disconnected");
        return;
      }
      if (intentional) setStatus("disconnected");
      else scheduleReconnect();
    };
    ws.onerror = () => {}; // a close event always follows; reconnect is handled there
  }
  function disconnect() {
    intentional = true;
    clearTimeout(reconnectTimer);
    const c = ws;
    ws = null;
    // tier1_c/F1: OUR close() — no code — ends the handshake with close code
    // 1000 (platform contract) and the server echoes it, so onclose would
    // observe the SAME shape as shell death and dispose held text on every
    // pane remount — though the PTY never died. Detach the handler FIRST so
    // a deliberate teardown is a no-op in onclose terms: the compose-store
    // entry survives pane-controlled closes (buffer-survives-remounts
    // contract); only SERVER-initiated 1000 closes dispose (D-4b-3).
    if (c) {
      c.onclose = null;
      c.close();
    }
  }
  // User-initiated reconnect from the overlay (resets backoff, retries now).
  const reconnectNow = () => { backoff = 500; intentional = false; connect(); };

  // Watchdog-initiated reconnect for a half-open link: the socket still reads
  // "open" but nothing arrives. Tear it down and reattach (server replays the
  // scrollback, so the screen — and vim — come back).
  function forceReconnect() {
    clearTimeout(reconnectTimer);
    const c = ws;
    ws = null;
    // Same self-close guard as disconnect() (tier1_c/F1): the watchdog's own
    // close() is echoed back as a 1000 close event — the PTY is alive, we are
    // only rotating the socket, so held text must survive. Detaching the
    // handler also keeps the old socket's late close event from clobbering
    // the fresh ws reference connect() assigns below.
    if (c) {
      c.onclose = null;
      try { c.close(); } catch { /* already gone */ }
    }
    backoff = 500;
    intentional = false;
    // Clear the half-open suspicion AT the transition (a-F1): stale must not
    // survive into the reconnecting window on the pane's own state — the
    // invariant is enforced here, not left to the next ws.onopen to repair.
    setStale(false);
    setStatus("reconnecting");
    connect();
  }
  function checkLiveness() {
    if (intentional || document.visibilityState === "hidden") return;
    if (ws && ws.readyState === WebSocket.OPEN && lastRecv && Date.now() - lastRecv > LIVENESS_MS) {
      forceReconnect();
      return;
    }
    // Same watchdog signal, earlier threshold: while the socket still claims
    // OPEN, TERM_STALE_MS of total silence marks a suspected half-open link.
    // Input starts buffering (visible) BEFORE the 45s teardown below.
    const nowStale = isStaleInput(
      !!(ws && ws.readyState === WebSocket.OPEN),
      lastRecv,
      Date.now(),
    );
    if (nowStale !== stale()) setStale(nowStale);
  }

  // "Size only counts while visible": when the tab is hidden, detach so this
  // client stops constraining the shared PTY size; reattach (replay) on return.
  let hideTimer: number | undefined;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hideTimer = window.setTimeout(disconnect, 1500); // grace, so a quick switch doesn't thrash
    } else {
      clearTimeout(hideTimer);
      if (!ws) connect();
    }
  };

  onMount(() => {
    term = new Xterm({
      // E-ink profile: steady cursor (no blink repaints) + the light ink
      // palette while ON; OFF is today's exact posture. Live profile
      // transitions are handled by the option-update effect below.
      cursorBlink: !einkProfile(),
      fontSize: 13,
      // Drive the terminal from the same mono font the user picks in Settings
      // → Code font, for consistency. xterm takes a literal fontFamily at
      // creation (not a CSS var), so we resolve the active stack here. A change
      // applies on the next terminal creation (tab switch/reconnect), not live.
      fontFamily: monoFontStack(),
      allowProposedApi: true,
      theme: termTheme(einkProfile()),
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    screenEl = host.querySelector(".xterm-screen");
    // Copy/paste via Ctrl+Shift+C/V. The listener rides `host` in the capture
    // phase so it beats xterm's own keydown handler (on .xterm-helper-textarea);
    // preventDefault + stopImmediatePropagation suppress both the browser
    // dev-tools shortcut AND xterm's handling (no stray ETX / double-paste).
    const onTermKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const sel = term?.getSelection() ?? "";
        if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {});
        // Empty selection is a no-op, but we still ate the event so dev tools
        // doesn't pop open — matches gnome-terminal behavior.
      } else if (k === "v") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (navigator.clipboard) navigator.clipboard.readText().then((t) => { if (t) term?.paste(t); }).catch(() => {});
      }
    };
    host.addEventListener("keydown", onTermKey, true);

    // UI-zoom pointer seam (terminal cousin of fc2ef59d): xterm.js v6 mixes px
    // spaces in its own coordinate math — the offset numerator
    // `clientX - screenRect.left` is visual px (both viewport-space under CSS
    // zoom), while the cell-size divisor from CharSizeService (OffscreenCanvas
    // measureText / offsetWidth) is layout px. At zoom ≠ 1 every cell
    // computation lands off by exactly the zoom factor. Every consumer
    // subtracts the SAME .xterm-screen rect, so one capture-phase rewrite of
    // the legacy mouse types xterm registers (mousedown/mousemove/mouseup;
    // word-select rides event.detail on mousedown) fixes selection anchors,
    // mouse reporting to apps, and link hits at once: the pointer's offset
    // within the screen element shrinks by zoom, making xterm's
    // visual-offset ÷ layout-cell division unit-consistent. Identity at
    // zoom = 1 (no rewrite). PointerEvents are untouched — hostGesture and
    // the cell indicator below expect visual px and convert via
    // lib/termPointer themselves. Events whose target leaves the host
    // mid-drag (xterm listens for those on the document) are covered by the
    // drag-escape seam below, using the same rewrite.
    const normalizeForXterm = (e: MouseEvent) => {
      if (!screenEl) return;
      rewriteMouseEvent(e, screenEl.getBoundingClientRect(), uiZoom());
    };
    for (const t of ["mousedown", "mousemove", "mouseup"] as const) {
      host.addEventListener(t, normalizeForXterm, true);
    }

    // Drag-escape coverage (76dfaeb2 review B-F2): xterm.js v6 installs its
    // selection / mouse-reporting move+up listeners on the DOCUMENT after a
    // mousedown (SelectionService._addMouseDownListeners — "so that dragging
    // outside of viewport works"), so when a drag's pointer leaves .term-host
    // those events reach xterm with RAW visual coords and the selection end
    // lands ~×z off (stops short of the grid edge at zoom < 1; row drifts at
    // any zoom ≠ 1). While a drag that started inside this host is active,
    // mirror xterm's own lifecycle: document-level CAPTURE move/up listeners
    // normalizing by the SAME screen-rect seam. documentRewriteApplies skips
    // in-host events (the host capture listener above already rewrote them —
    // document capture fires first, so rewriting there too would divide by
    // zoom twice), and the listeners exist only while the drag is active, so
    // unrelated document events are never touched. Any button press inside
    // the host activates the pair — xterm's mouse-reporting path tracks
    // non-primary buttons too; the rewrite itself is identity at zoom = 1.
    let dragRewriteActive = false;
    const rewriteEscapedForXterm = (e: MouseEvent) => {
      if (!screenEl || !documentRewriteApplies(e.target, host)) return;
      rewriteMouseEvent(e, screenEl.getBoundingClientRect(), uiZoom());
    };
    const onDocDragMove = (e: MouseEvent) => rewriteEscapedForXterm(e);
    const onDocDragUp = (e: MouseEvent) => {
      rewriteEscapedForXterm(e); // mouseup outside the host ends the drag — normalize it too
      endDragRewrite();
    };
    function endDragRewrite() {
      if (!dragRewriteActive) return;
      dragRewriteActive = false;
      document.removeEventListener("mousemove", onDocDragMove, true);
      document.removeEventListener("mouseup", onDocDragUp, true);
    }
    const onDragStart = () => {
      if (dragRewriteActive) return;
      dragRewriteActive = true;
      document.addEventListener("mousemove", onDocDragMove, true);
      document.addEventListener("mouseup", onDocDragUp, true);
    };
    host.addEventListener("mousedown", onDragStart, true);

    // Wheel rides the same seam (terminal cousin of the 76dfaeb2 follow-up):
    // xterm.js v6's wheel consumers mix a VISUAL-px pixel-mode delta into
    // LAYOUT-px math — the SmoothScrollableElement adds SCROLL_WHEEL_SENSITIVITY
    // × (wheelDeltaY/120 on Chromium) to a layout-px scrollTop, and
    // CoreMouseService.consumeWheelEvent divides deltaY by the layout-px cell
    // height — so at zoom ≠ 1 every wheel scroll lands ~×z (too fast at 125%,
    // too slow at 80%). One capture-phase rewrite of the wheel event covers
    // all consumers (scrollback scroll, mouse-protocol wheel reports, and
    // alternate-buffer arrow-key synthesis) because they read the same live
    // event object from listeners on descendants of this host. LINE/PAGE-mode
    // deltas are counts, not px, and pass through untouched; getters only —
    // nothing is preventDefault()ed, so xterm's own listeners behave
    // identically. Identity at zoom = 1. See lib/termPointer.rewriteWheelEvent.
    const normalizeWheelForXterm = (e: WheelEvent) => {
      rewriteWheelEvent(e, uiZoom());
    };
    host.addEventListener("wheel", normalizeWheelForXterm, true);

    // Native long-press selection on coarse pointers (mobile): xterm.js v6's
    // NON-macOS contextmenu listener (CoreBrowserTerminal) is NOT
    // button-guarded, and mobile browsers fire contextmenu for a touch
    // long-press. Its rightClickHandler → moveTextAreaUnderMouseCursor
    // teleports a 20×20 z-index:1000 helper textarea centered under the press
    // and focuses it, so the long-press resolves to a focused editable → the
    // OS "Paste" bubble instead of text selection. While the pointer is
    // coarse, stop the event's propagation here — CAPTURE on the host runs
    // before xterm's bubble listener on the .xterm root — so the textarea
    // stays parked and the OS long-press machinery sees the selectable DOM
    // rows (they're opted back into native selection by the coarse-pointer
    // rule in TerminalDock.css; stock xterm.css parks user-select:none on
    // .xterm, which an ancestor's carve-out cannot beat). NEVER
    // preventDefault: the browser's default long-press behavior IS the
    // selection UI we're restoring. Fine pointers are untouched — desktop
    // right-click keeps xterm's behavior (pinned by the e2e control test).
    const onContextMenu = (e: MouseEvent) => {
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      e.stopPropagation();
    };
    host.addEventListener("contextmenu", onContextMenu, true);

    // Cell indicator: the OS cursor is much taller than a terminal line, so
    // which cell a click/touch will hit is ambiguous. One tiny overlay
    // snapped to the cell grid under the pointer, positioned by the SAME
    // zoom-corrected mapping the seam above feeds xterm (dogfoods the fix).
    // Hover-follow for mouse/pen (rAF-coalesced), a 600ms flash for touch.
    // transform-only moves, pointer-events:none, no backdrop-filter/mask —
    // cheap for the Firefox/WebRender GPU budget (AGENTS.md).
    let rafId = 0;
    let flashTimer: number | undefined;
    let hoverEvt: PointerEvent | null = null;
    let lastW = 0;
    let lastH = 0;
    const hideCursor = () => {
      hoverEvt = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // A touch flash owns the indicator until its timer fires — pointerleave
      // is dispatched on touch LIFT and must not kill the flash the tap just
      // started.
      if (flashTimer !== undefined) return;
      cellCursor?.classList.remove("on");
    };
    const placeCursor = (clientX: number, clientY: number) => {
      if (!cellCursor || !term || !screenEl || term.cols < 1 || term.rows < 1) return;
      const hit = pointerToCell(
        clientX,
        clientY,
        screenEl.getBoundingClientRect(),
        host.getBoundingClientRect(),
        uiZoom(),
        term.cols,
        term.rows,
      );
      if (!hit.inside || !(hit.cellW > 0) || !(hit.cellH > 0)) {
        cellCursor.classList.remove("on");
        return;
      }
      // Cell size changes only on fit/font changes — write width/height just
      // when they move; the per-event hot path is transform + class only.
      if (hit.cellW !== lastW || hit.cellH !== lastH) {
        lastW = hit.cellW;
        lastH = hit.cellH;
        cellCursor.style.width = `${hit.cellW}px`;
        cellCursor.style.height = `${hit.cellH}px`;
      }
      cellCursor.style.transform = `translate(${hit.left}px, ${hit.top}px)`;
      cellCursor.classList.add("on");
    };
    const flushHover = () => {
      rafId = 0;
      if (hoverEvt) placeCursor(hoverEvt.clientX, hoverEvt.clientY);
      hoverEvt = null;
    };
    const onHoverMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      hoverEvt = e;
      if (!rafId) rafId = requestAnimationFrame(flushHover);
    };
    const onTouchDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return; // hover already tracks the mouse
      placeCursor(e.clientX, e.clientY);
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        flashTimer = undefined;
        cellCursor?.classList.remove("on");
      }, 600);
    };
    host.addEventListener("pointermove", onHoverMove);
    host.addEventListener("pointerdown", onTouchDown);
    host.addEventListener("pointerleave", hideCursor);
    // Harden the hidden input for mobile: no autocorrect/capitalize/IME surprises.
    const ta = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (ta) {
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("spellcheck", "false");
    }
    try { fit.fit(); } catch { /* host not laid out yet */ }

    // Work around an xterm.js v6 parser stall: its built-in DECRQM handler
    // (CSI [?] Ps $ p — "report mode", which full-screen TUIs like vim emit
    // during startup to probe cursor-key/alt-screen/etc. state) deadlocks the
    // async write processor. Once vim sends it, every later term.write() queues
    // but never renders — the screen freezes on vim's first frame while input
    // still flows, so the user types blind with no feedback and can't even see
    // :q work. Register a no-op handler that swallows DECRQM (both the private
    // `?` and non-private forms) before the broken built-in runs. Programs fall
    // back to defaults without the reply, so this is safe; revisit on a xterm
    // upgrade that fixes the stall.
    term.parser.registerCsiHandler({ intermediates: "$", final: "p" }, () => true);
    term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => true);

    // onData is IME-safe: composition resolves to final bytes here. While the
    // link is live this is the unchanged direct passthrough (zero friction);
    // while down/suspected-dead, typed TEXT routes into the visible compose
    // buffer instead of being silently discarded (slice 4b). Ctrl+letter is a
    // gesture: it is transformed only on the live path — while buffering the
    // sticky ctrl stays armed and the letter buffers as plain text.
    term.onData((d) => {
      if (sendable()) {
        let out = d;
        if (ctrl() && d.length === 1) {
          const c = d.toLowerCase().charCodeAt(0);
          if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96); // Ctrl+<letter>
          setCtrl(false);
        }
        send(out);
      } else {
        bufferInput(d);
      }
    });

    connect();

    // When the pane LEAVES the sendable state (drop / half-open suspicion),
    // keystrokes must land somewhere the user can SEE them: if focus was in
    // the terminal surface, move it to the compose input so typed text shows
    // up where the user is looking instead of feeding a dead socket. Never
    // steals focus from other panes/chat — only from this pane's xterm.
    createEffect(
      on(sendable, (now, prev) => {
        if (prev && !now && host.contains(document.activeElement)) {
          queueMicrotask(() => composeEl?.focus());
        }
      }),
    );

    // E-ink profile transitions apply to an ALREADY-OPEN terminal through
    // xterm's option-update path (term.options.*): palette + cursorBlink
    // flip in place — no remount, no reconnect, no renderer change — and
    // the OFF direction restores today's exact dark palette + blink the
    // same live way. defer: the constructor above already applied the
    // current profile state at creation. Honest limit: an app inside the
    // terminal can re-enable blinking via ANSI cursor modes (DECSCUSR /
    // DECSET 12), which xterm resolves AHEAD of this option — sequences
    // are deliberately not intercepted.
    createEffect(
      on(
        einkProfile,
        (eink) => {
          if (!term) return;
          term.options.cursorBlink = !eink;
          term.options.theme = termTheme(eink);
        },
        { defer: true },
      ),
    );

    // History-paging state feed (UX Slice 2): track the normal-buffer
    // viewport and buffer switches through the DOCUMENTED xterm events —
    // onScroll (viewport moved: button page, wheel, or new output —
    // BufferService.scroll fires it on every scrolled output line, whether
    // or not the parked reader moved), onResize (reflow can re-shape
    // baseY/ydisp), and buffer.onBufferChange (app enters/leaves the
    // alternate screen). Subscribed unconditionally so a mid-session profile
    // toggle finds correct state immediately; under OFF the handlers are
    // inert bookkeeping (two signal writes, no DOM — the toolbar that reads
    // them is not mounted), so the OFF path stays behaviorally identical.
    // No explicit disposal: the subscriptions die with term.dispose() in
    // this mount's cleanup.
    term.onScroll(() => syncHist());
    term.onResize(() => syncHist());
    term.buffer.onBufferChange(() => syncHist());
    syncHist();

    const ro = new ResizeObserver(() => {
      try { fit?.fit(); sendResize(); } catch { /* mid-layout */ }
    });
    ro.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    liveTimer = window.setInterval(checkLiveness, 5000);
    onCleanup(() => {
      ro.disconnect();
      host.removeEventListener("keydown", onTermKey, true);
      for (const t of ["mousedown", "mousemove", "mouseup"] as const) {
        host.removeEventListener(t, normalizeForXterm, true);
      }
      host.removeEventListener("mousedown", onDragStart, true);
      endDragRewrite(); // a drag still active at unmount must not leak its document listeners
      host.removeEventListener("wheel", normalizeWheelForXterm, true);
      host.removeEventListener("contextmenu", onContextMenu, true);
      host.removeEventListener("pointermove", onHoverMove);
      host.removeEventListener("pointerdown", onTouchDown);
      host.removeEventListener("pointerleave", hideCursor);
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(flashTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(hideTimer);
      clearInterval(liveTimer);
      disconnect();
      term?.dispose();
    });
  });

  return (
    <div class="term">
      <Show
        when={projectDir()}
        fallback={<div class="term-empty">Open a project (not the default) to use the terminal.</div>}
      >
        {/* E-ink history paging (UX Slice 2): reserved in-flow toolbar row,
            mounted ONLY while the profile is ON — OFF renders no node, and
            the buffer subscriptions at the mount site are inert signal
            bookkeeping (documented there), so the OFF observable path is
            untouched. */}
        <Show when={einkProfile()}>
          <TerminalPanePagingControls
            onPrev={histPrev}
            onNext={histNext}
            onLatest={histLatest}
            parked={histParked}
            alt={histAlt}
          />
        </Show>
        <div class="term-host" ref={host}>
          {/* data-stale reflects the RAW half-open suspicion signal for
              diagnostics and tests regardless of status; the CSS-visible
              .stale class renders only while OPEN — the a-F1 invariant that
              forceReconnect clears stale at the reconnecting transition
              needs an observable surface. */}
          <span class="term-status" classList={{ [status()]: true, stale: status() === "open" && stale() }} data-stale={stale() ? "true" : "false"} data-tip={stale() && status() === "open" ? "connection may be down — input held" : status()} />
          {/* Cell-snapped pointer indicator — sized/positioned from JS in
              onMount (termPointer mapping). aria-hidden: purely visual. */}
          <div class="term-cell-cursor" ref={cellCursor} aria-hidden="true" />
          {/* Make a dead/dropped connection obvious — the cursor still blinks
              locally, so without this the terminal just looks alive but eats
              keystrokes. */}
          <Show when={status() !== "open"}>
            <div class="term-overlay" classList={{ err: status() === "disconnected" }}>
              <span class="term-overlay-msg">
                {status() === "disconnected"
                  ? "Terminal disconnected"
                  : status() === "reconnecting"
                    ? "Connection lost — reconnecting…"
                    : "Connecting…"}
              </span>
              <Show when={status() !== "connecting"}>
                <button type="button" class="term-reconnect" onClick={reconnectNow}>Reconnect</button>
              </Show>
            </div>
          </Show>
        </div>
        {/* Compose buffer (slice 4b): held input that has NOT been sent.
            Visible whenever text is held or input would buffer; hidden on the
            untouched live path. Send writes to the PTY ONLY on this explicit
            action — never automatically (debate-2 Q4 binding). */}
        <Show when={composeStripVisible(compose().length > 0, status(), stale())}>
          <div
            class="term-compose"
            classList={{ held: !sendable(), restored: sendable() && !!compose() }}
            role="region"
            aria-label="Unsent terminal input"
          >
            <textarea
              ref={composeEl}
              class="term-compose-input"
              aria-label="Held terminal input"
              value={compose()}
              rows={Math.max(2, Math.min(6, compose().split("\n").length + (compose().endsWith("\n") ? 1 : 0)))}
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => updateCompose(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter = the explicit send (Shift+Enter = newline). While
                // still buffering, Enter just adds a newline — the buffer can
                // only leave through Send or Discard.
                if (e.key === "Enter" && !e.shiftKey && sendable()) {
                  e.preventDefault();
                  sendComposed();
                }
              }}
            />
            <div class="term-compose-row">
              <span class="term-compose-badge">
                {sendable()
                  ? "Connection restored — input above is still NOT SENT. Review, then send."
                  : stale() && status() === "open"
                    ? "Connection may be down — input above is held, not sent."
                    : "Terminal offline — input above is held, not sent."}
              </span>
              <button
                type="button"
                class="term-compose-send"
                disabled={!sendable() || !compose()}
                onClick={sendComposed}
                title={sendable() ? "Send to the terminal" : "Waiting for a live connection"}
              >
                Send
              </button>
              <button type="button" class="term-compose-clear" disabled={!compose()} onClick={clearComposed}>
                Discard
              </button>
            </div>
          </div>
        </Show>
        {/* Toggleable on-screen key bar (esc/tab/ctrl/arrows). Gesture keys are
            disabled while buffering: they cannot be deferred as text and would
            otherwise vanish silently. Textual keys ("|", "~") keep working —
            they append to the compose buffer. The ctrl TOGGLE stays active so
            an armed sticky Ctrl can still be released. */}
        <Show when={termKeys()}>
        <div class="term-keys">
          <button type="button" disabled={!sendable()} onClick={() => key("\x1b")}>esc</button>
          <button type="button" disabled={!sendable()} onClick={() => key("\t")}>tab</button>
          <button type="button" classList={{ on: ctrl() }} onClick={() => (setCtrl((v) => !v), term?.focus())}>ctrl</button>
          <button type="button" disabled={!sendable()} onClick={() => key("\x03")}>^C</button>
          <For each={["left", "up", "down", "right"]}>
            {(d) => <button type="button" disabled={!sendable()} onClick={() => key(arrowSeq(d))}>{ { up: "↑", down: "↓", left: "←", right: "→" }[d]}</button>}
          </For>
          <button type="button" onClick={() => key("|")}>|</button>
          <button type="button" onClick={() => key("~")}>~</button>
        </div>
        </Show>
      </Show>
    </div>
  );
}
