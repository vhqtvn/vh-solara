import { createMemo, createSignal, For, Show } from "solid-js";
import { treeMap } from "../sync/treeState";
import { archiveSession } from "../archive";
import { withGlobalBusy } from "../busy";
import { displayName } from "../projectSettings";
import Icon from "./Icon";
import styles from "./OrphanBanner.module.css";

// A banner that surfaces orphaned sessions. In tree=2 the SERVER marks a node
// Node.flags.orphan=true when its root is archived but the cascade-archive
// missed it — there is NO client-side orphan classification or root resolution.
// All orphan-flagged nodes are server-confirmed eligible for archive.
export default function OrphanBanner() {
  const orphans = createMemo(() =>
    Array.from(treeMap().values()).filter((n) => n.flags.orphan),
  );
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function confirm() {
    setBusy(true);
    try {
      const targets = orphans();
      await withGlobalBusy(async () => {
        for (const o of targets) await archiveSession(o.id);
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
        <button type="button" class={styles["orphan-banner-btn"]} onClick={() => setOpen(true)}>
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
                These subsessions are orphaned (their root is archived but the
                cascade-archive missed them). Archiving{" "}
                <strong>{orphans().length}</strong>{" "}
                {orphans().length === 1 ? "session" : "sessions"} removes them (and
                any of their own subsessions) from the tree:
              </p>
              <ul class="confirm-list">
                <For each={orphans()}>
                  {(o) => (
                    <li>
                      <span class="confirm-title">{displayName(o.title || o.id)}</span>
                      <span class="confirm-id">{o.id}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel" disabled={busy()} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="confirm-go"
                disabled={busy()}
                onClick={() => void confirm()}
              >
                {busy()
                  ? "Archiving…"
                  : `Archive ${orphans().length > 1 ? `${orphans().length} sessions` : "session"}`}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Show>
  );
}
