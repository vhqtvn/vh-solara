// Send-action status surface — send-reliability slice 3 (brief §4.4).
//
// Renders the operator-visible recovery states that slice 2 made expressible
// in lib/sendActionStatus (typed certainty + recovery per attempt), plus the
// server-custody line for a session whose queue holds messages while the
// stream is down. Mounted by Composer where the Send button's glow lives —
// the glow stays (a glance-level signal), but every state here is READABLE
// TEXT, never glow-only.
//
// Copy contract (normative, brief §4.4):
//   preparing (uploads in flight) → "Uploading 1 of 2…"
//   preparing / admitting          → "Sending…"
//   admitting, reused attemptId    → "Retrying queue confirmation…"
//   server custody + stream down   → "Queued — waiting for connection."
//   admission response lost        → "Queue confirmation unknown." + retry
//                                    THE SAME prepared enqueue (same
//                                    attemptId; no reupload, no new session)
//   ambiguous (session create /    → "Outcome unknown — check before sending
//   upload / proxy-502 dispatch)      again." — NO unqualified Retry button
//   definitive rejection           → persistent failure notice; the composer
//                                    retains text + attachments (restore)
//   resolve write failed           → "Message outcome recorded; status not
//                                    saved." + Retry STATUS SAVE (a record,
//                                    never a resend)
//
// Honesty invariants:
//   - An unconfirmed BROWSER draft is NEVER called "queued" — the custody line
//     renders only for a non-draft session whose SERVER queue holds items.
//   - A retry affordance that replays a verbatim attempt payload SURFACES what
//     it will send (text + file names) — a retry re-includes chips the
//     operator may have removed after the attempt (slice-2 advisory).
//   - Polite live region (aria-live="polite") announces status changes.
//
// CSS: co-located SendStatus.module.css (CSS Modules). Every class is
// :global in the module and applied as a LITERAL string here (repo CSS-arch
// rule: test-queried classes stay :global — vitest does not process CSS
// modules, so a `styles.X` lookup would be undefined in unit tests); the
// sendStatus* prefix keeps the global namespace collision-free. No
// mask/backdrop-filter/contain (Firefox/WebRender GPU rules — this is an
// always-possible composer surface; keep it a cheap, fixed-height text row).
import { createSignal, For, Show, type Accessor } from "solid-js";
import {
  finishSendAttempt,
  sendActionsFor,
  type SendAction,
} from "../../lib/sendActionStatus";
import { hasQueueState, resolveQueued } from "../../queue";
import "./SendStatus.module.css";

export interface SendStatusProps {
  // Live session id ("" for a draft).
  sessionId: Accessor<string>;
  draft: Accessor<boolean>;
  // Retry of an uncertain admission: the SAME composer send path (createSend
  // re-tap linkage — same attemptId + verbatim payload when the text matches,
  // a fresh attempt otherwise). Never a direct enqueue bypass.
  send: () => Promise<void>;
  // Ordinal upload progress (createAttachments.uploadProgress) for the
  // "Uploading 1 of 2…" copy; null when idle.
  uploadProgress: Accessor<{ done: number; total: number } | null>;
  // Global stream status ("connecting" | "live" | "reconnecting") — the
  // server-custody line keys off a known-down stream ("reconnecting").
  streamStatus: Accessor<string>;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function SendStatus(props: SendStatusProps) {
  const ownerKey = () => (props.draft() ? "draft" : props.sessionId());
  const records = () => sendActionsFor(ownerKey());
  // Server custody + stream down. NEVER for a draft: an unconfirmed browser
  // draft is not "queued" (the word is reserved for server custody).
  const custodyLine = () =>
    !props.draft() &&
    !!props.sessionId() &&
    hasQueueState(props.sessionId()) &&
    props.streamStatus() === "reconnecting";

  const [saveBusy, setSaveBusy] = createSignal<string | null>(null);

  // Retry STATUS SAVE (stage "unsaved"): re-records the already-known terminal
  // outcome via resolveQueued — a record, NEVER a resend (no prompt is ever
  // POSTed). On a recorded/conflict outcome the record is finished (a conflict
  // re-marks itself server-authoritative inside resolveQueued); on another
  // unrecorded outcome the record re-marks itself and stays.
  async function retrySave(rec: SendAction) {
    const save = rec.retrySave;
    if (!save || saveBusy()) return;
    setSaveBusy(rec.attemptId);
    try {
      const out = await resolveQueued(ownerKey(), save.itemId, save.state, save.detail);
      if (out.kind !== "unrecorded") finishSendAttempt(rec.attemptId);
    } finally {
      setSaveBusy(null);
    }
  }

  // Per-stage primary copy (brief §4.4 matrix). Returned null means "nothing
  // to render for this record" (admitted never appears — the record is
  // finished on confirmation).
  function lineFor(rec: SendAction): string | null {
    switch (rec.stage) {
      case "preparing": {
        const p = props.uploadProgress();
        if (p && p.total > 0) return `Uploading ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
        return "Sending…";
      }
      case "admitting":
        return rec.retry ? "Retrying queue confirmation…" : "Sending…";
      case "uncertain":
        // Admission-response loss (recovery "retry-same") gets the dedicated
        // copy + affordance; every other uncertainty (session create, upload,
        // proxy-502 dispatch) is check-before-sending — never a blanket Retry.
        return rec.recovery === "retry-same"
          ? "Queue confirmation unknown."
          : "Outcome unknown — check before sending again.";
      case "conflict":
        return "Queue state conflict — check the queue.";
      case "rejected":
      case "blocked":
        return "Not sent — kept in the composer.";
      case "unsaved":
        return "Message outcome recorded; status not saved.";
      default:
        return null;
    }
  }

  return (
    <Show when={records().length > 0 || custodyLine()}>
      <div class="sendStatus" aria-live="polite" data-testid="send-status">
        <Show when={custodyLine()}>
          <div class="sendStatusLine" data-kind="custody">
            Queued — waiting for connection.
          </div>
        </Show>
        <For each={records()}>
          {(rec) => {
            const line = () => lineFor(rec);
            return (
              <Show when={line()}>
                <div class="sendStatusLine" data-kind={rec.stage} data-tip={rec.detail || undefined}>
                  <span class="sendStatusText">{line()}</span>
                  {/* Retry send — ONLY for an uncertain ENQUEUE outcome whose
                      replay is deduped server-side (recovery "retry-same").
                      The affordance surfaces the verbatim payload it will
                      send (text + files): a retry re-includes chips the
                      operator may have removed after the attempt. */}
                  <Show when={rec.stage === "uncertain" && rec.recovery === "retry-same"}>
                    <span class="sendStatusPayload">
                      Will send: “{clip(rec.payload?.text ?? rec.payload?.tapText ?? "", 80)}”
                      <Show when={(rec.payload?.files?.length ?? 0) > 0}>
                        {" "}+ {rec.payload!.files!.join(", ")}
                      </Show>
                    </span>
                    <button
                      type="button"
                      class="sendStatusBtn"
                      data-tip="Re-queues the same message under the same attempt id — no duplicate if the first one landed"
                      onClick={() => void props.send()}
                    >
                      Retry send
                    </button>
                  </Show>
                  {/* Retry STATUS SAVE — stage "unsaved" only. Re-records the
                      known terminal outcome; NEVER resends the message. */}
                  <Show when={rec.stage === "unsaved" && rec.retrySave}>
                    <button
                      type="button"
                      class="sendStatusBtn"
                      disabled={saveBusy() === rec.attemptId}
                      data-tip="Re-records the outcome on the queue — does not send anything"
                      onClick={() => void retrySave(rec)}
                    >
                      {saveBusy() === rec.attemptId ? "Saving status…" : "Retry status save"}
                    </button>
                  </Show>
                  {/* Dismiss — retained non-transient records only (the
                      transient preparing/admitting rows are the live send's
                      own progress; clearing them mid-flight would lie). */}
                  <Show
                    when={
                      rec.stage === "uncertain" ||
                      rec.stage === "conflict" ||
                      rec.stage === "rejected" ||
                      rec.stage === "blocked" ||
                      rec.stage === "unsaved"
                    }
                  >
                    <button
                      type="button"
                      class="sendStatusDismiss"
                      aria-label="Dismiss status"
                      onClick={() => finishSendAttempt(rec.attemptId)}
                    >
                      ×
                    </button>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export default SendStatus;
