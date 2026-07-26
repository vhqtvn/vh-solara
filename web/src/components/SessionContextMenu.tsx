import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { abortSession, sessionProjectID, sessionWorking, state } from "../sync";
import { suggestTitle } from "../sessionTitle";
import { isPinned, togglePin, movePinnedByOffset, reconciledPinnedOrder, pinsPending, pinsLastError, clearPinsError } from "../sidebar";
import { exportSessionMarkdown } from "../export";
import { pushNotification } from "../notify";
import { archiveSession, fetchDescendants, ArchiveDriftError, type SessionSummary } from "../archive";
import { withGlobalBusy } from "../busy";
import {
  archiveTarget,
  closeArchiveConfirm,
  closeSessionMenu,
  menuTarget,
  openArchiveConfirm,
} from "../sessionMenu";
import { displayName } from "../projectSettings";
import Icon from "./Icon";
import TextPromptDialog from "./TextPromptDialog";

const copy = (text: string) => void navigator.clipboard?.writeText(text);

// Pin sync error → human label for the menu's retry hint. The action buttons
// below (Pin/Unpin, Move up/down) double as the retry affordance: re-clicking
// re-issues the mutation against the current authoritative state.
function pinErrorLabel(): string {
  switch (pinsLastError()) {
    case "pin-conflict":
      return "Pin sync conflict — retry";
    case "pin-network":
      return "Pin sync failed — offline";
    case "pin-error":
      return "Pin sync failed";
    default:
      return "";
  }
}

// Update a session's title in OpenCode (PATCH /session/:id). The change comes
// back as a session.updated event, so the tree refreshes itself.
async function setSessionTitle(id: string, title: string) {
  await fetch(`/oc/session/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
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

  // Server-authoritative archive-impact descendant list (P4). Replaces the FE
  // resident-map walk (relatedSessions + childrenIndex), which omitted unloaded
  // descendants of collapsed frontier nodes. Fetched from
  // GET /vh/session/:id/descendants when the confirm dialog opens
  // (archiveTarget set).
  //
  // Optimistic seeding: the target itself is ALWAYS in the affected set (an
  // archive of id cascades to id + its subsessions), so we show [{id, title}]
  // immediately — no empty-flash while the fetch is in flight. On success the
  // server list (which includes the target as element 0) replaces it. On
  // failure we keep the optimistic single-item list (the user can still archive
  // the one session they acted on; the server's own cascade handles subsessions
  // regardless of what the preview showed).
  //
  // Stale-response suppression: a monotonic request id discards a prior
  // in-flight response if the target changed (a re-open is rare but possible).
  // The revision is carried for diagnostics / cache validation per the Q3
  // envelope; we don't cross-open cache (the dialog is short-lived and the
  // server walk is a cheap local store read).
  const [relatedItems, setRelatedItems] = createSignal<SessionSummary[]>([]);
  // C5 drift fence: the subtree-id-set fingerprint captured alongside the
  // descendant list. Echoed back as expectedFingerprint on POST /vh/archive so
  // the server can 409-reject when the affected set's membership changed
  // between preview and commit. "" = no fence (preview not yet resolved, or
  // fetch failed) — archiveSession omits the fingerprint in that case and the
  // server applies the legacy no-precondition behavior.
  const [relatedFingerprint, setRelatedFingerprint] = createSignal<string>("");
  let relatedReqId = 0;
  createEffect(() => {
    const t = archiveTarget();
    if (!t) {
      setRelatedItems([]);
      setRelatedFingerprint("");
      return;
    }
    setRelatedItems([{ id: t.id, title: t.title }]);
    setRelatedFingerprint(""); // cleared until the fetch resolves
    const myReq = ++relatedReqId;
    void (async () => {
      try {
        const resp = await fetchDescendants(t.id);
        if (myReq !== relatedReqId) return; // superseded by a later open
        // A non-empty server list replaces the optimistic seed. An empty list
        // means the id is unknown to the server's live store (pruned between
        // the right-click and the fetch) — keep the optimistic [{id, title}]
        // seed rather than flashing "0 sessions": the target itself is always
        // in the affected set, and the archive POST tolerates an unknown id.
        const list = resp.data?.descendants || [];
        if (list.length) setRelatedItems(list);
        // The fingerprint is always captured (even when the list is empty and
        // we keep the seed): the server returns FingerprintIDs([id]) for an
        // unknown id, matching the archive commit's empty-set fallback, so
        // preview↔commit stay coherent on the orphan/ghost path.
        setRelatedFingerprint(resp.data?.fingerprint ?? "");
      } catch {
        // Keep the optimistic single-item list on transport/server failure.
        // Fingerprint stays "" (no fence) — fail-open, matching the existing
        // behavior where a failed preview does not block the archive.
      }
    })();
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
    const suggestion = await suggestTitle(id, sessionProjectID(id));
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
        {/* Pin sync error hint (dismissible). The mutation resolves AFTER the
            menu closes (async PUT), so this surfaces a lingering error when the
            menu is re-opened — the action buttons below serve as retry. */}
        <Show when={pinsLastError()}>
          <div class="ctxm-pinerr" role="status">
            <span class="ctxm-pinerr-text">{pinErrorLabel()}</span>
            <button
              type="button"
              class="icon-btn ctxm-pinerr-x"
              aria-label="Dismiss pin sync error"
              onClick={clearPinsError}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        </Show>
        <button
          type="button"
          class="ctxm-item"
          disabled={pinsPending()}
          onClick={() => {
            void togglePin(props.id);
            closeSessionMenu();
          }}
        >
          <Icon name="layers" size={14} /> {isPinned(props.id) ? "Unpin" : "Pin to top"}
        </button>
        {/* Keyboard reorder for pinned ROOT sessions only (the pointer drag
            handle has no keyboard affordance). The scope fence matches the
            drag feature: subsessions and unpinned rows never show these.
            Disabled at the ends so the first item's "Move up" and last item's
            "Move down" read as inert rather than firing a no-op. Also disabled
            while a pin mutation is in flight (pinsPending) so a conflicting
            reorder cannot stack on an unresolved PUT. */}
        <Show when={isPinned(props.id) && !state.sessions[props.id]?.parentID}>
          {(() => {
            const order = reconciledPinnedOrder();
            return (
              <>
                <button
                  type="button"
                  class="ctxm-item"
                  disabled={pinsPending() || order[0] === props.id}
                  onClick={() => {
                    void movePinnedByOffset(props.id, -1);
                    closeSessionMenu();
                  }}
                >
                  <Icon name="arrowUp" size={14} /> Move up
                </button>
                <button
                  type="button"
                  class="ctxm-item"
                  disabled={pinsPending() || order[order.length - 1] === props.id}
                  onClick={() => {
                    void movePinnedByOffset(props.id, 1);
                    closeSessionMenu();
                  }}
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
      try {
        await archiveSession(t.id, relatedFingerprint());
        closeArchiveConfirm();
      } catch (e) {
        if (e instanceof ArchiveDriftError) {
          // C5 drift: the affected set changed between preview and commit. The
          // server archived NOTHING (409). Re-fetch descendants and re-show
          // this dialog against the CURRENT set so the operator can re-confirm.
          // NO auto-retry — the operator consented to the OLD set, not the new
          // one, and auto-retrying would defeat the fence. Bump relatedReqId
          // so a concurrent close+reopen (which fires the effect) cannot land
          // this stale re-fetch's items over a fresher open.
          const myReq = ++relatedReqId;
          try {
            const resp = await fetchDescendants(t.id);
            if (myReq !== relatedReqId) return; // superseded by a reopen
            const list = resp.data?.descendants || [];
            if (list.length) setRelatedItems(list);
            setRelatedFingerprint(resp.data?.fingerprint ?? "");
            pushNotification({
              kind: "info",
              sessionID: t.id,
              title: "Affected sessions changed — review and confirm again",
            });
          } catch {
            // Re-fetch failed: leave the dialog on the (now-stale) list. The
            // operator can close or retry. The consumed fingerprint is already
            // stale (the 409 fired), so a retry will fence again only if the
            // set is STILL different — acceptable fail-safe.
          }
          return; // do NOT closeArchiveConfirm — re-show for re-consent
        }
        throw e; // non-drift errors propagate to withGlobalBusy's caller
      }
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
                This will archive <strong>{relatedItems().length}</strong>{" "}
                {relatedItems().length === 1 ? "session" : "sessions"} (the session and all its subsessions):
              </p>
              <ul class="confirm-list">
                <For each={relatedItems()}>
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
                Archive {relatedItems().length > 1 ? `${relatedItems().length} sessions` : "session"}
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
