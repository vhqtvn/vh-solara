import { Show } from "solid-js";
import { globalBusy } from "../busy";
import styles from "./WorkingOverlay.module.css";

// Full-screen overlay shown while a global busy scope is active (archive /
// unarchive of large session subtrees). Keeps the user informed and blocks
// pointer interaction while the stream gate suppresses live updates and the
// coalesced reconciliation runs. Always mounted; renders only while active.
//
// CSS is deliberately cheap (no backdrop-filter, no mask-image, no
// contain:paint, no content-visibility — see AGENTS.md Firefox/WebRender GPU
// gotchas). A flat near-opaque scrim reads the same as a blur without the
// per-frame re-rasterization cost.
export default function WorkingOverlay() {
  return (
    <Show when={globalBusy()}>
      <div class={styles["working-overlay"]} role="alertdialog" aria-busy="true" aria-label="Working">
        <div class={styles["working-card"]}>
          <span class={styles["working-spinner"]} aria-hidden="true" />
          <h2>Working…</h2>
          <p class={styles["working-hint"]}>Syncing your sessions.</p>
        </div>
      </div>
    </Show>
  );
}
