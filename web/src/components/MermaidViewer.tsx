import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { renderMermaid } from "../lib/mermaid";
import Icon from "./Icon";
import styles from "./MermaidViewer.module.css";

// One-at-a-time enforcement: at most one mermaid overlay is open app-wide.
// `activeToken` holds an opaque token for the currently-open overlay (or null).
// The viewer that opened the overlay rendered it gated on its own token; when a
// different viewer opens, it sets a new token, the previous viewer's gate goes
// false, and its overlay unmounts (its onCleanup tears down its listeners).
const [activeToken, setActiveToken] = createSignal<symbol | null>(null);

// Whether the overlay layer currently owns a pushed history entry. There is at
// most one live overlay, so at most one pushed entry for the overlay layer.
let historyPushed = false;

function downloadSvg(svg: string, name: string) {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Inline mermaid diagram with copy/download + an Expand affordance that opens a
 * full-viewport overlay (Solid <Portal> to <body>). The overlay carries its own
 * Close/Escape, focus entry+restore, body scroll-lock, and hardware/browser Back
 * integration (pushState on open, popstate closes, explicit close consumes the
 * entry via history.back).
 *
 * HISTORY COEXISTENCE: the host app pushes {session,dir} entries for session
 * routing and reads the session from location.search on popstate. Our pushed
 * entry is URL-TRANSPARENT (pushState with no url arg -> location.search is
 * unchanged), so the host's popstate handler re-selects the SAME session it was
 * already showing (a no-op). Our marker state {vhMermaid} is ignored by the host
 * (it reads the URL, not state). Net: opening/closing the overlay never changes
 * which session is selected and never strands a session entry.
 *
 * One-at-a-time: opening a second diagram while one is open REPLACES it. The
 * replacer reuses the existing pushed history entry; the replaced viewer tears
 * down without touching history.
 */
export default function MermaidViewer(props: { src: string }) {
  const [svg] = createResource(() => props.src, renderMermaid);
  const [copied, setCopied] = createSignal(false);
  // The token this instance uses when IT owns the overlay (null when not open).
  let myToken: symbol | null = null;
  // Snapshot of the rendered svg captured at expand time, so a later inline
  // re-render cannot mutate the expanded view. For settled segments svg() is
  // already stable; this makes the guarantee explicit.
  const [snapshot, setSnapshot] = createSignal<string>("");
  // Whether THIS instance currently owns the overlay. Read activeToken() FIRST
  // (unconditionally) so the Show that gates the overlay always tracks it — a
  // `myToken !== null && activeToken()===myToken` form would short-circuit while
  // closed and never subscribe, so the overlay would never mount on open.
  const mine = () => {
    const t = activeToken();
    return myToken !== null && t === myToken;
  };

  let prevFocus: HTMLElement | null = null;
  let closeRef: HTMLButtonElement | undefined;
  let overlayRef: HTMLDivElement | undefined;

  const onPopState = () => {
    // Hardware/browser Back, or our own history.back from explicit close. The
    // browser already consumed the entry; just close WITHOUT a further back.
    historyPushed = false;
    teardown(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  // Tear down the overlay: clear state, remove listeners, release scroll lock,
  // restore focus. `consumeHistory` controls whether we pop our pushed entry
  // (explicit close: yes; popstate/replaced: no — the entry is already gone or
  // owned by the replacer).
  const teardown = (consumeHistory: boolean) => {
    if (myToken === null) return; // not open / already torn down
    const wasMine = myToken;
    myToken = null;
    // Only clear the global token if it still points at us (a replacement
    // opener may have already set it to its own token).
    setActiveToken((t) => (t === wasMine ? null : t));
    window.removeEventListener("popstate", onPopState);
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    if (consumeHistory && historyPushed) {
      historyPushed = false;
      try {
        history.back();
      } catch {
        /* history unavailable */
      }
    }
    // Restore focus only if no overlay is active (a replacement opener keeps
    // focus inside the new overlay).
    const f = prevFocus;
    prevFocus = null;
    queueMicrotask(() => {
      if (activeToken() === null && f && document.contains(f)) f.focus();
    });
  };

  const close = () => teardown(true);

  const open = () => {
    if (myToken !== null) return; // already open
    prevFocus = (document.activeElement as HTMLElement) ?? null;
    // Snapshot the CURRENT rendered svg at expand time (download uses current).
    setSnapshot(svg() ?? "");
    myToken = Symbol();
    setActiveToken(myToken);
    document.body.style.overflow = "hidden"; // scroll-lock body + transcript
    window.addEventListener("popstate", onPopState);
    document.addEventListener("keydown", onKey);
    if (!historyPushed) {
      historyPushed = true;
      try {
        history.pushState({ vhMermaid: true }, "");
      } catch {
        historyPushed = false;
      }
    }
    // (replacers reuse the existing pushed entry; they do not push again.)
  };

  const copySource = () => {
    navigator.clipboard.writeText(props.src).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {}
    );
  };

  // If a different viewer took over (opened while ours is open), tear ours down
  // WITHOUT consuming history (the replacer reuses the pushed entry).
  createEffect(() => {
    if (myToken !== null && activeToken() !== myToken) teardown(false);
  });

  // Focus entry when our overlay becomes active.
  createEffect(() => {
    if (mine()) {
      queueMicrotask(() => {
        if (!mine()) return; // closed in the meantime
        (closeRef ?? overlayRef)?.focus();
      });
    }
  });

  onCleanup(() => {
    // Unmount while open (unreachable for settled segments: the overlay is modal
    // and the transcript is scroll-locked). Conservative: tear down listeners +
    // scroll lock but leave history untouched.
    if (myToken !== null) teardown(false);
  });

  return (
    <div class={styles.mermaidBlock} data-mermaid="inline">
      <Show when={svg()} fallback={<pre class="md-raw">{props.src}</pre>}>
        <div class={styles.mermaidSvg} data-mermaid-diagram innerHTML={svg()!} />
      </Show>
      <div class={styles.mermaidActions}>
        <button type="button" onClick={copySource} title="Copy mermaid source">
          <Icon name={copied() ? "check" : "copy"} />
          <span>{copied() ? "copied" : "copy"}</span>
        </button>
        <button
          type="button"
          onClick={() => svg() && downloadSvg(svg()!, "diagram.svg")}
          title="Download rendered SVG"
          disabled={!svg()}
        >
          <span>download</span>
        </button>
        <button type="button" onClick={open} title="Expand diagram">
          <Icon name="maximize" />
          <span>expand</span>
        </button>
      </div>
      <Show when={mine()}>
        <Portal mount={document.body}>
          <div
            ref={overlayRef}
            class={styles.overlay}
            data-mermaid="overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded mermaid diagram"
            tabindex={-1}
            // tap-out is NOT a closer (accidental closure risk during inspection)
          >
            <div class={styles.overlayActions}>
              <button type="button" onClick={copySource} title="Copy mermaid source">
                <Icon name={copied() ? "check" : "copy"} />
                <span>{copied() ? "copied" : "copy"}</span>
              </button>
              <button
                type="button"
                onClick={() => snapshot() && downloadSvg(snapshot(), "diagram.svg")}
                title="Download rendered SVG"
              >
                <span>download</span>
              </button>
              <button
                ref={closeRef}
                type="button"
                class={styles.close}
                onClick={close}
                title="Close (Esc)"
                aria-label="Close"
              >
                <Icon name="x" />
              </button>
            </div>
            <div class={styles.viewport}>
              <div class={styles.viewportSvg} data-mermaid-diagram innerHTML={snapshot()} />
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
