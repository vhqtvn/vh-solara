// Send-status surface — O2 slice 2: compact merged happy path + severity-
// ordered recovery (design contract: researches/decisions/2026-09-25-send-state-
// ux-design-and-defers.md §1; richer per-choice detail in the O2 brief §3).
//
// STRUCTURE (slice 2):
//   - ONE compact transient line for the happy path (preparing/admitting
//     records are AGGREGATED — never one row per record):
//       1 active record → its own stage copy ("Uploading 1 of 2…" /
//                         "Sending…" / "Retrying queue confirmation…")
//       N active records → "N send actions in progress…" (the decision doc's
//                         copy matrix — never an invented merged upload
//                         denominator across records)
//     It renders BELOW the recovery rows ("one compact transient line below
//     critical recovery" — brief §3.1). Presentation grouping NEVER merges or
//     deletes store records.
//   - Recovery rows (uncertain/conflict/rejected/blocked/unsaved + the
//     create-link group) stay FULL rows — the compact line is happy-path
//     only. They render SEVERITY-ordered (brief §3.4 ladder, documented here
//     because the decision doc names the tiers but not their order):
//       conflict (0) > uncertain (1) > unsaved (2) > blocked/rejected (3)
//     Within a tier the order is IMMUTABLE IDENTITY (attemptId), never
//     updatedAt — a retry patch must not reshuffle rows under an operator's
//     focus. The blocked/rejected tier is capped at SECONDARY_CAP initially
//     visible rows with an inline "Show N more notices" disclosure (critical
//     tiers are NEVER capped — "critical summaries never hidden by cap").
//   - Create-link candidates: CANDIDATE_CAP visible, remainder behind
//     "Show all N possible sessions" (vertically stacked ~44px targets —
//     closes the F5 narrow-viewport row-width drop).
//   - The uncertain retry-same payload preview gains bounded full-text
//     expansion: collapsed = the 80-char compact preview; "Show full message"
//     expands the verbatim stored text + all retained filenames INLINE in the
//     row (no new surface).
//
// ARIA (slice 2): the container is NO LONGER a live region (row controls and
// expandable details must not sit inside one). A single dedicated visually
// hidden announcer span (aria-live="polite") mirrors the PRIMARY texts only —
// compact line + visible recovery primary lines + the more-notices count.
// It changes only on stage/severity transitions and materially changed
// counts, so one state-transition batch yields ONE polite announcement, not
// one per record; upload ordinals are discrete per-file completions (the
// ordinal accessor, not a per-tick progress fraction); expanded payloads and
// row controls never enter the mirror.
//
// Copy contract (normative, decision doc §1.3 matrix — unchanged by slice 2):
//   preparing (uploads in flight) → "Uploading 1 of 2…"
//   preparing / admitting          → "Sending…"
//   admitting, reused attemptId    → "Retrying queue confirmation…"
//   admission response lost        → "Queue confirmation unknown." + "Check
//                                    the queue, or retry this same message."
//                                    + the guarded record-addressed Retry
//   session-create unknown         → "Session creation unconfirmed. Check
//                                    possible sessions before sending again;
//                                    another send may create another session."
//   other ambiguity                → "Outcome unknown — check before sending
//                                    again." — NO unqualified Retry button
//   definitive rejection           → reason-specific ("Not queued — queue is
//                                    full. Remove a queued message before
//                                    trying again." / "Not sent — attachments
//                                    are still uploading." / "Not sent —
//                                    attachment upload was not confirmed.
//                                    Review the attachment controls before
//                                    trying again." / "Not sent — choose an
//                                    agent." / "Session could not be
//                                    created."); untyped fallback "Not sent —
//                                    kept in the composer."
//   conflict                       → "Queue status conflict — check the
//                                    queue." (both flavors; no Refresh action
//                                    that does not exist)
//   resolve write failed           → "Message sent — status save
//                                    unconfirmed." / "Send failed — status
//                                    save unconfirmed." / "Send outcome
//                                    unknown — status save unconfirmed." +
//                                    Retry STATUS SAVE (a record, never a
//                                    resend — "Does not resend the message.")
//
// Create-certainty Slice 2 additions (the modern /vh/session/create client):
//   create-unknown + recovery running → "Checking session creation." (the
//                                    budget's lookups are reads; the
//                                    unconfirmed copy returns on exhaustion)
//   create-unknown + modern op       → "Check again" (a fresh bounded LOOKUP
//                                    budget — never a create) and the
//                                    TWO-STEP "Start a new session anyway"
//                                    duplicate-risk acknowledgement
//   capability check uncertain       → "Could not reach the server to create
//                                    the session. Check the connection and
//                                    try again." (NO POST was sent — retry
//                                    is safe; never the duplicate-risk copy)
//   create resolved via receipt      → "Session was created — this message
//                                    was not sent." (session found ≠ message
//                                    sent) + the draft view's resolved row
//                                    ("Session was created." + operator-
//                                    driven "Open it")
//
// Ownership (decision doc §1.2): NO server-custody sentence here — the queue
// container/QueueChip owns server custody, ConnectionToast owns transport.
// SendStatus never calls browser uncertainty "queued".
//
// Honesty invariants: a retry affordance that replays a verbatim attempt
// payload SURFACES what it will send (text + file names, including chips
// removed after the attempt); "Retry same message" stays RECORD-ADDRESSED
// (the row button carries its attemptId — O2 slice-1 review A-F1).
//
// CSS: co-located SendStatus.css — a PLAIN stylesheet imported for side
// effects (NOT a css module: pure-:global modules with no used locals are
// tree-shaken from the production bundle — slice-2 review C-F1). Classes are
// applied as LITERAL strings here (test-queried classes stay globally named
// per the repo CSS-arch rule; the sendStatus* prefix keeps the global
// namespace collision-free). No mask/backdrop-filter/contain
// (Firefox/WebRender GPU rules — this is an always-possible composer surface;
// keep it cheap flat DOM).
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import {
  createLinkCandidates,
  finishSendAttempt,
  markSendAttemptResolveConflict,
  sendActionsFor,
  transferOwnerSendAttempts,
  type CreateLinkCandidate,
  type SendAction,
} from "../../lib/sendActionStatus";
import {
  abandonCreateOp,
  checkCreateOpAgain,
  draftResolvedCreateOp,
  getCreateOp,
  isCurrentCreateOp,
} from "../../lib/sessionCreateStatus";
import { resolveQueued } from "../../queue";
import type { Session } from "../../types";
import "./SendStatus.css";

export interface SendStatusProps {
  // Live session id ("" for a draft).
  sessionId: Accessor<string>;
  draft: Accessor<boolean>;
  // Record-addressed guarded retry of an uncertain admission (O2 slice-1
  // review A-F1). In production ChatView/Composer wire createSend's GUARDED
  // entry (retrySameMessage) here — never a direct enqueue bypass — and the
  // row button invokes it WITH the displayed record's attemptId. The
  // controller revalidates THAT exact record at click time (exists, still
  // stage uncertain + recovery retry-same, owned by the current ownerKey)
  // and replays ITS stored verbatim payload under ITS attemptId, leaving the
  // composer untouched; a gone/finished record refuses loudly. Minimal unit
  // harnesses may pass a plain send fn — the argument is ignored there.
  send: (attemptId: string) => Promise<void>;
  // Ordinal upload progress (createAttachments.uploadProgress) for the
  // "Uploading 1 of 2…" copy; null when idle. Attributed to the single
  // active record only — never merged across records (no false denominator).
  uploadProgress: Accessor<{ done: number; total: number } | null>;
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

// Compact "Same message:" preview bound. The collapsed form is the existing
// 80-char clip; "Show full message" appears only when the clip actually
// truncated something (bounded expansion).
const PREVIEW_CLIP = 80;
// Blocked/rejected rows initially visible before the "Show N more notices"
// disclosure (brief §3.4: "Initially show at most two blocked/rejected
// rows"). Critical tiers (conflict/uncertain/unsaved + create-link) are
// NEVER capped.
const SECONDARY_CAP = 2;
// Create-link candidate buttons initially visible before "Show all N
// possible sessions" (brief §3.5: "Show two newest candidates initially").
const CANDIDATE_CAP = 2;

// Severity ladder for row ordering (brief §3.4): conflict first; create/
// admission/other unknown next; status-save unconfirmed next; then blocked/
// rejected. Actions-required before informational; transient summary is not
// a row at all (it is the compact line, rendered below recovery).
const SECONDARY_RANK = 3;
function severityRank(stage: SendAction["stage"]): number {
  switch (stage) {
    case "conflict":
      return 0;
    case "uncertain":
      return 1;
    case "unsaved":
      return 2;
    case "rejected":
    case "blocked":
      return SECONDARY_RANK;
    default:
      return 4; // preparing/admitting never appear in the recovery list
  }
}

function isRecoveryStage(stage: SendAction["stage"]): boolean {
  return (
    stage === "uncertain" ||
    stage === "conflict" ||
    stage === "rejected" ||
    stage === "blocked" ||
    stage === "unsaved"
  );
}

export function SendStatus(props: SendStatusProps) {
  const ownerKey = () => (props.draft() ? "draft" : props.sessionId());
  // Memoized (Solid discipline / brief §7): the merged-line and ordering
  // computations below share ONE reactive derivation per store change instead
  // of re-running per render; presentation grouping never mutates the store.
  const records = createMemo(() => sendActionsFor(ownerKey()));

  // Create-certainty Slice 2 — the draft view's RESOLVED create operation
  // (certainty upgrade, no operator confirmation needed to RESOLVE — the row
  // only offers the operator-driven navigation; recovery never hijacks
  // navigation itself). Declared BEFORE its consumers (announcerText/JSX)
  // because memos evaluate eagerly at creation.
  const draftResolved = createMemo(() => (props.draft() && props.openSession ? draftResolvedCreateOp() : undefined));

  const transientRecs = createMemo(() =>
    records().filter((r) => r.stage === "preparing" || r.stage === "admitting"),
  );
  const recoveryRecs = createMemo(() => records().filter((r) => isRecoveryStage(r.stage)));

  // Severity-ordered recovery rows; within a tier, IMMUTABLE IDENTITY order
  // (attemptId) — never updatedAt, so retry patches do not reshuffle rows
  // under an operator's focus (brief §3.4).
  const orderedRecovery = createMemo(() =>
    [...recoveryRecs()].sort(
      (a, b) =>
        severityRank(a.stage) - severityRank(b.stage) ||
        (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0),
    ),
  );

  // Secondary-tier (blocked/rejected) stacking cap: the first SECONDARY_CAP
  // secondary rows render; the rest wait behind an inline disclosure.
  // Disclosure REVEALS rows — it never resolves or deletes them.
  const [noticesExpanded, setNoticesExpanded] = createSignal(false);
  const visibleRecovery = createMemo(() => {
    if (noticesExpanded()) return orderedRecovery();
    let secondary = 0;
    return orderedRecovery().filter((r) => {
      if (severityRank(r.stage) === SECONDARY_RANK) {
        if (secondary >= SECONDARY_CAP) return false;
        secondary++;
      }
      return true;
    });
  });
  const hiddenNotices = createMemo(() => orderedRecovery().length - visibleRecovery().length);

  // The compact merged happy-path line (ONE line, happy path only — recovery
  // facts keep full rows). Multi-record copy per the decision-doc matrix:
  // "N send actions in progress…" — the count means ACTION RECORDS, never
  // attachments, and never a merged upload denominator.
  const mergedLine = createMemo<string | null>(() => {
    const ts = transientRecs();
    if (ts.length === 0) return null;
    if (ts.length === 1) return lineFor(ts[0]);
    return `${ts.length} send actions in progress…`;
  });

  // Per-stage primary copy (decision-doc §1.3 matrix — normative). Returned
  // null means "nothing to render for this record" (admitted never appears —
  // the record is finished on confirmation). Shared by the recovery rows and
  // the single-record merged line.
  function lineFor(rec: SendAction): string | null {
    switch (rec.stage) {
      case "preparing": {
        const p = props.uploadProgress();
        // Display semantics: `done` counts COMPLETED uploads, so the shown
        // index counts the file IN PROGRESS (done + 1), capped at total so
        // the last file never reads "N+1 of N".
        if (p && p.total > 0) return `Uploading ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
        return "Sending…";
      }
      case "admitting":
        return rec.retry ? "Retrying queue confirmation…" : "Sending…";
      case "uncertain":
        // Admission-response loss (recovery "retry-same") gets the dedicated
        // copy + affordance; the create-unknown shape (typed reason, set by
        // markOwnerSessionCreateUnknown) carries the duplicate-session
        // warning the suppressed notification used to own; every other
        // uncertainty is check-before-sending — never a blanket Retry.
        if (rec.recovery === "retry-same") return "Queue confirmation unknown.";
        if (rec.reason === "session-create-unknown") {
          // Create-certainty Slice 2: while the modern receipt-recovery
          // budget is RUNNING, the primary line names what is happening
          // (brief §3.3 "Checking session creation.") — the unconfirmed copy
          // + its affordances return when the budget exhausts.
          const op = getCreateOp(rec.createOpId);
          if (op && op.recoveryActive) return "Checking session creation.";
          return "Session creation unconfirmed. Check possible sessions before sending again; another send may create another session.";
        }
        return "Outcome unknown — check before sending again.";
      case "conflict":
        // O2 §3.6: both conflict flavors converge on the actionable guidance
        // — check the queue. (conflictSource stays recorded on the action for
        // diagnostics, but "showing server state" made an implausible claim
        // about what the surface did; no Refresh action exists to offer.)
        return "Queue status conflict — check the queue.";
      case "rejected":
      case "blocked":
        // Reason-specific copy (O2 §3.6): the covered notification is
        // suppressed ONLY because its unique reason/advice is readable here.
        // Untyped records (legacy/test-seeded) keep the generic fallback.
        switch (rec.reason) {
          case "queue-full":
            return "Not queued — queue is full. Remove a queued message before trying again.";
          case "attachments-uploading":
            return "Not sent — attachments are still uploading.";
          case "attachments-failed":
            return "Not sent — attachment upload was not confirmed. Review the attachment controls before trying again.";
          case "agent-unresolved":
            return "Not sent — choose an agent.";
          case "session-create-failed":
            return "Session could not be created.";
          // Create-certainty Slice 2: NO create POST was sent (capability
          // check uncertain) — retry is SAFE; never the duplicate-risk copy.
          case "capability-unavailable":
            return "Could not reach the server to create the session. Check the connection and try again.";
          // Create-certainty Slice 2 (certainty upgrade): the create resolved
          // via an exact receipt — "session found" is NOT "message sent".
          case "session-create-resolved":
            return "Session was created — this message was not sent.";
          default:
            return "Not sent — kept in the composer.";
        }
      case "unsaved":
        // Save precision (O2 §3.6): name the KNOWN terminal outcome — the
        // dispatch already produced it; only the status SAVE is unconfirmed.
        switch (rec.retrySave?.state) {
          case "sent":
            return "Message sent — status save unconfirmed.";
          case "failed":
            return "Send failed — status save unconfirmed.";
          default:
            return "Send outcome unknown — status save unconfirmed.";
        }
      default:
        return null;
    }
  }

  // ONE polite announcer (slice 2): mirrors the visible PRIMARY texts only —
  // compact line + visible recovery primary lines + the hidden-notices count.
  // Payload previews, expanded full text, and controls never enter it, so a
  // state-transition batch announces ONCE (batching by construction: the
  // mirror string changes only when the summarized state changes).
  const announcerText = createMemo(() => {
    const parts: string[] = [];
    const ml = mergedLine();
    if (ml) parts.push(ml);
    for (const r of visibleRecovery()) {
      const l = lineFor(r);
      if (l) parts.push(l);
    }
    if (hiddenNotices() > 0) parts.push(`Show ${hiddenNotices()} more notices`);
    // Create-certainty Slice 2: the resolved-create row's primary mirrors too
    // (it is a visible primary line, not a control).
    const resolved = draftResolved();
    if (resolved) parts.push("Session was created.");
    return parts.join(" ");
  });

  const [saveBusy, setSaveBusy] = createSignal<string | null>(null);

  // Create-certainty Slice 2 — the modern unknown-create affordances. The
  // "Start a new session anyway" acknowledgement is TWO-STEP inline (the
  // first tap reveals the duplicate-risk wording + the confirm control; the
  // fresh key is only minted after the explicit confirm). Keyed by op id so
  // sibling rows never share an ack state.
  const [ackOp, setAckOp] = createSignal<string | null>(null);

  // Bounded full-text payload expansion (per-record; the collapsed form stays
  // the compact preview). Keyed by attemptId so a row's expansion survives
  // sibling reordering without remounting.
  const [fullShown, setFullShown] = createSignal<ReadonlySet<string>>(new Set());
  function toggleFull(attemptId: string) {
    setFullShown((prev) => {
      const next = new Set(prev);
      if (next.has(attemptId)) next.delete(attemptId);
      else next.add(attemptId);
      return next;
    });
  }
  const payloadText = (rec: SendAction) => rec.payload?.text ?? rec.payload?.tapText ?? "";

  // A1 create-linkage: candidate sessions for the draft's create-outcome-
  // unknown record(s) — reactive over BOTH the record store (records()) and
  // the session map (props.sessions(): the SSE-delivered session lands there
  // while the draft view is still mounted, no re-tap needed). Draft-view only:
  // a live session's ownerKey is its own id and can never be "draft".
  const createCandidates = createMemo(() => {
    if (!props.draft() || !props.sessions || !props.openSession) return [];
    return createLinkCandidates(Object.values(props.sessions()), records());
  });

  // Candidate grouping (slice 2, F5): the newest CANDIDATE_CAP candidates
  // render as stacked full-width targets; the remainder sit behind an inline
  // "Show all N possible sessions" disclosure (never a horizontal ribbon).
  const [candidatesExpanded, setCandidatesExpanded] = createSignal(false);
  const visibleCandidates = createMemo(() =>
    candidatesExpanded() ? createCandidates() : createCandidates().slice(0, CANDIDATE_CAP),
  );
  const hiddenCandidates = createMemo(() =>
    candidatesExpanded() ? 0 : Math.max(0, createCandidates().length - CANDIDATE_CAP),
  );

  // A1 confirm — NEVER silent: the re-key runs only from the operator's click
  // on the affordance. The sweep drains EVERY still-draft-owned record (the
  // study's C2 ride-along: a stale earlier record follows too instead of
  // stranding under "draft"), then navigation runs (openSessionChat
  // semantics via props).
  function confirmCreateLink(id: string) {
    transferOwnerSendAttempts("draft", id);
    props.openSession!(id);
  }

  // Candidate label: carries the created clock time (the correlation signal)
  // and a SHORT session id (candidate distinguishability — the full
  // identifier stays in the button's data-tip); the title only when it is
  // not the generic create-time default ("New session" — every fresh create
  // is titled that, so it identifies nothing).
  function candidateLabel(c: CreateLinkCandidate): string {
    const t = new Date(c.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const id = clip(c.id, 12);
    const title = c.title?.trim() ?? "";
    const generic = title === "" || title === "New session";
    return generic ? `it (${t}, ${id})` : `“${clip(title, 24)}” (${t}, ${id})`;
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

  return (
    <Show when={records().length > 0 || draftResolved() !== undefined}>
      <div class="sendStatus" data-testid="send-status">
        {/* ONE dedicated polite announcer (the container itself is NOT a live
            region — controls and expandable details sit outside live
            regions). Mirror of primary texts only; see announcerText. */}
        <span class="sendStatusAnnouncer" aria-live="polite" data-testid="send-status-announcer">
          {announcerText()}
        </span>
        <For each={visibleRecovery()}>
          {(rec) => {
            const line = () => lineFor(rec);
            return (
              <Show when={line()}>
                <div class="sendStatusLine" data-kind={rec.stage} data-tip={rec.detail || undefined}>
                  <span class="sendStatusText">{line()}</span>
                  {/* Retry-same affordance — ONLY for an uncertain ENQUEUE
                      outcome whose replay is deduped server-side (recovery
                      "retry-same"). O2 §3.6 copy: the guidance sentence names
                      the two honest options (check the queue, or the guarded
                      same-message retry), the preview says "Same message:"
                      (never a bare "Retry" — it names WHAT will be sent: the
                      verbatim payload text + files, including chips removed
                      after the attempt). Attachment-only payloads show the
                      file list without an empty text quote. RECORD-ADDRESSED
                      (O2 review A-F1): the button carries THIS row's
                      attemptId — the controller replays exactly the record
                      the operator clicked, regardless of composer text.
                      Slice 2: the preview gains BOUNDED full-text expansion —
                      collapsed is the 80-char compact clip; "Show full
                      message" (only when the clip truncated) expands the
                      verbatim stored text + all retained filenames inline. */}
                  <Show when={rec.stage === "uncertain" && rec.recovery === "retry-same"}>
                    <span class="sendStatusPayload">
                      Check the queue, or retry this same message.
                    </span>
                    <span class="sendStatusPayload">
                      Same message:{" "}
                      <Show when={payloadText(rec).length > 0}>
                        “{clip(payloadText(rec), PREVIEW_CLIP)}”{" "}
                      </Show>
                      <Show when={(rec.payload?.files?.length ?? 0) > 0}>
                        {" "}+ {rec.payload!.files!.join(", ")}
                      </Show>
                    </span>
                    <Show when={payloadText(rec).length > PREVIEW_CLIP}>
                      <button
                        type="button"
                        class="sendStatusMore"
                        aria-expanded={fullShown().has(rec.attemptId)}
                        onClick={() => toggleFull(rec.attemptId)}
                      >
                        {fullShown().has(rec.attemptId) ? "Hide full message" : "Show full message"}
                      </button>
                    </Show>
                    <Show when={fullShown().has(rec.attemptId)}>
                      <span class="sendStatusFull">
                        {payloadText(rec)}
                        <Show when={(rec.payload?.files?.length ?? 0) > 0}>
                          {" + "}
                          {rec.payload!.files!.join(", ")}
                        </Show>
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="sendStatusBtn"
                      data-tip="Re-queues the same message under the same attempt id — no duplicate if the first one landed"
                      onClick={() => void props.send(rec.attemptId)}
                    >
                      Retry same message
                    </button>
                  </Show>
                  {/* Create-certainty Slice 2 — the MODERN unknown-create
                      affordances (only for this record's CURRENT create
                      operation, only while no recovery budget is running).
                      "Check again" re-runs a FRESH bounded receipt-lookup
                      budget — a READ, never a create and never a resend.
                      "Start a new session anyway" is the brief's explicit
                      duplicate-risk acknowledgement: two-step inline confirm,
                      and only the confirm abandons the operation (a fresh key
                      is minted by the NEXT send). Legacy records (no
                      createOpId) and old-generation operations keep the
                      honest copy with no fresh affordances. */}
                  <Show
                    when={
                      rec.stage === "uncertain" &&
                      rec.reason === "session-create-unknown" &&
                      rec.createOpId &&
                      isCurrentCreateOp(rec.createOpId) &&
                      !getCreateOp(rec.createOpId)?.recoveryActive
                    }
                  >
                    <button
                      type="button"
                      class="sendStatusBtn"
                      data-tip="Re-checks the server for this send's session-creation receipt — never creates a session"
                      onClick={() => checkCreateOpAgain(rec.createOpId!)}
                    >
                      Check again
                    </button>
                    <Show
                      when={ackOp() !== rec.createOpId}
                      fallback={
                        <>
                          <span class="sendStatusPayload">
                            That attempt may still have created a session — creating another one may duplicate it.
                          </span>
                          <button
                            type="button"
                            class="sendStatusBtn"
                            data-tip="Abandons the unresolved attempt and creates a fresh session on your next send"
                            onClick={() => {
                              abandonCreateOp(rec.createOpId!);
                              setAckOp(null);
                            }}
                          >
                            Create new session anyway
                          </button>
                          <button type="button" class="sendStatusMore" onClick={() => setAckOp(null)}>
                            Keep checking
                          </button>
                        </>
                      }
                    >
                      <button type="button" class="sendStatusMore" onClick={() => setAckOp(rec.createOpId!)}>
                        Start a new session anyway
                      </button>
                    </Show>
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
                      data-tip="Re-records the outcome on the queue — does not resend the message"
                      onClick={() => void retrySave(rec)}
                    >
                      {saveBusy() === rec.attemptId ? "Saving status…" : "Retry status save"}
                    </button>
                  </Show>
                  {/* Dismiss — retained non-transient records only (the
                      compact transient line is the live send's own progress;
                      clearing it mid-flight would lie). */}
                  <Show when={isRecoveryStage(rec.stage)}>
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
        {/* Secondary-tier stacking cap disclosure (slice 2): reveals the
            capped blocked/rejected rows inline — never resolves or deletes
            them. Expand-only (collapsing recovered notices buys nothing and
            costs a control). */}
        <Show when={hiddenNotices() > 0}>
          <button type="button" class="sendStatusMore" onClick={() => setNoticesExpanded(true)}>
            Show {hiddenNotices()} more notices
          </button>
        </Show>
        {/* A1 create-linkage (send-defers study): the draft's
            create-outcome-unknown record + a session that appeared inside the
            create-attempt window → an operator-CONFIRMED linkage affordance.
            Timing is the ONLY correlation signal (the create POST carries no
            client id), so nothing re-keys without this click; dismissing the
            uncertain row above (the ×) removes the affordance with it. O2
            slice 2 grouping: header + adjacent all-remaining-records
            explanation + the newest CANDIDATE_CAP candidates as stacked
            full-width ~44px targets (no horizontal ribbon); the rest behind
            "Show all N possible sessions". "Link and open" (never a bare
            "Open") names the re-key + navigation it performs. */}
        <Show when={createCandidates().length > 0}>
          <div
            class="sendStatusLine"
            data-kind="create-link"
            data-tip="A session was created while your send's session-create was in flight — timing is the only match signal. Confirming moves this status there and opens it."
          >
            <span class="sendStatusText">Possible sessions — timing is the only match.</span>
            <span class="sendStatusPayload">
              Confirming moves this draft&rsquo;s remaining send statuses to that session, then opens it.
            </span>
            <div class="sendStatusCandidates">
              <For each={visibleCandidates()}>
                {(c) => (
                  <button
                    type="button"
                    class="sendStatusBtn sendStatusCandidate"
                    data-session-id={c.id}
                    data-tip={c.id}
                    onClick={() => confirmCreateLink(c.id)}
                  >
                    Link and open {candidateLabel(c)}
                  </button>
                )}
              </For>
              <Show when={hiddenCandidates() > 0}>
                <button type="button" class="sendStatusMore" onClick={() => setCandidatesExpanded(true)}>
                  Show all {createCandidates().length} possible sessions
                </button>
              </Show>
            </div>
          </div>
        </Show>
        {/* Create-certainty Slice 2 — the CERTAINTY-UPGRADE row: this draft's
            create operation resolved via an exact receipt (recovery or a
            re-tap's lookup), so its records already followed the session
            (operation-scoped, no operator confirmation). What remains in the
            draft view is the pointer: the session exists and is linked —
            navigation stays operator-driven ("Open it"); recovery never
            hijacks it. Timing candidates for this operation are hidden by
            construction (its records left the draft owner). */}
        <Show when={draftResolved()}>
          <div
            class="sendStatusLine"
            data-kind="create-resolved"
            data-tip="The session-creation receipt was found — this draft's send statuses moved to that session."
          >
            <span class="sendStatusText">Session was created.</span>
            <span class="sendStatusPayload">
              The unconfirmed send&rsquo;s session was found — its statuses moved there.
            </span>
            <button
              type="button"
              class="sendStatusBtn"
              data-tip={draftResolved()!.sessionId}
              onClick={() => props.openSession!(draftResolved()!.sessionId)}
            >
              Open it
            </button>
          </div>
        </Show>
        {/* The compact merged happy-path line — BELOW critical recovery (one
            calm line; happy path only). */}
        <Show when={mergedLine()}>
          <div class="sendStatusLine" data-kind="progress">
            <span class="sendStatusText">{mergedLine()}</span>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export default SendStatus;
