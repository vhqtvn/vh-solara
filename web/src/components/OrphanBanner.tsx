import { createMemo, createSignal, For, Show } from "solid-js";
import { orphanSessions, rootInfoFor, type RootInfo } from "../orphans";
import { archiveSession } from "../archive";
import { withGlobalBusy } from "../busy";
import type { Session } from "../types";
import Icon from "./Icon";
import styles from "./OrphanBanner.module.css";

// A banner that surfaces orphaned sessions (parent root archived) so they're
// known, plus a confirmed bulk-archive that shows each orphan's root and whether
// that root is archived.
export default function OrphanBanner() {
  const orphans = createMemo(() => orphanSessions());
  const [open, setOpen] = createSignal(false);
  const [rows, setRows] = createSignal<{ orphan: Session; root: RootInfo | null }[]>([]);
  const [busy, setBusy] = createSignal(false);

  async function openDialog() {
    setRows(orphans().map((o) => ({ orphan: o, root: null })));
    setOpen(true);
    // Resolve each orphan's root info (cached by ancestor) in the background.
    const resolved = await Promise.all(
      orphans().map(async (o) => ({ orphan: o, root: await rootInfoFor(o.parentID!) })),
    );
    setRows(resolved);
  }

  async function confirm() {
    setBusy(true);
    try {
      // Archive each orphan (and its own subsessions) — sequential to be gentle
      // on the server when there are many. ONE outer global-busy scope around
      // the whole loop (not per-iteration) so the overlay stays continuously
      // visible and reconciliation runs once at the end.
      await withGlobalBusy(async () => {
        for (const o of orphans()) await archiveSession(o.id);
        setOpen(false);
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={orphans().length > 0}>
      <div class={styles["orphan-banner"]}>
        <span class={styles["orphan-banner-text"]}>
          <Icon name="help" size={13} /> {orphans().length} orphaned{" "}
          {orphans().length === 1 ? "session" : "sessions"}
        </span>
        <button type="button" class={styles["orphan-banner-btn"]} onClick={() => void openDialog()}>
          Archive orphans
        </button>
      </div>

      <Show when={open()}>
        <div class="dialog-overlay" onClick={() => !busy() && setOpen(false)}>
          <div class="dialog confirm" role="dialog" aria-label="Archive orphaned sessions" onClick={(e) => e.stopPropagation()}>
            <div class="dialog-head">
              <span class="dialog-title">Archive orphaned sessions</span>
              <button type="button" class="icon-btn" aria-label="Close" onClick={() => !busy() && setOpen(false)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div class="dialog-body">
              <p class="confirm-lead">
                These subsessions have no live parent — their root was archived. Archiving{" "}
                <strong>{orphans().length}</strong> {orphans().length === 1 ? "session" : "sessions"} removes them
                (and any of their own subsessions) from the tree:
              </p>
              <ul class="confirm-list">
                <For each={rows()}>
                  {(r) => (
                    <li>
                      <span class="confirm-title">{r.orphan.title || r.orphan.id}</span>
                      <span class={styles["orphan-root"]} classList={{ [styles["orphan-root-active"]]: !!r.root && !r.root.archived }}>
                        root: {r.root ? r.root.title : "resolving…"}
                        {r.root ? (r.root.archived ? " · archived" : " · ACTIVE") : ""}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel" disabled={busy()} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" class="confirm-go" disabled={busy()} onClick={() => void confirm()}>
                {busy() ? "Archiving…" : `Archive ${orphans().length > 1 ? `${orphans().length} sessions` : "session"}`}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Show>
  );
}
