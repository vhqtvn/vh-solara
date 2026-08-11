import { createSignal, For, Show } from "solid-js";
import { archiveFailures } from "../archiveFailures";
import { archiveSession } from "../archive";
import { withGlobalBusy } from "../busy";
import { displayName } from "../projectSettings";
import Icon from "./Icon";
import styles from "./ArchiveFailureBanner.module.css";

// A banner that surfaces PERMANENTLY-STUCK archive ROOTS — sessions where the
// archive cascade exhausted its retry budget or hit a permanent OpenCode error
// (400/403). Distinct from OrphanBanner in EVERY dimension:
//   - DATA SOURCE: this renders from the archiveFailures() SSE-driven signal
//     (a server-side (dir,id) registry), NOT the client tree. The tree eager-
//     prunes accepted ids and doesn't proactively re-emit retained stuck roots
//     (Q5 finding), so the banner CANNOT anchor to a tree node.
//   - SEMANTICS: an orphan is a DESCENDANT whose root archived successfully but
//     the cascade missed it (recoverable, root is gone); an archive FAILURE is
//     a ROOT that never archived at all (the operator must retry or intervene).
//   - LABELS: this banner says "archive failure" / "Couldn't archive session",
//     NEVER "orphan" (the two must not be conflated — distinct banner, distinct
//     recovery path, distinct operator mental model).
//
// Retry re-issues POST /vh/archive for the stuck id via the existing
// archiveSession helper. The 200-accepted response does NOT clear the warning
// (acceptance ≠ success — RT4); the warning clears only when the background
// cascade actually succeeds and the server emits an archive-failures.updated
// frame with the id removed (clear-on-success at the runArchiveCascade success
// funnel — pkg/web/archive.go). So this component NEVER locally removes a
// failure on retry-click — it waits for the server frame.
//
// Collapse (Show/Hide) is CLIENT-ONLY: it hides the expanded detail list
// without erasing the server-side record (RT9 — the summary banner stays until
// the server clears it). A reconnect re-applies the server snapshot; since the
// collapse is local UI state, the banner re-renders correctly from the DTO.
//
// Mobile viewport saturation (build-validate 2): multiple failures + a
// potential orphan banner could stack on a small screen. The expanded list is
// capped at max-height 240px with overflow-y auto (see the CSS module) so it
// scrolls within the sidebar rather than pushing the session tree off-screen.
export default function ArchiveFailureBanner() {
  const [expanded, setExpanded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [retryingId, setRetryingId] = createSignal<string | null>(null);

  async function retryOne(id: string): Promise<void> {
    setRetryingId(id);
    setBusy(true);
    try {
      // archiveSession resolves on 200-accepted and throws on !ok. The banner
      // clears when the server's clear-on-success emits the updated frame —
      // NOT here (acceptance ≠ success). A throw surfaces as an alert so the
      // operator sees the retry itself failed at the transport layer.
      await archiveSession(id);
    } catch (err) {
      alert(`Retry failed: ${String(err)}`);
    } finally {
      setRetryingId(null);
      setBusy(false);
    }
  }

  async function retryAll(): Promise<void> {
    setBusy(true);
    try {
      await withGlobalBusy(async () => {
        for (const f of archiveFailures()) {
          await archiveSession(f.id);
        }
      });
    } catch (err) {
      alert(`Retry failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={archiveFailures().length > 0}>
      <div class={styles["af-banner"]} role="status">
        <span class={styles["af-banner-text"]}>
          <Icon name="help" size={13} /> {archiveFailures().length} archive{" "}
          {archiveFailures().length === 1 ? "failure" : "failures"}
        </span>
        <button
          type="button"
          class={styles["af-banner-btn"]}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded()}
        >
          {expanded() ? "Hide" : "Show"}
        </button>
      </div>

      <Show when={expanded()}>
        <div class={styles["af-list"]}>
          <For each={archiveFailures()}>
            {(f) => (
              <div class={styles["af-row"]}>
                <div class={styles["af-row-main"]}>
                  <span class={styles["af-row-id"]}>{displayName(f.id)}</span>
                  {/* The classified reason token renders VERBATIM (a diagnostic
                      code, not prose). NEVER raw opencode.Error.Body — the
                      client never receives it (only the classified token
                      crosses the wire). data-reason anchors the RT10
                      regression assertion. */}
                  <span class={styles["af-row-reason"]} data-reason={f.reason}>
                    {f.reason}
                  </span>
                </div>
                <div class={styles["af-row-actions"]}>
                  <button
                    type="button"
                    class={styles["af-row-btn"]}
                    disabled={busy() && retryingId() !== f.id}
                    onClick={() => void retryOne(f.id)}
                  >
                    {retryingId() === f.id ? "Retrying…" : "Retry"}
                  </button>
                </div>
              </div>
            )}
          </For>
          <Show when={archiveFailures().length > 1}>
            <button
              type="button"
              class={styles["af-retry-all"]}
              disabled={busy()}
              onClick={() => void retryAll()}
            >
              {busy() ? "Retrying all…" : "Retry all"}
            </button>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
