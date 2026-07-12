import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { state, consumeEpochChanged } from "../sync";
import Icon from "./Icon";
import styles from "./ConnectionToast.module.css";

// A transient toast for sync health: warns when the live stream drops (the
// store auto-reconnects in the background), and briefly confirms when it
// recovers — so you never need to reload. Debounced so a momentary blip during
// normal reconnects doesn't flash. Also surfaces a server-restart detection
// (Feature 1 / S3): when the daemon generation (epoch) changes across a live
// connection, it restarted while you were connected — the merge-protect in
// applySnapshot already shielded the agent chips, and this toast tells you a
// re-sync is in flight.
//
// TRANSPORT ONLY — this toast reflects the worker SSE stream (sync.ts), NOT
// OpenCode's own health. "Server restarted" here means the vh-solara daemon,
// never OpenCode; OpenCode lifecycle (starting/failed/…) is surfaced separately
// by OpenCodeHealthPanel. Keep the wording topology-agnostic so the two can't
// be conflated.
export default function ConnectionToast() {
  const [toast, setToast] = createSignal<{ kind: "warn" | "ok"; text: string } | null>(null);
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let warned = false;

  createEffect(() => {
    // Read both so this re-runs on either change. epochChanged is latched by
    // applySnapshot when an epoch transition is detected on a LIVE connection.
    const st = state.status;
    const ec = state.epochChanged;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (ec) {
      // Consume the latch here (only the toast surfaces it). warned=false so
      // the subsequent live transition does NOT also fire a "Reconnected".
      consumeEpochChanged();
      warned = false;
      // Say "vh-solara" explicitly so this can't be read as an OpenCode event
      // (the OpenCodeHealthPanel owns OpenCode lifecycle separately).
      setToast({ kind: "warn", text: "vh-solara restarted — re-syncing…" });
      hideTimer = window.setTimeout(() => setToast(null), 4000);
      return;
    }
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
      <div class={styles["conn-toast"]} classList={{ [toast()!.kind]: true }} role="status">
        <Icon name={toast()!.kind === "warn" ? "help" : "check"} size={15} />
        <span>{toast()!.text}</span>
      </div>
    </Show>
  );
}
