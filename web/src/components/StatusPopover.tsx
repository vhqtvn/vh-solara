import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { oc } from "../api";
import ServersPanel from "./ServersPanel";
import Icon from "./Icon";

// Header status button + popover for Server / MCP / LSP / Plugins, mirroring
// opencode web's status popover. A small dot on the icon reflects MCP health:
// green = all connected, yellow = needs attention, gray = none/unknown.
export default function StatusPopover() {
  const [open, setOpen] = createSignal(false);
  const [mcp] = createResource(() => oc.get<Record<string, any>>("/mcp"));

  const dot = createMemo(() => {
    const entries = Object.values(mcp() || {});
    if (entries.length === 0) return "none";
    const statuses = entries.map((e: any) => e.status);
    if (statuses.some((s) => s && s !== "connected")) return "warn";
    return "ok";
  });

  let rootEl: HTMLDivElement | undefined;
  const onDoc = (e: MouseEvent) => {
    // composedPath (not contains) so a click on an inner control that re-renders
    // and detaches the clicked node isn't misread as an outside click.
    if (open() && rootEl && !e.composedPath().includes(rootEl)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  onMount(() => {
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("click", onDoc);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class="status-pop" ref={rootEl}>
      <button
        type="button"
        class="icon-btn status-btn"
        aria-label="Servers"
        data-tip="Server / MCP / LSP / Plugins"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="layers" />
        <span class="status-dot" classList={{ [dot()]: true }} />
      </button>
      <Show when={open()}>
        <div class="status-menu" role="dialog" aria-label="Servers">
          <ServersPanel />
        </div>
      </Show>
    </div>
  );
}
