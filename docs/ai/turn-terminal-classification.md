# Turn terminal classification (state layer)

How vh-solara classifies the terminal outcome of an opencode assistant turn,
and which surface owns each classification. Tight reference; the incident
history lives in `tmp/handoff-instant-abort-and-stale-ui.md` /
`tmp/handoff-instant-abort-round2.md` (P1 of the 2026-10-31 instant-abort
study).

## Taxonomy

| Outcome | Signals | Classified where | `isTerminalError` member | FE affordance |
|---|---|---|---|---|
| Normal completion | `finish: "stop"` etc., no error | adoption sites | n/a | — |
| Operator/limit abort | `error.name == "MessageAbortedError"` NOT matching the never-started signature | adoption sites | **yes** (upstream positive terminal) | red `.msg-error` box ("⚠ Aborted") |
| Never started (instant self-abort) | `MessageAbortedError` AND `completed − created ≤ 100 ms` AND zero parts AND zero tokens | refined at BOTH adoption sites into `VHSolaraNeverStartedError` | **yes** (refines an upstream-positive terminal) | quiet amber `.msg-never` notice |
| Interrupted (sweep inference) | uncompleted newest + two consecutive authoritative not-busy observations | `interrupted_sweep.go` marker | **no** (fabricates a terminal opencode never wrote — pure inference) | `.msg-error` box with sweep vocabulary |

Adoption sites (both must agree): `upsertMessageLocked`
(`reducers.go`, live `message.updated`) and `reconcileMessagesLocked`
(`hydration.go`, history fetch).

## Never-started (P1, `pkg/state/never_started.go`)

An opencode turn can be self-aborted 7–27 ms after the assistant row is
created — before the processor ran, before any part (not even `step-start`),
before the provider call. The only upstream writer of that exact row shape is
`finalizeInterruptedAssistant` (`refs/opencode .../session/prompt.ts`): a
silent fiber interruption finalizes the pre-seeded row with
`error.name=MessageAbortedError`, `data.message="Aborted"`, all-zero tokens.
Until P1 this rendered identically to a user Stop.

Classification rule (`neverStartedSignature`): ALL conjuncts required —
assistant role, `MessageAbortedError`, duration ≤ 100 ms
(`neverStartedMaxDurationMs`), zero parts (fetched ∪ resident on the
reconcile path), zero tokens (absent/unparseable counts as zero). Anything
missing a conjunct — including every real operator abort (the incident's
145 s control) — keeps the plain operator-abort meaning.

The refinement rewrites ONLY the `info.error` block:
`name=VHSolaraNeverStartedError`, `data.message` = the user vocabulary
(single source; the FE passes it through), `data.cause` = the upstream name.
Byte-stable merge (no warm-reconcile churn), with non-error fields passed
through verbatim (`json.RawMessage` decode — no numeric re-encoding).

### The abort-marker question (resolved: no durable marker; TurnStopping guard on both surfaces)

The ideal classifier would also know "vh-solara sent no `/vh/abort` for this
session". No cheap, reliable, durable marker exists:

- `/vh/abort` (`pkg/web/verbs.go`) and `abortInflightBeforeRestart`
  (`pkg/web/opencode.go`) → `Store.Stop`, which sets only TRANSIENT in-memory
  state (`turnState=TurnStopping` + `stopTurnID`) that settles via the settle
  timer / status reconcile and is rebuilt on hydrate — not a timestamped
  ledger a later classification can consult.
- `abortInflightBeforeRestart` writes nothing to the store (logs only).
- The restart fence (`pkg/web/restart_fence.go`) stamps QUEUE dispatch items —
  a different entity, only at restart time.

What is wired: BOTH adoption surfaces suppress the refinement while the
session is `TurnStopping` (`classifyNeverStartedLocked` — the one window
where "we just aborted this session" is observable under the lock we already
hold; a history fetch racing that window gets the same conservative
treatment). Suppress-only and best-effort by ordering: the terminal SSE event
can beat the Abort HTTP response that precedes `Store.Stop`, so the guard can
miss our own abort — the residual exposure is bounded by the signature itself
(every abort vh-solara issues targets turns that are seconds-to-minutes old,
which the ≤100 ms duration conjunct already excludes). Outside that window
and for historical rows (no durable marker survives reconnect/daemon
restart), the signature alone carries the classification.

Revocation is enforced across time, not just per-adoption: the raw
pre-refinement body is retained on the entry (`neverStartedRaw`), and a FIRST
part arriving after the refinement restores the raw upstream body,
re-classifies as the upstream name, and re-emits the message (suppressed on
the cold path, where the wholesale batch carries it). This is wired at ALL
THREE part-ingestion surfaces: the authoritative `part.upsert`
(`upsertPartLocked`), the streaming `part.delta` placeholder insert
(`appendPartDeltaLocked` — a delta can precede its part.updated), and the
history-fetch merge loop (`reconcileMessagesLocked` — where a cold load can
skip body adoption on a live-touched entry). A parts-bearing turn can never
keep the "turn never ran" presentation. A later body adoption that breaks the
signature also restores the raw shape. (One accepted gap, not an
impossibility: `MergeOlderMessages` builds older-history entries without the
classifier — the signature is the newest turn's shape when written, so it does
not reach the older-page path in practice; the consequence of a hypothetical
matching older page is only the pre-P1 presentation, and the next full
reconcile re-derives.)

## Why `VHSolaraNeverStartedError` is an `isTerminalError` member but `VHSolaraInterruptedError` is not

Provenance. The interrupted marker FABRICATES a terminal opencode never wrote;
admitting it as terminal would let pure inference satisfy the messages-loaded
gate. The never-started marker only REFINES a terminal opencode itself
positively wrote (`completed` + error) — the row's outputless emptiness
remains upstream truth, so first-reconcile admission must keep working
exactly as it did under the upstream name.

## Web UI

`neverStartedNotice` (`web/src/components/chat/messageMeta.ts`) selects the
`.msg-never` notice (quiet amber, dashed border, no ⚠ glyph — deliberately
not red, which reads as "your abort"); `MessageRow.tsx` renders it EITHER/OR
with `.msg-error`, never both. The vocabulary comes from Go's
`neverStartedUserMessage` via `error.data.message` (single source), with a
local FE literal fallback. CSS stays a global `.msg-*` class in
`web/src/styles/legacy/50-chat-overlays.css` per
`docs/ai/web-css-architecture.md` §8; no `mask-image` / `backdrop-filter` /
`contain` (chat-surface GPU constraints).
