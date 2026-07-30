// Queue-recovery controller — the "retract-to-compose" and "mark-sent"
// affordances for failed/unknown queued messages (Bug 1 / Bug 2).
//
// Extracted from ChatView.tsx so the recovery state machine (occupied-composer
// guard → confirm-delete-first → restore text → filter attachments → reset
// transient composer state → best-effort focus) is unit-testable in isolation,
// mirroring the createComposerAutocomplete (C3) / createAttachments (C6) /
// createPromptHistory (C5) / createComposerPaste (C4) precedent: a SolidJS
// `create...` controller factory (NOT a React-style `use...` hook).
//
// WHY a factory: ChatView pulls in ~15 stateful modules; mounting it whole for a
// retract test is impractical. The factory takes Accessor<T> reactive inputs +
// explicit setters + DOM ref accessors + the queue ops (observable
// removeQueued + the existing resolveQueued) and returns the two recovery
// actions. ChatView wires its own signals/closures; tests pass fakes under
// createRoot.
//
// INVARIANTS (the settled assumptions this controller exists to preserve):
//   - A manual resend ENQUEUES A NEW item. Retract NEVER revives/repends the
//     old one: it deletes the old item, restores text to the composer, and
//     stops. The subsequent Send follows the normal sendText path → a NEW item.
//   - Retract NEVER enqueues or dispatches. It only (a) removes the old item,
//     (b) restores composer state. markSent NEVER enqueues or dispatches — it
//     only records a terminal outcome via the existing resolve op.
//   - `dispatching` is non-removable (backend DELETE → 409). Retract confirms
//     the DELETE before touching the composer, so a 409 / failed DELETE aborts
//     the restore leaving the composer untouched.
//   - markSent resolves to terminal `sent` (the only auto-clear state) and is
//     restricted to `unknown`.
import { type Accessor } from "solid-js";
import type { QueuedMessage, RemoveQueuedResult } from "../../queue";
import { isInlineChipUrl } from "../../lib/inlineAttach";
import type { Attachment } from "./createAttachments";

// Notification shape the controller needs (a subset of notify.ts's
// pushNotification so this module owns NO notification store). `kind` mirrors
// NotifyKind's non-error members: this controller only emits informational
// notices (occupied-composer refusal, removal failure, dropped inline
// attachments) — never errors (those belong to the dispatch/resolve paths).
export interface RecoveryNotice {
  kind: "info" | "waiting" | "done";
  title: string;
  detail?: string;
}

export interface QueueRecoveryDeps {
  // Session the recovery acts on (used for removeQueued / resolveQueued).
  sessionId: Accessor<string>;
  // Composer text — the occupied-guard read AND the restore write.
  input: Accessor<string>;
  setInput: (v: string) => void;
  // Composer attachments — the occupied-guard read AND the restore write. Only
  // server-backed attachments are restorable (inline vh-attach: chips hold
  // in-memory File bytes that are cleared after enqueue → unrecoverable).
  attachments: Accessor<Attachment[]>;
  setAttachments: (next: Attachment[]) => void;
  // Transient composer-state reset seams (the existing controller surfaces):
  // dismiss the autocomplete popover and reset prompt-history walk cursors.
  dismissAutocomplete: () => void;
  resetHistory: () => void;
  // The composer textarea (may be undefined before mount) for best-effort
  // focus + select after restore.
  textarea: Accessor<HTMLTextAreaElement | undefined>;
  // Observable remove (Slice 1) — the caller learns whether the DELETE took.
  removeQueued: (sid: string, id: string) => Promise<RemoveQueuedResult>;
  // Existing resolve op (Slice 4) — records a terminal outcome; never dispatches.
  resolveQueued: (
    sid: string,
    id: string,
    state: "sent" | "failed" | "unknown",
    detail?: string,
  ) => Promise<void>;
  // Non-fatal operator notices. Injected so this module has no notification
  // store coupling (ChatView passes pushNotification).
  notify: (n: RecoveryNotice) => void;
}

export interface QueueRecovery {
  // Retract a failed/unknown item back into the composer to edit + re-send as a
  // NEW message. Safe operation order (see the header invariants). Never
  // enqueues or dispatches.
  retract: (q: QueuedMessage) => Promise<void>;
  // Mark an `unknown` item as sent (the operator confirms they can see the
  // corresponding user message in the transcript). Resolves to terminal `sent`
  // via the existing resolve op; never enqueues or dispatches. Restricted to
  // `unknown` — a no-op for any other state.
  markSent: (q: QueuedMessage) => Promise<void>;
}

export function createQueueRecovery(deps: QueueRecoveryDeps): QueueRecovery {
  async function retract(q: QueuedMessage): Promise<void> {
    const sid = deps.sessionId();

    // 1. Preflight the composer. NEVER silently overwrite an occupied composer
    //    (text or attachments the operator is mid-composing). Refuse with a
    //    clear notice rather than discarding/replacing their current draft —
    //    the operator clears or sends the current message first.
    if (deps.input().trim() !== "" || deps.attachments().length > 0) {
      deps.notify({
        kind: "info",
        title: "Composer is in use",
        detail: "Clear or send the current message before retracting a queued one.",
      });
      return;
    }

    // 2. Confirm-delete the old item FIRST. Only restore once deletion is
    //    confirmed, so a failed DELETE (e.g. the item became `dispatching` →
    //    409, or a network error) leaves the composer untouched instead of a
    //    dangling restored draft + a still-present chip.
    const result = await deps.removeQueued(sid, q.id);
    if (!result.removed) {
      deps.notify({
        kind: "info",
        title: "Couldn't retract",
        detail: result.nonRemovable
          ? "The message is sending and can't be retracted right now."
          : "The queued message could not be removed; the composer was left unchanged.",
      });
      return;
    }

    // 3. Restore the text. The per-session draft effect in ChatView persists it
    //    under this session's draft key — no separate draft write is needed.
    deps.setInput(q.text);

    // 4. Restore reusable (server-backed) attachments ONLY. Inline
    //    vh-attach:<localId> attachments held raw File bytes in memory that are
    //    cleared after enqueue, so they are UNRECOVERABLE — reconstructing them
    //    would emit broken refs. Drop them with a notice; restore the rest. The
    //    occupied guard above guarantees the composer's attachment list is empty
    //    here, so this setAttachments never clears unrelated attachments.
    const reusable = q.attachments.filter((a) => !isInlineChipUrl(a.url));
    const droppedInline = q.attachments.length - reusable.length;
    if (reusable.length > 0) {
      deps.setAttachments(
        reusable.map((a) => ({ url: a.url, filename: a.filename, mime: a.mime, path: a.path })),
      );
    }
    if (droppedInline > 0) {
      const plural = droppedInline === 1 ? "attachment was" : `${droppedInline} attachments were`;
      deps.notify({
        kind: "info",
        title: "Some attachments weren't restored",
        detail: `Inline ${plural} embedded in the message and can't be recovered; re-add them if needed.`,
      });
    }

    // 5. Reset transient composer state via the existing controller seams so a
    //    stale autocomplete popover or prompt-history walk doesn't leak onto the
    //    restored text.
    deps.dismissAutocomplete();
    deps.resetHistory();

    // 6. Focus + select, best-effort. In a microtask AFTER the controlled input
    //    updates, focus the textarea and select the restored text so the
    //    operator can immediately edit/replace it. Selection is progressive
    //    enhancement: mobile focus-after-async-delete can be flaky. The
    //    correctness requirement is restoring + persisting the text; if focus
    //    is blocked, leave the restored text intact rather than rolling back.
    queueMicrotask(() => {
      const ta = deps.textarea();
      if (!ta) return;
      try {
        ta.focus();
        if (typeof ta.setSelectionRange === "function") {
          ta.setSelectionRange(0, q.text.length);
        } else if (typeof ta.select === "function") {
          ta.select();
        }
      } catch {
        // Focus/selection is best-effort; the restored text is the correctness
        // bar and stays intact regardless.
      }
    });
  }

  async function markSent(q: QueuedMessage): Promise<void> {
    // Restricted to `unknown`. `failed` did NOT reach OpenCode (definitive
    // rejection) so marking it sent would be wrong; `pending`/`dispatching` are
    // non-terminal. `sent` is filtered upstream. Only `unknown` (ambiguous —
    // the dispatch may have landed) is a candidate for operator confirmation.
    if (q.state !== "unknown") return;
    // Reuse the EXISTING resolve op with target `sent` (the only auto-clear
    // state). This RECORDS an outcome for a dispatch that already happened; it
    // NEVER enqueues or dispatches (resolveQueued only writes, then bounded-
    // retries the write). The detail carries operator provenance for diagnostics.
    await deps.resolveQueued(deps.sessionId(), q.id, "sent", "Marked sent by operator");
  }

  return { retract, markSent };
}
