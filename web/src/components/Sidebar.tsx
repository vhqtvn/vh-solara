import { createSignal, Show } from "solid-js";
import { newSession, state } from "../sync";
import { searchQuery, setSearchQuery } from "../sidebar";
import { setSidebarWidth } from "../layout";
import SessionTree from "./SessionTree";
import ArchivedDialog from "./ArchivedDialog";
import ProjectSwitcher from "./ProjectSwitcher";
import OrphanBanner from "./OrphanBanner";
import HelpInspector from "./HelpInspector";
import BrandMark from "./BrandMark";
import Icon from "./Icon";

export default function Sidebar(props: { open: boolean; onClose: () => void }) {
  const [archivedOpen, setArchivedOpen] = createSignal(false);

  // Drag the right edge to resize; the sidebar sits at the viewport's left, so
  // the new width is just the pointer's X. Width is clamped + persisted in layout.
  function startResize(e: PointerEvent) {
    e.preventDefault();
    // Capture the pointer on the handle so the drag keeps getting pointermove —
    // on touch, without this (+ touch-action:none) the browser claims the
    // horizontal swipe as a scroll/back gesture after a few px, so the drag
    // "sticks" and only nudges a little.
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => setSidebarWidth(ev.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.releasePointerCapture?.(e.pointerId);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }
  return (
    <aside class="sidebar" classList={{ open: props.open }}>
      <div class="sidebar-head">
        <BrandMark class="brand-mark" />
        <strong>VHSolara</strong>
        <HelpInspector />
        <span class="status" classList={{ [state.status]: true }} data-tip="connection">
          {state.status}
        </span>
        <button type="button" class="icon-btn" onClick={() => void newSession()} data-tip="New session" aria-label="Create session">
          <Icon name="plus" />
        </button>
        <button type="button" class="sidebar-close" onClick={props.onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <ProjectSwitcher />
      <div class="session-search">
        <Icon name="filter" size={13} />
        <input
          type="text"
          class="session-search-input"
          placeholder="Search sessions…"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
        <Show when={searchQuery()}>
          <button type="button" class="session-search-clear" aria-label="Clear search" onClick={() => setSearchQuery("")}>
            <Icon name="x" size={12} />
          </button>
        </Show>
      </div>
      <OrphanBanner />
      <SessionTree />
      <div class="sidebar-foot">
        <button type="button" class="sidebar-foot-btn" onClick={() => setArchivedOpen(true)}>
          <Icon name="layers" size={14} /> Archived
        </button>
      </div>
      <Show when={archivedOpen()}>
        <ArchivedDialog onClose={() => setArchivedOpen(false)} />
      </Show>
      <div class="sidebar-resize" onPointerDown={startResize} data-tip="Drag to resize" />
    </aside>
  );
}
