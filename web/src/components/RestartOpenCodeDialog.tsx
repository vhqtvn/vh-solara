import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";
import RestartOpenCode from "./RestartOpenCode";

// The OpenCode-restart flow framed as a centered, portaled dialog — the same
// interaction model as OpenCodeUpdateDialog: a .dialog-overlay (lifted above
// the admin popup via .rocd-overlay → var(--z-modal)), Esc-to-close, and an
// overlay click to close. It hosts the shared RestartOpenCode component in
// autoConfirm mode so the session-aware confirmation (RestartConfirm) shows
// immediately, with no redundant entry-button click.
//
// RestartOpenCode remains the SOLE caller of /vh/restart-opencode and owns
// RestartConfirm's session-interrupt logic unchanged — this dialog only frames
// it. onRestarted forwards to the host (the admin menu) so a successful restart
// refreshes its version readout.
//
// Focus-lock: while RestartOpenCode is in an interactive/blocking state (confirm
// open OR a restart POST in-flight) the dialog hides its Close button and
// suppresses overlay/Esc close — mirroring OpenCodeUpdateDialog. Because
// autoConfirm makes the component start active, restartActive is initialized to
// true; RestartOpenCode's deferred onActiveChange keeps it in sync on real
// transitions (Cancel → false, re-open → true, POST start/finish).
export default function RestartOpenCodeDialog(props: {
  onClose: () => void;
  onRestarted?: () => void;
}) {
  const [restartActive, setRestartActive] = createSignal(true);

  const onKey = (e: KeyboardEvent) => {
    // Don't let Escape close while the confirm is open or a restart POST is
    // in-flight — the confirm's own Cancel is the exit then.
    if (e.key === "Escape" && !restartActive()) props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    // Portaled to <body> so the overlay escapes the admin popup's stacking
    // context (a z-index:60 positioned ancestor) — otherwise the modal paints
    // behind the menu. .rocd-overlay lifts it above that menu.
    <Portal>
      <div
        class="dialog-overlay rocd-overlay"
        onClick={() => !restartActive() && props.onClose()}
      >
        <div
          class="dialog rocd"
          role="dialog"
          aria-label="Restart OpenCode"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="dialog-head">
            <span class="dialog-title">
              <Icon name="retry" size={15} /> Restart OpenCode
            </span>
            <Show when={!restartActive()}>
              <button
                type="button"
                class="icon-btn"
                aria-label="Close"
                onClick={props.onClose}
              >
                <Icon name="x" size={14} />
              </button>
            </Show>
          </div>

          <div class="dialog-body rocd-body">
            <RestartOpenCode
              autoConfirm
              onRestarted={props.onRestarted}
              onActiveChange={setRestartActive}
            />
          </div>
        </div>
      </div>
    </Portal>
  );
}
