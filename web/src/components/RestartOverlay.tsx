import { createEffect, Show } from "solid-js";
import { state } from "../sync";
import { setVhRestarting, vhRestarting } from "../admin";

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

  return (
    <Show when={vhRestarting()}>
      <div class="restart-overlay" role="alertdialog" aria-label="Restarting server">
        <div class="restart-card">
          <span class="restart-spinner" aria-hidden="true" />
          <h2>Restarting vh server</h2>
          <p class="restart-phase">{phase()}</p>
          <p class="restart-hint">OpenCode keeps running; your sessions are safe.</p>
          <button type="button" class="restart-reload" onClick={() => location.reload()}>
            Force reload
          </button>
        </div>
      </div>
    </Show>
  );
}
