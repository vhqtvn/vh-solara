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
import { setView } from "../ui";

export default function Sidebar(props: { open: boolean; onClose: () => void }) {
  const [archivedOpen, setArchivedOpen] = createSignal(false);
  // Search is collapsed by default (rarely used, and it costs a whole row). A
  // header toggle reveals it; an active filter keeps it shown so the filter is
  // never silently hidden.
  const [searchOpen, setSearchOpen] = createSignal(false);
  let searchInput: HTMLInputElement | undefined;
  const toggleSearch = () => {
    const next = !(searchOpen() || searchQuery());
    if (next) {
      setSearchOpen(true);
      queueMicrotask(() => searchInput?.focus());
    } else {
      setSearchQuery("");
      setSearchOpen(false);
    }
  };

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
        <button
          type="button"
          class="icon-btn"
          classList={{ on: searchOpen() || !!searchQuery() }}
          onClick={toggleSearch}
          data-tip="Search sessions"
          aria-label="Search sessions"
          aria-pressed={searchOpen() || !!searchQuery()}
        >
          <Icon name="filter" />
        </button>
        <button type="button" class="icon-btn" onClick={() => void newSession()} data-tip="New session" aria-label="Create session">
          <Icon name="plus" />
        </button>
        <button type="button" class="sidebar-close" onClick={props.onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div class="proj-bar">
        <ProjectSwitcher />
        <button
          type="button"
          class="proj-settings"
          aria-label="Agent styles"
          data-tip="Agent styles (this project)"
          onClick={() => {
            setView("agents");
            props.onClose(); // close the mobile slide-over; no-op on desktop
          }}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
      <Show when={searchOpen() || searchQuery()}>
        <div class="session-search">
          <Icon name="filter" size={13} />
          <input
            type="text"
            class="session-search-input"
            placeholder="Search sessions…"
            ref={searchInput}
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !searchQuery()) setSearchOpen(false);
            }}
          />
          <button type="button" class="session-search-clear" aria-label="Clear search" onClick={() => { setSearchQuery(""); searchInput?.focus(); }}>
            <Icon name="x" size={12} />
          </button>
        </div>
      </Show>
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
