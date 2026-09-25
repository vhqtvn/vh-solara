# Send-State UX Design and Defers Study

*Date: 2026-09-25*
*Tree bound: `main` @ `61ca3a9` (as of 2026-09-22)*

This document captures the durable UX design contract for the sending state (action-row model, single-owner truthfulness, recovery flows), the deferred reliability findings study (A1/A2/C2), and the known longer-range open items. 

It is promoted from coordination session artifacts (`tmp/agent-runs/send-reliability-brief/brief.md`, `tmp/agent-runs/send-defers-study/report.md`, and `tmp/agent-runs/send-state-o2-design/brief.md`).

---

## Part 1: Sending-State UX Design Contract (O2)

### 1.1 Problem and Decision Frame

Refine the accepted action-row model, not its reliability architecture. `SendStatus` owns browser-action/admission/create uncertainty and status-save problems; `QueueChip` owns server custody/dispatch; the transcript contains confirmed messages only. Reduce composer-area noise without hiding ambiguity or weakening recovery.

**Decision:** O2-A, one compact transient summary plus severity-ordered recovery summaries. Keep create recovery within `SendStatus`, bound its candidate/detail expansion, remove the repeating send pulse, and eliminate covered send-status notifications after transferring their unique information into their persistent owner.

### 1.2 Surface Ownership

| Fact | Persistent owner | Other surfaces |
|---|---|---|
| Tap accepted locally / busy lock | Button immediate affordance, not ledger | SS owns progress text. |
| Upload/preparation/admission progress | One SS transient summary | Attachment chip identifies file/repair, not message outcome. |
| Admission/create uncertainty, rejection/conflict | SS recovery summaries | Covered notification removed; uncovered fallback retained. |
| Possible create session and operator linkage | Shared SS create-recovery group | No automatic navigation/transfer. |
| Server custody and dispatch outcome | QueueChip/queue container | No SS custody sentence. |
| Status persistence ambiguity | SS save-recovery row | Retry save never sends. |
| Confirmed conversation messages | Transcript, unchanged | No optimistic or ambient transcript additions. |
| Connection lifecycle | ConnectionToast | No admission/custody claim from transport alone. |
| Uncovered operation failure | Existing notification history | Retained until a deliberately equivalent owner exists. |

### 1.3 Action Status and Visible Recovery (Copy Matrix)

*Note: The mismatch explanation row (Composer changed) below is superseded by the shipped record-addressed refusal ("Retry unavailable — status changed") as of `61ca3a9`.*

| Situation / Before | After / exact rule / recovery |
|---|---|
| Preparing/uploading/admitting | “Uploading 1 of 2…” / “Sending…” with text. For multiple active records “N send actions in progress…”. |
| Server receipt received, connection later lost | Remove "Queued — waiting for connection" from SendStatus. Queue container/QueueChip owns custody. |
| Admission response lost | “Queue confirmation unknown. Check the queue, or retry this same message.” (Only when guarded retry is available). |
| Definitive rejection | Persistent failure with appropriate retry or restore-to-composer. |
| Ambiguous session/upload/message mutation | “Outcome unknown — check before sending again.” / “Session creation unconfirmed. Check possible sessions before sending again; another send may create another session.” |
| `Open …` candidate | `Link and open …`; adjacent explanation covers all remaining draft recovery records. |
| Unconditional retained-composer reassurance | `Your message is still in the composer.` only while ownership/content evidence supports it. |
| Resolve retries exhausted | `Message sent [or failed/unknown] — status save unconfirmed.` |
| `Retry send` | `Retry same message`, only for the exact controller-selected reuse record. |
| `Will send: [80-character preview]` | `Same message: [compact preview]` plus `Show full message`; expansion shows verbatim text and all retained filenames (full-text expansion renders ONLY when the 80-char clip actually truncated). |
| No mismatch explanation | *[Superseded]* Originally `Composer changed. This action cannot retry the saved message.` Superseded by shipped record-addressed refusal: "Retry unavailable — status changed". |
| `Queue state conflict — showing server state.` | `Queue status conflict — check the queue.` Do not introduce a Refresh action that does not exist. |
| Failed QueueChip cause only in tooltip | Preserve `Failed` label and expose cause/instructions inline or through an explicit details control. |

### 1.4 Slice Execution Status

- **Slice 1: Truthful ownership, reasons, and guarded recovery.** 
  **Status: LANDED (Commit `61ca3a9`).**
  *(Note: The custody-line removal from SendStatus described as pending in the original brief is DONE as of 61ca3a9.)*

- **Slice 2: Compact hierarchy, static acknowledgment, mobile observation seams.**
  **Status: LANDED (Commit `0ed1be4`).**
  Scope includes: compact merged status line, static tap-ack replacing infinite pulse, severity stacking cap +N more, create-link candidate grouping, full-text payload expansion.
  *(Note: The a11y restructure moved controls out of the live region; one visually-hidden memoized polite announcer mirrors primary texts + hidden-notices count. The code cites "brief §3.x" paths that no longer exist — this document now carries those shipped parameters; the code comments are self-contained.)*
  **Shipped Parameters (formerly brief §3.x):**
  - **Severity ladder order:** conflict > uncertain > unsaved > blocked/rejected; within-tier immutable attemptId order.
  - **Cap N=2 for blocked/rejected:** inline expand-only "Show N more notices" (critical tiers + create-link never capped).
  - **Create-link CANDIDATE_CAP=2:** newest-first with "Show all N possible sessions" expansion (44px stacked full-width targets, created-time + short-id labels, full id in tooltip).
  - **Multi-record progress copy:** "N send actions in progress…".

---

## Part 2: Send-Reliability Deferred Findings Study (A1/A2/C2)

*(Assessed against `main` @ `924ff9d`, prior to O2 Slice 1)*

### 2.1 A1/D1 — pure-navigation materialization residual
**Reachability verdict:** REACHABLE (Confirmed real in the code at the time).
The draft attempt can be stranded under "draft" permanently in-memory if a create POST loses its response and the operator navigates away without re-tapping.
**Recommendation:** Split the defer. The stranding half is fixed by a client-side confirmed-linkage affordance (part of O2). The duplicate-create half requires proxy-owned create receipts (see Part 3 Open Items).

### 2.2 A2 — sweep coverage for draft-owned conflict/unsaved records
**Verdict:** CORRECT that draft-owned conflict/unsaved records are UNREACHABLE today.
No path re-keys a record back to "draft", so no conflict/unsaved-stage record can be draft-owned at sweep time.
**Recommendation:** Add a unit test to lock the contract against future mint sites.

### 2.3 C2 — stale-record attach
**Severity:** Low (requires hung create + abandoned draft + later draft send).
**Recommendation:** Defer, riding the A1 stranding fix. The linkage affordance shrinks C2's practical exposure.

---

## Part 3: Open Items & Non-Goals (§8)

The following reliability architecture requirements remain explicitly unmet rather than quietly removed:

- **Durable session-create/upload true idempotency** (proxy create-receipts in `/oc`, modeled on `pkg/web` queue admission receipts).
- **Upstream dispatch dedupe/custody contract.**
- **Replayable claims / session ordering.**
- **Browser-reload outbox** for unconfirmed attempts.
- **Remaining non-guard fetch/body bounds.**
- **Dedicated hung-socket e2e fixture knob.**
- **Upload filename / overwrite safety.**
