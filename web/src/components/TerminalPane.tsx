import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { projectDir } from "../sync";
import { termKeys } from "../ui";

// A real terminal: xterm.js over a WebSocket-backed PTY (/vh/term/ws). Input
// flows through term.onData() so IME/composition resolves to final bytes (the
// thing openchamber gets wrong); the PTY is sized on connect + every resize so
// vim and width-aware tools work. A mobile key bar supplies Esc/Tab/Ctrl/arrows.
const ARROWS: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };

export default function TerminalPane() {
  let host!: HTMLDivElement;
  let term: Xterm | undefined;
  let fit: FitAddon | undefined;
  let ws: WebSocket | null = null;
  const enc = new TextEncoder();
  const [status, setStatus] = createSignal<"connecting" | "open" | "closed">("connecting");
  const [ctrl, setCtrl] = createSignal(false); // sticky Ctrl for the next key

  const send = (s: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(s));
  };
  const sendResize = () => {
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
    }
  };
  // Accessory-bar key → escape/control sequence, then refocus the terminal.
  const key = (seq: string) => { send(seq); term?.focus(); };

  function connect() {
    if (!projectDir() || (ws && ws.readyState <= WebSocket.OPEN)) return; // need a dir; already (re)connecting
    const proto = location.protocol === "https:" ? "wss" : "ws";
    setStatus("connecting");
    // Reset so the server's scrollback replay rebuilds the screen cleanly
    // (avoids doubling content on a reconnect).
    term?.reset();
    ws = new WebSocket(`${proto}://${location.host}/vh/term/ws?dir=${encodeURIComponent(projectDir())}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { setStatus("open"); sendResize(); term?.focus(); };
    ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer && term) term.write(new Uint8Array(e.data)); };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("closed");
  }
  function disconnect() {
    const c = ws;
    ws = null;
    c?.close();
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
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      allowProposedApi: true,
      theme: { background: "#0b0f17" },
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Harden the hidden input for mobile: no autocorrect/capitalize/IME surprises.
    const ta = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (ta) {
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("spellcheck", "false");
    }
    try { fit.fit(); } catch { /* host not laid out yet */ }

    // onData is IME-safe: composition resolves to final bytes here.
    term.onData((d) => {
      let out = d;
      if (ctrl() && d.length === 1) {
        const c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96); // Ctrl+<letter>
        setCtrl(false);
      }
      send(out);
    });

    connect();

    const ro = new ResizeObserver(() => {
      try { fit?.fit(); sendResize(); } catch { /* mid-layout */ }
    });
    ro.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(hideTimer);
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
        <div class="term-host" ref={host}>
          <span class="term-status" classList={{ [status()]: true }} data-tip={status()} />
        </div>
        {/* Toggleable on-screen key bar (esc/tab/ctrl/arrows). */}
        <Show when={termKeys()}>
        <div class="term-keys">
          <button type="button" onClick={() => key("\x1b")}>esc</button>
          <button type="button" onClick={() => key("\t")}>tab</button>
          <button type="button" classList={{ on: ctrl() }} onClick={() => (setCtrl((v) => !v), term?.focus())}>ctrl</button>
          <button type="button" onClick={() => key("\x03")}>^C</button>
          <For each={["left", "up", "down", "right"]}>
            {(d) => <button type="button" onClick={() => key(ARROWS[d])}>{{ up: "↑", down: "↓", left: "←", right: "→" }[d]}</button>}
          </For>
          <button type="button" onClick={() => key("|")}>|</button>
          <button type="button" onClick={() => key("~")}>~</button>
        </div>
        </Show>
      </Show>
    </div>
  );
}
