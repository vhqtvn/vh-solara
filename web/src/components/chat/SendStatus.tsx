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
//   status-save retry hit 409      → "Queue state conflict — showing server
//                                    state." — dismissable, never a silent
//                                    vanish (F3, slice-3 review)
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
  createLinkCandidates,
  finishSendAttempt,
  markSendAttemptResolveConflict,
  sendActionsFor,
  transferOwnerSendAttempts,
  type CreateLinkCandidate,
  type SendAction,
} from "../../lib/sendActionStatus";
import { hasQueueState, resolveQueued } from "../../queue";
import type { Session } from "../../types";
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
  // A1 create-linkage (send-defers study): the sync store's session map,
  // watched reactively for a session whose worker-stamped time.created falls
  // inside a draft-owned create-outcome-unknown record's create-attempt
  // window (createLinkCandidates ± CREATE_LINK_CLOCK_SKEW_MS). Timing is the
  // ONLY correlation signal — the create POST body is "{}" (no client id is
  // echoed back) — hence the affordance is operator-CONFIRMED, never a silent
  // auto-re-key. Optional: absent a session map (minimal unit harnesses) there
  // is nothing to correlate and the affordance stays hidden.
  sessions?: Accessor<Record<string, Session>>;
  // Navigation for a confirmed linkage (ChatView wires openSessionChat
  // semantics: select the session + jump to chat). Called AFTER the record
  // re-key, only from the operator's click.
  openSession?: (id: string) => void;
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

  // A1 create-linkage: candidate sessions for the draft's create-outcome-
  // unknown record(s) — reactive over BOTH the record store (records()) and
  // the session map (props.sessions(): the SSE-delivered session lands there
  // while the draft view is still mounted, no re-tap needed). Draft-view only:
  // a live session's ownerKey is its own id and can never be "draft".
  const createCandidates = () => {
    if (!props.draft() || !props.sessions || !props.openSession) return [];
    return createLinkCandidates(Object.values(props.sessions()), records());
  };

  // A1 confirm — NEVER silent: the re-key runs only from the operator's click
  // on the affordance. The sweep drains EVERY still-draft-owned record (the
  // study's C2 ride-along: a stale earlier record follows too instead of
  // stranding under "draft"), then navigation runs (openSessionChat
  // semantics via props).
  function confirmCreateLink(id: string) {
    transferOwnerSendAttempts("draft", id);
    props.openSession!(id);
  }

  // Candidate label: always carries the created clock time (the correlation
  // signal); the title only when it is not the generic create-time default
  // ("New session" — every fresh create is titled that, so it identifies
  // nothing).
  function candidateLabel(c: CreateLinkCandidate): string {
    const t = new Date(c.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const title = c.title?.trim() ?? "";
    const generic = title === "" || title === "New session";
    return generic ? `it (${t})` : `“${clip(title, 24)}” (${t})`;
  }

  // Retry STATUS SAVE (stage "unsaved"): re-records the already-known terminal
  // outcome via resolveQueued — a record, NEVER a resend (no prompt is ever
  // POSTed). Outcome handling (F3, slice-3 review — the conflict must be
  // VISIBLE, never a silent vanish): "recorded" finishes the row; "conflict"
  // re-marks THIS record as the dismissible conflict state (resolveQueued
  // already refreshed the queue cache to server truth and re-marked the
  // linked record when the item carries an attemptId — marking here too
  // covers the legacy unlinked shape and is an idempotent re-patch
  // otherwise); "unrecorded" leaves the row retryable as-is.
  async function retrySave(rec: SendAction) {
    const save = rec.retrySave;
    if (!save || saveBusy()) return;
    setSaveBusy(rec.attemptId);
    try {
      const out = await resolveQueued(ownerKey(), save.itemId, save.state, save.detail);
      if (out.kind === "recorded") {
        finishSendAttempt(rec.attemptId);
      } else if (out.kind === "conflict") {
        markSendAttemptResolveConflict(rec.attemptId, ownerKey(), out.detail || "queue_resolve_conflict");
      }
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
        // F3 (slice-3 review): a conflict reached through the RESOLVE path
        // (incl. a retrySave that hit 409 queue_resolve_conflict) has already
        // refreshed the queue cache to server truth — say so; the admission
        // flavor keeps the check-the-queue guidance.
        return rec.conflictSource === "resolve"
          ? "Queue state conflict — showing server state."
          : "Queue state conflict — check the queue.";
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
                  {/* Retry STATUS SAVE — stage "unsaved" only, and never for a
                      draft (F8, defense-in-depth: unsaved records are minted
                      under a live session id by the resolve path, so a draft
                      view — ownerKey "draft" — cannot legitimately hold one).
                      Re-records the known terminal outcome; NEVER resends the
                      message. */}
                  <Show when={!props.draft() && rec.stage === "unsaved" && rec.retrySave}>
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
        {/* A1 create-linkage (send-defers study): the draft's
            create-outcome-unknown record + a session that appeared inside the
            create-attempt window → an operator-CONFIRMED linkage affordance.
            Timing is the ONLY correlation signal (the create POST carries no
            client id), so nothing re-keys without this click; dismissing the
            uncertain row above (the ×) removes the affordance with it. Multiple
            candidates are each listed honestly — one button per session. */}
        <Show when={createCandidates().length > 0}>
          <div
            class="sendStatusLine"
            data-kind="create-link"
            data-tip="A session was created while your send's session-create was in flight — timing is the only match signal. Confirming moves this status there and opens it."
          >
            <span class="sendStatusText">A new session may be your last send —</span>
            <For each={createCandidates()}>
              {(c) => (
                <button
                  type="button"
                  class="sendStatusBtn"
                  data-session-id={c.id}
                  onClick={() => confirmCreateLink(c.id)}
                >
                  Open {candidateLabel(c)}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export default SendStatus;
