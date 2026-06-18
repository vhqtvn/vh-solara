import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { state } from "../sync";
import Icon from "./Icon";

// A transient toast for sync health: warns when the live stream drops (the
// store auto-reconnects in the background), and briefly confirms when it
// recovers — so you never need to reload. Debounced so a momentary blip during
// normal reconnects doesn't flash.
export default function ConnectionToast() {
  const [toast, setToast] = createSignal<{ kind: "warn" | "ok"; text: string } | null>(null);
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let warned = false;

  createEffect(() => {
    const st = state.status;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (st === "reconnecting") {
      // Only surface if it persists — avoids flashing on a quick recovery.
      showTimer = window.setTimeout(() => {
        warned = true;
        setToast({ kind: "warn", text: "Connection lost — reconnecting…" });
      }, 1200);
    } else if (st === "live") {
      if (warned) {
        warned = false;
        setToast({ kind: "ok", text: "Reconnected" });
        hideTimer = window.setTimeout(() => setToast(null), 2500);
      } else {
        setToast(null);
      }
    }
  });

  onCleanup(() => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
  });

  return (
    <Show when={toast()}>
      <div class="conn-toast" classList={{ [toast()!.kind]: true }} role="status">
        <Icon name={toast()!.kind === "warn" ? "help" : "check"} size={15} />
        <span>{toast()!.text}</span>
      </div>
    </Show>
  );
}
