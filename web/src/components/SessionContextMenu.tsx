import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { abortSession, sessionWorking, state } from "../sync";
import { suggestTitle } from "../sessionTitle";
import { isPinned, togglePin, movePinnedByOffset, reconciledPinnedOrder } from "../sidebar";
import { exportSessionMarkdown } from "../export";
import { pushNotification } from "../notify";
import { buildChildrenIndex } from "../lib/reduce";
import { archiveSession } from "../archive";
import { withGlobalBusy } from "../busy";
import {
  archiveTarget,
  closeArchiveConfirm,
  closeSessionMenu,
  menuTarget,
  openArchiveConfirm,
} from "../sessionMenu";
import type { Session } from "../types";
import { displayName } from "../projectSettings";
import Icon from "./Icon";
import TextPromptDialog from "./TextPromptDialog";

const copy = (text: string) => void navigator.clipboard?.writeText(text);

// Update a session's title in OpenCode (PATCH /session/:id). The change comes
// back as a session.updated event, so the tree refreshes itself.
async function setSessionTitle(id: string, title: string) {
  await fetch(`/oc/session/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

// Collect a session plus all its descendants (the sessions an archive affects).
function relatedSessions(rootId: string): Session[] {
  const index = buildChildrenIndex(state.sessions);
  const out: Session[] = [];
  const walk = (id: string) => {
    const s = state.sessions[id];
    if (s) out.push(s);
    for (const c of index[id] || []) walk(c.id);
  };
  walk(rootId);
  return out;
}

// Mounted once at the app root. Renders the right-click/long-press session menu
// and the archive confirmation dialog, both driven by ../sessionMenu signals.
export default function SessionContextMenu() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeSessionMenu();
      closeArchiveConfirm();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  // Clamp a positioned menu inside the viewport. The vertical clamp uses the
  // menu's MEASURED height (not a magic constant), so a right-click near the
  // bottom of a long session list no longer clips the lower items (Copy grid,
  // Archive…). On a screen shorter than the menu, the top pins to 8 and the
  // menu scrolls internally (max-height in styles.css). The 240 is a stable
  // approximation of the menu width (min-width: 232px); the menu's height is
  // what actually varies, so only that is measured.
  const MENU_FALLBACK_H = 320;
  let menuEl: HTMLDivElement | undefined;
  const [measuredH, setMeasuredH] = createSignal(MENU_FALLBACK_H);

  const pos = createMemo(() => {
    const t = menuTarget();
    if (!t || t.x == null || t.y == null) return null;
    const x = Math.min(t.x, window.innerWidth - 240);
    const y = Math.min(t.y, window.innerHeight - measuredH() - 8);
    return { x: Math.max(8, x), y: Math.max(8, y) };
  });

  // After the positioned menu mounts, measure its real height and re-clamp via
  // pos(). pos() is null while the menu is closed (or in touch/long-press mode),
  // so we reset to the fallback then — a future open starts from the safe
  // default rather than a value measured under a different viewport size. The
  // measure runs after one requestAnimationFrame so layout has settled; a single
  // 1-frame position correction may show on open, which is acceptable. Re-measure
  // on viewport resize while the menu is open.
  const remeasure = () => menuEl && setMeasuredH(menuEl.offsetHeight);
  createEffect(() => {
    if (!pos()) {
      setMeasuredH(MENU_FALLBACK_H);
      return;
    }
    const raf = requestAnimationFrame(remeasure);
    window.addEventListener("resize", remeasure);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", remeasure);
    });
  });

  const related = createMemo(() => {
    const t = archiveTarget();
    return t ? relatedSessions(t.id) : [];
  });

  // Rename/autorename use a DOM dialog (not window.prompt). One dialog drives
  // both: the pending state holds the title, label, seed, and apply callback.
  const [prompt, setPrompt] = createSignal<{
    id: string;
    title: string;
    label?: string;
    initial: string;
    confirm: string;
  } | null>(null);

  function rename(id: string, current: string) {
    closeSessionMenu();
    setPrompt({ id, title: "Rename session", initial: current, confirm: "Rename" });
  }
  // Ask OpenCode's small model for a name (works on any session, multi-turn or
  // not), then let the user confirm/edit before applying it.
  async function regenerate(id: string) {
    closeSessionMenu();
    pushNotification({ kind: "info", sessionID: id, title: "Generating a name…" });
    const suggestion = await suggestTitle(id, state.sessions[id]?.projectID);
    if (!suggestion) {
      pushNotification({
        kind: "error",
        sessionID: id,
        title: "Couldn't generate a name",
        detail: "The model didn't return a name — try again, or rename manually.",
      });
      return;
    }
    setPrompt({
      id,
      title: "Regenerate name",
      label: "Suggested name — edit or confirm:",
      initial: suggestion,
      confirm: "Apply",
    });
  }

  function Items(props: { id: string; title: string }) {
    const line = () => `${props.title} (${props.id})`;
    return (
      <>
        <button type="button" class="ctxm-item" onClick={() => (togglePin(props.id), closeSessionMenu())}>
          <Icon name="layers" size={14} /> {isPinned(props.id) ? "Unpin" : "Pin to top"}
        </button>
        {/* Keyboard reorder for pinned ROOT sessions only (the pointer drag
            handle has no keyboard affordance). The scope fence matches the
            drag feature: subsessions and unpinned rows never show these.
            Disabled at the ends so the first item's "Move up" and last item's
            "Move down" read as inert rather than firing a no-op. */}
        <Show when={isPinned(props.id) && !state.sessions[props.id]?.parentID}>
          {(() => {
            const order = reconciledPinnedOrder();
            return (
              <>
                <button
                  type="button"
                  class="ctxm-item"
                  disabled={order[0] === props.id}
                  onClick={() => (movePinnedByOffset(props.id, -1), closeSessionMenu())}
                >
                  <Icon name="arrowUp" size={14} /> Move up
                </button>
                <button
                  type="button"
                  class="ctxm-item"
                  disabled={order[order.length - 1] === props.id}
                  onClick={() => (movePinnedByOffset(props.id, 1), closeSessionMenu())}
                >
                  <Icon name="arrowDown" size={14} /> Move down
                </button>
              </>
            );
          })()}
        </Show>
        <button type="button" class="ctxm-item" onClick={() => rename(props.id, props.title)}>
          <Icon name="edit" size={14} /> Rename…
        </button>
        <button type="button" class="ctxm-item" onClick={() => void regenerate(props.id)}>
          <Icon name="retry" size={14} /> Regenerate name
        </button>
        {/* Recovery: always available — a zombie turn (e.g. killed by a network
            drop) can leave a session stuck "busy" with no composer Stop button,
            or even displaying idle while the server still holds the turn. */}
        <button
          type="button"
          class="ctxm-item"
          onClick={() => (void abortSession(props.id), closeSessionMenu())}
        >
          <Icon name="stop" size={14} /> Stop{sessionWorking(props.id) ? "" : " (force)"}
        </button>
        <div class="ctxm-sep" />
        {/* Copy/export: a 2-column grid so the menu stays short on small screens
            (the whole menu also scrolls as a safety net — see styles.css). */}
        <div class="ctxm-grouplabel">Copy</div>
        <div class="ctxm-grid">
          <button type="button" class="ctxm-item" onClick={() => (copy(props.title), closeSessionMenu())}>
            <Icon name="copy" size={14} /> Title
          </button>
          <button type="button" class="ctxm-item" onClick={() => (copy(props.id), closeSessionMenu())}>
            <Icon name="copy" size={14} /> Session id
          </button>
          <button type="button" class="ctxm-item" onClick={() => (copy(line()), closeSessionMenu())}>
            <Icon name="copy" size={14} /> Title + id
          </button>
          <button type="button" class="ctxm-item" onClick={() => (void exportSessionMarkdown(props.id, props.title), closeSessionMenu())}>
            <Icon name="copy" size={14} /> Export .md
          </button>
        </div>
        <div class="ctxm-sep" />
        <button
          type="button"
          class="ctxm-item danger"
          onClick={() => openArchiveConfirm(props.id, props.title)}
        >
          <Icon name="layers" size={14} /> Archive…
        </button>
      </>
    );
  }

  async function doArchive() {
    const t = archiveTarget();
    if (!t) return;
    await withGlobalBusy(async () => {
      await archiveSession(t.id);
      closeArchiveConfirm();
    });
  }

  return (
    <>
      {/* Right-click → positioned menu */}
      <Show when={menuTarget() && pos()}>
        <div class="ctxm-scrim" onClick={closeSessionMenu} onContextMenu={(e) => (e.preventDefault(), closeSessionMenu())}>
          <div
            class="ctxm-menu"
            ref={menuEl}
            role="menu"
            style={{ left: `${pos()!.x}px`, top: `${pos()!.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <Items id={menuTarget()!.id} title={menuTarget()!.title} />
          </div>
        </div>
      </Show>

      {/* Long-press (touch) → centered dialog */}
      <Show when={menuTarget() && !pos()}>
        <div class="dialog-overlay" onClick={closeSessionMenu}>
          <div class="ctxm-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div class="ctxm-sheet-title">{displayName(menuTarget()!.title)}</div>
            <Items id={menuTarget()!.id} title={menuTarget()!.title} />
          </div>
        </div>
      </Show>

      {/* Archive confirmation listing all related sessions */}
      <Show when={archiveTarget()}>
        <div class="dialog-overlay" onClick={closeArchiveConfirm}>
          <div class="dialog confirm" role="dialog" aria-label="Confirm archive" onClick={(e) => e.stopPropagation()}>
            <div class="dialog-head">
              <span class="dialog-title">Archive session</span>
              <button type="button" class="icon-btn" aria-label="Close" onClick={closeArchiveConfirm}>
                <Icon name="x" />
              </button>
            </div>
            <div class="dialog-body">
              <p class="confirm-lead">
                This will archive <strong>{related().length}</strong>{" "}
                {related().length === 1 ? "session" : "sessions"} (the session and all its subsessions):
              </p>
              <ul class="confirm-list">
                <For each={related()}>
                  {(s, i) => (
                    <li classList={{ root: i() === 0 }}>
                      <span class="confirm-title">{displayName(s.title || s.id)}</span>
                      <span class="confirm-id">{s.id}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel" onClick={closeArchiveConfirm}>
                Cancel
              </button>
              <button type="button" class="confirm-go" onClick={doArchive}>
                Archive {related().length > 1 ? `${related().length} sessions` : "session"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Rename / autorename dialog (replaces window.prompt). */}
      <TextPromptDialog
        open={!!prompt()}
        title={prompt()?.title ?? ""}
        label={prompt()?.label}
        initial={prompt()?.initial ?? ""}
        confirmText={prompt()?.confirm}
        onCancel={() => setPrompt(null)}
        onConfirm={(v) => {
          const p = prompt();
          if (p) void setSessionTitle(p.id, v);
          setPrompt(null);
        }}
      />
    </>
  );
}
