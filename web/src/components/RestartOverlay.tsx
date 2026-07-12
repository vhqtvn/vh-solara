import { createEffect, Show } from "solid-js";
import { state } from "../sync";
import { setVhRestarting, vhRestarting } from "../admin";
import { snapshot } from "../opencode-lifecycle";
import styles from "./RestartOverlay.module.css";

// Full-screen overlay shown while the vh server restarts: "Restarting →
// Reconnecting", auto-dismissed once the stream is live again (after it dropped),
// with a force-reload escape hatch. Always mounted; renders only while active.
export default function RestartOverlay() {
  // Only hide once we've actually seen the connection drop and come back — a
  // restart that's still "live" for a beat shouldn't dismiss prematurely.
  let sawDrop = false;
  createEffect(() => {
    if (!vhRestarting()) {
      sawDrop = false;
      return;
    }
    if (state.status !== "live") sawDrop = true;
    else if (sawDrop) setVhRestarting(false);
  });

  const phase = () =>
    state.status === "reconnecting" ? "Reconnecting…" : sawDrop ? "Coming back up…" : "Restarting…";

  // "OpenCode keeps running" is topology-dependent. A DETACHED or EXTERNAL
  // OpenCode is a separate process that survives a vh-solara daemon restart, so
  // the claim holds. An OWNED OpenCode is a child of the daemon and is tied to
  // its lifetime — it restarts with the server, so the claim would be false. We
  // don't know the topology until the lifecycle surface reports it (older
  // daemons have no lifecycle surface → snapshot() is null); be conservative in
  // that case rather than over-promising. OpenCodeHealthPanel owns the detailed
  // post-restart health view either way.
  const keepsRunning = () => {
    const s = snapshot();
    return !!s && (s.topology === "detached" || s.topology === "external");
  };
  const hint = () =>
    keepsRunning()
      ? "OpenCode keeps running; your sessions are safe."
      : "Sessions are saved. OpenCode comes back up with the server.";

  return (
    <Show when={vhRestarting()}>
      <div class={styles["restart-overlay"]} role="alertdialog" aria-label="Restarting server">
        <div class={styles["restart-card"]}>
          <span class={styles["restart-spinner"]} aria-hidden="true" />
          <h2>Restarting vh server</h2>
          <p class={styles["restart-phase"]}>{phase()}</p>
          <p class={styles["restart-hint"]}>{hint()}</p>
          <button type="button" class={styles["restart-reload"]} onClick={() => location.reload()}>
            Force reload
          </button>
        </div>
      </div>
    </Show>
  );
}
