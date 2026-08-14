import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { renderMermaid } from "../lib/mermaid";
import { trapTab } from "../lib/a11y";
import { pushBackSurface, releaseBackSurface, type BackSurface } from "../lib/backStack";
import Icon from "./Icon";
import styles from "./MermaidViewer.module.css";

// One-at-a-time enforcement: at most one mermaid overlay is open app-wide.
// `activeToken` holds an opaque token for the currently-open overlay (or null).
// The viewer that opened the overlay rendered it gated on its own token; when a
// different viewer opens, it sets a new token, the previous viewer's gate goes
// false, and its overlay unmounts (its onCleanup tears down its listeners).
const [activeToken, setActiveToken] = createSignal<symbol | null>(null);

// The overlay LAYER's entry in the central back-stack manager (one entry for
// the whole layer — at most one overlay is live at a time, and replacements
// REUSE the entry instead of pushing again). `layerClose` is the teardown of
// whichever viewer currently owns the overlay; the manager invokes it when
// Back dismisses the mermaid layer.
let layerEntry: BackSurface | null = null;
let layerClose: (() => void) | null = null;

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
 * integration via the central back-stack manager (lib/backStack.ts): one
 * URL-transparent token entry for the whole overlay layer — Back dismisses it,
 * explicit close consumes it, forward never reopens it.
 *
 * HISTORY COEXISTENCE: token entries are URL-TRANSPARENT (pushState with no url
 * arg → location.search unchanged), so the host's session-routing popstate
 * handler ignores them (the manager also marks the events it owns; sync.ts
 * skips those). Net: opening/closing the overlay never changes which session
 * is selected and never strands a session entry.
 *
 * One-at-a-time: opening a second diagram while one is open REPLACES it. The
 * replacer reuses the layer's existing token entry; the replaced viewer tears
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  // Tear down the overlay: clear state, remove listeners, release scroll lock,
  // restore focus. Three modes:
  //   "explicit" — ✕/Escape/unmount-while-open: release the layer's token entry
  //                (the manager consumes it via history.back, orphans it if
  //                buried) so no ghost entry is stranded.
  //   "back"     — the manager dismissed the layer via Back: the browser
  //                already consumed the entry; just drop our reference.
  //   "replace"  — another viewer took over: it reuses the entry; touch nothing.
  const teardown = (mode: "explicit" | "back" | "replace") => {
    if (myToken === null) return; // not open / already torn down
    const wasMine = myToken;
    myToken = null;
    // Only clear the global token if it still points at us (a replacement
    // opener may have already set it to its own token).
    setActiveToken((t) => (t === wasMine ? null : t));
    document.removeEventListener("keydown", onKey);
    // Only release the scroll lock if no overlay is still active. A replacement
    // opener (B) already set overflow="hidden" for ITS overlay before our (A's)
    // teardown fires; clearing unconditionally would unlock the page behind B.
    if (activeToken() === null) {
      document.body.style.overflow = "";
      layerClose = null;
    }
    if (mode === "explicit") {
      const entry = layerEntry;
      layerEntry = null;
      releaseBackSurface(entry);
    } else if (mode === "back") {
      // Manager-driven close already retired the surface from its stack; the
      // browser consumed the entry. Drop our reference only.
      layerEntry = null;
    }
    // "replace": the replacer owns the entry now — leave layerEntry intact.
    // Restore focus only if no overlay is active (a replacement opener keeps
    // focus inside the new overlay).
    const f = prevFocus;
    prevFocus = null;
    queueMicrotask(() => {
      if (activeToken() === null && f && document.contains(f)) f.focus();
    });
  };

  const close = () => teardown("explicit");

  const open = () => {
    if (myToken !== null) return; // already open
    prevFocus = (document.activeElement as HTMLElement) ?? null;
    // Snapshot the CURRENT rendered svg at expand time (download uses current).
    setSnapshot(svg() ?? "");
    myToken = Symbol();
    setActiveToken(myToken);
    document.body.style.overflow = "hidden"; // scroll-lock body + transcript
    document.addEventListener("keydown", onKey);
    // Register with the back-stack manager. One LAYER entry for the whole
    // mermaid overlay: Back invokes layerClose (the ACTIVE viewer's no-consume
    // teardown — the browser already traversed). Replacements overwrite
    // layerClose and reuse the existing entry (no second push).
    layerClose = () => teardown("back");
    if (!layerEntry) {
      layerEntry = pushBackSurface(() => {
        if (activeToken() === null) return; // stale ghost — nothing to close
        layerClose?.();
      }, "mermaid");
    }
  };

  const copySource = () => {
    navigator.clipboard?.writeText(props.src).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {}
    );
  };

  // If a different viewer took over (opened while ours is open), tear ours down
  // WITHOUT consuming history (the replacer reuses the layer's token entry).
  createEffect(() => {
    if (myToken !== null && activeToken() !== myToken) teardown("replace");
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
    // and the transcript is scroll-locked). Release the layer entry through the
    // manager so it is consumed/orphaned — no ghost history entry is left.
    if (myToken !== null) teardown("explicit");
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
        <button
          type="button"
          onClick={open}
          title="Expand diagram"
          disabled={!svg()}
        >
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
            use:trapTab
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
