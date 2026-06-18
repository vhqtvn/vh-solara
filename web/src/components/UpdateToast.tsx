import { Show } from "solid-js";
import { applyUpdate, updateReady } from "../pwa";
import Icon from "./Icon";

// Non-intrusive "a new version is available" banner. The app keeps running on
// the cached version until the user chooses to reload.
export default function UpdateToast() {
  return (
    <Show when={updateReady()}>
      <div class="update-toast" role="status">
        <Icon name="retry" size={15} />
        <span class="update-toast-text">A new version is available.</span>
        <button type="button" class="update-toast-btn" onClick={applyUpdate}>
          Reload
        </button>
      </div>
    </Show>
  );
}
