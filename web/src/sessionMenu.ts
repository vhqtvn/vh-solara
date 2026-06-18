// Session context-menu controller. Opened by right-click (desktop → positioned
// menu) or long-press (touch → centered dialog) on a session title, from the
// chat header or the sidebar. Also drives the archive confirmation.
import { createSignal } from "solid-js";

export interface MenuTarget {
  id: string;
  title: string;
  // Non-null x/y → positioned menu (mouse); null → centered dialog (touch).
  x: number | null;
  y: number | null;
}

const [menuTarget, setMenuTarget] = createSignal<MenuTarget | null>(null);
const [archiveTarget, setArchiveTarget] = createSignal<{ id: string; title: string } | null>(null);

export function openSessionMenu(id: string, title: string, x: number | null, y: number | null) {
  setMenuTarget({ id, title, x, y });
}
export function closeSessionMenu() {
  setMenuTarget(null);
}
export function openArchiveConfirm(id: string, title: string) {
  setMenuTarget(null);
  setArchiveTarget({ id, title });
}
export function closeArchiveConfirm() {
  setArchiveTarget(null);
}

// Reusable trigger handlers for an element representing a session title.
// Spread onto the element: {...menuTriggers(() => id, () => title)}.
export function menuTriggers(id: () => string, title: () => string) {
  let timer: number | undefined;
  let moved = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      openSessionMenu(id(), title(), e.clientX, e.clientY);
    },
    onTouchStart: () => {
      moved = false;
      clear();
      timer = window.setTimeout(() => {
        if (!moved) openSessionMenu(id(), title(), null, null);
      }, 500);
    },
    onTouchMove: () => {
      moved = true;
      clear();
    },
    onTouchEnd: clear,
  };
}

export { menuTarget, archiveTarget };
