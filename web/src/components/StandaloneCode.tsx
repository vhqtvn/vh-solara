import { onCleanup, onMount } from "solid-js";
import CodeView from "./CodeView";
import { openFileLocal } from "../code/state";
import { applyTheme } from "../theme";

// The code viewer as a self-contained page, rendered inside a same-origin iframe
// by the main app (see CodeFrame.tsx) so its heavy DOM never lands in the main
// document. It listens for parent commands (open a file, re-apply theme) and
// announces readiness so queued commands flush.
export default function StandaloneCode() {
  onMount(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { type?: string; path?: string; line?: number };
      if (d?.type === "vh-code:open" && typeof d.path === "string") openFileLocal(d.path, d.line);
      else if (d?.type === "vh-code:theme") applyTheme(); // theme/localStorage is shared same-origin
    };
    window.addEventListener("message", onMsg);
    // Tell the parent we're ready to receive (and flush) queued commands.
    (window.parent || window).postMessage({ type: "vh-code:ready" }, location.origin);
    onCleanup(() => window.removeEventListener("message", onMsg));
  });
  return (
    <div class="code-standalone">
      <CodeView />
    </div>
  );
}
