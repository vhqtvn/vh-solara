# OpenCode v1.17.18 — caller-minted messageID + exact message lookup (queue reconciliation authority)

> Source packet. Read-only source study of `sst/opencode` tag **v1.17.18** — the
> validated version pinned in `pkg/opencode/db.go:50`
> (`opencodeValidatedTag = "opencode v1.17.18"`). No vh-solara or OpenCode code
> was executed; every path/behavior claim is cited to upstream source at the
> exact tag.
>
> SCOPE: this packet records the byte-exact upstream facts that make
> vh-solara's queue → OpenCode reconciliation correct. The vh-solara Go
> implementation already encodes these facts faithfully
> (`pkg/opencode/id.go` `MintMessageID`, `pkg/opencode/client.go:366-414`
> `Message` + `ErrMessageNotFound`); this packet is the upstream source-of-truth
> that backs them, so a future OpenCode version bump has one place to re-check.
>
> Related: `researches/sources/opencode-unarchive-patch-audit.md` and
> `researches/sources/opencode-sqlite-unarchive-spec.md` (the direct-DB unarchive
> coupling, same validated tag).

---

## Mission recap / source policy

- **Primary**: `sst/opencode` GitHub, tag `v1.17.18` (and `master` for drift).
  CODE is authoritative. All quotes carry file path + tag permalink.
- Did NOT run vh-solara or OpenCode. Scratch only under `tmp/agent-runs/`.
- The vh-solara consumer code is cited where it already implements a fact, so the
  packet doubles as a coupling trail (upstream fact → Go consumer).

---

## 1. MessageID format (the correlation id)

### 1a. Branded, ascending, caller-replicable

`MessageID` = `msg`-prefixed branded identifier, minted via
`Identifier.ascending("message")`.

`packages/opencode/src/session/schema.ts` (v1.17.18)
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/session/schema.ts

`packages/opencode/src/id/id.ts` (v1.17.18)
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/id/id.ts

`Identifier.ascending` mints IDs whose string ordering matches chronological
ordering — the property OpenCode's `latest()` / pagination rely on. Byte layout
(EXACT):

```
"msg_" + hex(6 bytes) + base62(14)
```

- **`msg_`** — the brand prefix for `Identifier.ascending("message")`.
- **12 lowercase hex chars** — the 6-byte big-endian encoding of the low 48 bits
  of `now = unixMilli * 0x1000 + counter`, where `counter` resets to 0 when the
  millisecond advances then increments to 1 on the first mint within that ms.
  Monotonically non-decreasing with wall-clock time within a 2^48 `now` window,
  so lexicographic string order == chronological order.
- **14 base62 chars** — random suffix (charset `0-9A-Za-z`), carries no ordering
  information. Total suffix length after `msg_` is **26**.

**Caller mint MUST replicate the ascending format byte-for-byte** for sort
correctness: a caller-minted ID interleaves with real OpenCode IDs under
OpenCode's string-based ordering, so it sorts as if OpenCode minted it. vh-solara
replicates it in `pkg/opencode/id.go` (`MintMessageID`, with a per-process
monotonic counter mirroring id.ts's module-level lastTimestamp/counter, guarded
by `mintMu`). **Fresh per claim, never reused, never derived from text, never
regenerated after a timeout.**

### 1b. No collision with other identifier spaces

- The queue item's own id (`q-` + 16 hex, minted by `pkg/web/queue.go`
  `newQueueID`) **cannot collide** with any OpenCode identifier: OpenCode IDs are
  branded (`msg_`, `ses_`, `prt_`, …) and never use the `q-` prefix.
- `OriginClientID` on the queue item is **diagnostics-only** (per the
  `QueueItem` doc comment in `pkg/web/queue.go`): it MUST NOT affect ordering,
  visibility, dispatch eligibility, or any OpenCode-transcript identity. It is not
  a transcript identity at all — the transcript correlation is solely
  `OpencodeMsgID` (the `msg_…` value).

---

## 2. prompt_async body: caller-id-wins, NO remint

`POST /session/:id/prompt_async` accepts an optional **`messageID`** body key
(camelCase). Persistence is:

```
input.messageID ?? MessageID.ascending()
```

`packages/opencode/src/session/prompt.ts` (v1.17.18) — lines ~471, ~657, ~1501
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/session/prompt.ts

- A caller that supplies a correctly-formatted `msg_…` ID gets that **EXACT** ID
  back on the persisted user message — OpenCode does **not** remint. This is the
  foundation of vh-solara's correlation: the queue mints `OpencodeMsgID` at
  Claim (`pkg/web/queue.go` `Claim`), threads it into `prompt_async`'s
  `messageID` field at dispatch, and later looks it up by exact ID. (The mint
  moved from Enqueue to Claim in commit 3f696865 to fix a silent-loss defect
  where an enqueue-time id could sort before intervening messages under
  OpenCode's string ordering; see `pkg/web/queue.go` `Claim`'s doc comment.)
- Omitting the field is safe (OpenCode mints one), but supplying it is what
  enables exact-match reconciliation. The field is **optional** — its presence
  never causes a request to be rejected on format grounds as long as the value is
  a valid `msg_…` ID.

`packages/opencode/src/session/message-v2.ts` (v1.17.18)
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/session/message-v2.ts

---

## 3. GET exact message lookup (the reconciliation primitive)

`GET /session/:sessionID/message/:messageID` exists.

`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (v1.17.18)
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts

`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (v1.17.18)
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts

- **Composite key** `id AND session_id` → **session isolation is guaranteed**. A
  message id is only ever matched within its owning session; a cross-session
  lookup cannot accidentally resolve.
- **Success (200)** → `{ info: { id, role, sessionID, time, … }, parts }`. The
  caller inspects `info.id` and `info.role`.
- **Miss (404)** — no persisted message for the `(sessionID, messageID)` pair.
- **Malformed / non-`msg` id (400)** — caller bug.
- **DB / transport defect (5xx)** — server-side fault, transient.

vh-solara consumer: `pkg/opencode/client.go` `Message(ctx, sessionID, messageID)`
builds `/session/<sid>/message/<mid>` and maps the HTTP classes distinctly
(`ErrMessageNotFound` sentinel on 404; `*Error{Status:…}` otherwise).

---

## 4. prompt_async persistence is ASYNC to the 204

`prompt_async` returns **204** with the turn forked via
`Effect.forkIn(scope, { startImmediately: true })`.

`packages/opencode/src/session/prompt.ts` (v1.17.18) — ~471, ~657, ~1501
https://github.com/sst/opencode/blob/v1.17.18/packages/opencode/src/session/prompt.ts

- The 204 means the turn was **accepted and forked**, NOT that the user message
  is already persisted. Persistence happens in the forked fiber, **asynchronous
  to the 204 response**.
- **Consequence for reconciliation:** a lookup immediately after enqueue-adjacent
  to the 204 may legitimately 404 even though the dispatch will succeed — the
  fiber has not yet persisted. Therefore reconcile ONLY at/after the stale-dispatch
  threshold (`staleDispatchThreshold`, 30s in `pkg/web/queue.go`), never in the
  enqueue/dispatch-adjacent window. vh-solara's reconciler paces lookups with an
  in-memory per-item throttle mirrored on that cadence (`reconcileLast`).

---

## 5. Exact-match authority (the only `sent` verdict)

Reconciliation matches on **`200 + info.role === "user" + info.id === minted`**.
Nothing weaker qualifies.

| HTTP outcome | Classification | Reconciler action |
|---|---|---|
| **200 + `role==="user"` + `id===minted`** | persisted user message confirmed | → **`sent`** |
| **404** (definitive not-persisted for that exact id) | fail-closed | record an attempt; a persistent 404 across the bounded budget → **TERMINAL**, never resend |
| **5xx / transport failure** | retryable | retry within the bounded budget |
| **400** (malformed / non-`msg` id) | caller bug | log; mark TERMINAL immediately (no retry) |

vh-solara consumer: `pkg/opencode/client.go:366-414` documents this exact
classification; the queue's `ReconcileAttempts` / `ReconcileTerminal` markers
(`pkg/web/queue.go`) are the persisted fail-closed state.

---

## 6. Fork-failure caveat (item #8 folded here)

A persistent 404 after the grace window is **NOT solely "never-enqueued."** It
can also be **"enqueued (the 204 returned) but the forked fiber died before
persisting"** — e.g. a bad agent/model configuration, or an unreadable file part
referenced by the prompt. Such a failure is re-emitted to the operator **only via
`Session.Event.Error`**, not via the prompt_async response (which already
returned 204).

Therefore:

- A persistent 404 is **terminal for that specific `msg_…` id**. It must NOT be
  treated as "the message was never sent, safe to resend" — under caller-id-wins,
  resending with the SAME id is meaningless (it already 404'd), and resending
  with a NEW id risks duplicating work if the fiber actually did persist late or
  the original POST reached OpenCode before the abort.
- **NEVER auto-resend.** Require operator- or event-driven re-enqueue (the
  operator dismisses the terminal item and re-composes, or acts on the
  `Session.Event.Error`). This is the same no-auto-retry stance the queue holds
  for the 12s dispatch-timeout `unknown` classification (`web/src/queueDrain.ts`):
  a POST that may have reached OpenCode is never blindly repeated.

vh-solara consumer: `pkg/opencode/client.go:366-414` (`ErrMessageNotFound` doc)
states this verbatim — "either never persisted, or the forked fiber died before
persisting" — and the reconciler treats a persistent 404 as TERMINAL.

This caveat lives HERE (the reconciliation evidence packet), NOT in
`docs/architecture/opencode-sqlite-unarchive.md`, which is the direct-DB unarchive
contract (a separate concern). No architecture cross-reference is required unless
a future unarchive change touches message persistence, which it does not.

---

## 7. CONFIDENCE + GAPS

| # | Finding | Confidence | Type | Basis |
|---|---|---|---|---|
| 1 | `MessageID` = `msg_` + 12 hex + 14 base62 via `Identifier.ascending("message")`; suffix length 26; caller must replicate for sort correctness | **high** | fact | id.ts + schema.ts @ v1.17.18; vh-solara `pkg/opencode/id.go` replicates byte-exact and is unit-tested (`id_test.go`) |
| 2 | `prompt_async` body key `messageID` (camelCase); persistence `input.messageID ?? MessageID.ascending()` → caller-id-wins, no remint | **high** | fact | prompt.ts:~471,~657,~1501 @ v1.17.18 |
| 3 | `GET /session/:sid/message/:mid` exists; composite key `id AND session_id`; 200 `{info,parts}` / 404 / 400 / 5xx | **high** | fact | handlers/session.ts + groups/session.ts @ v1.17.18; vh-solara `client.go` `Message` maps the classes |
| 4 | `prompt_async` returns 204 with `Effect.forkIn(scope,{startImmediately:true})`; persistence async to the 204 | **high** | fact | prompt.ts @ v1.17.18 |
| 5 | Exact-match authority: only `200 + role==="user" + id===minted` → `sent`; 404 fail-closed; 5xx/transport retryable; 400 log | **high** | fact/inference | client.go:366-414 + queue.go reconcile markers; the classification is vh-solara policy grounded in the upstream HTTP semantics |
| 6 | Persistent 404 can be fork-fiber-died (not only never-enqueued); terminal for that id; never auto-resend | **high** | inference (strong) | prompt_async 204-before-persist + caller-id-wins ⇒ resend-with-same-id meaningless, resend-with-new-id risks dup; `Session.Event.Error` is the re-emission channel |
| 7 | `q-` queue id cannot collide with any OpenCode identifier; `OriginClientID` is diagnostics-only, not a transcript identity | **high** | fact | OpenCode IDs are branded; queue.go `QueueItem` doc comment |

### Gaps / not verified
- Did not execute any request (read-only source study). The 404-after-grace-window
  ⇒ terminal policy rests on source semantics + caller-id-wins, not a live repro
  of a fork-fiber death.
- The exact line numbers in prompt.ts (~471/657/1501) are the cited upstream
  loci; minor drift across patch releases is possible, but the
  `input.messageID ?? MessageID.ascending()` semantics are stable across the
  1.17.x series.
- Whether a future OpenCode adds a remint-on-collision or rejects a caller
  `messageID` that fails a server-side uniqueness check was not separately
  audited; under v1.17.18 the caller value is persisted verbatim.

---

## Findings

- **(finding)**: source=sst/opencode v1.17.18 id.ts + schema.ts, confidence=high, type=fact — `MessageID` is `msg_`+12 hex+14 base62 via `Identifier.ascending("message")`; a caller-minted id must replicate this to sort correctly with real OpenCode ids.
- **(finding)**: source=sst/opencode v1.17.18 prompt.ts:~471,~657,~1501, confidence=high, type=fact — `prompt_async` accepts camelCase `messageID`; persistence is `input.messageID ?? MessageID.ascending()` (caller-id-wins, no remint); the field is optional and safe to include.
- **(finding)**: source=sst/opencode v1.17.18 handlers/session.ts + groups/session.ts, confidence=high, type=fact — `GET /session/:sid/message/:mid` uses composite key `id AND session_id` (session-isolated); 200/404/400/5xx semantics as classified.
- **(finding)**: source=sst/opencode v1.17.18 prompt.ts, confidence=high, type=fact — `prompt_async` returns 204 with `Effect.forkIn(scope,{startImmediately:true})`; persistence is async to the 204, so reconcile only at/after the stale-dispatch threshold.
- **(finding)**: source=vh-solara pkg/opencode/client.go:366-414 + pkg/web/queue.go reconcile markers, confidence=high, type=policy-grounded-in-fact — exact-match authority is `200 + role==="user" + id===minted` → `sent`; 404 fail-closed; 5xx/transport retryable; 400 log-and-terminal.
- **(finding)**: source=sst/opencode v1.17.18 prompt_async 204-before-persist + caller-id-wins, confidence=high, type=inference — a persistent 404 can mean the forked fiber died before persisting (not only never-enqueued); it is terminal for that id and must never trigger auto-resend; re-emission is via `Session.Event.Error`.
- **(finding)**: source=sst/opencode v1.17.18 id branding + pkg/web/queue.go, confidence=high, type=fact — `q-` queue ids cannot collide with OpenCode identifiers; `OriginClientID` is diagnostics-only, not a transcript identity.

## Contradictions
- **None detected** between the upstream v1.17.18 facts and the vh-solara
  consumer implementation (`pkg/opencode/id.go`, `pkg/opencode/client.go`). The
  Go code already documents and enforces every fact in this packet; the packet is
  the upstream backing trail, not a correction.

---

## Recommended next specialist / command

`planner` → `build` only if a future OpenCode version bump changes any fact in
§1–§4. On a bump: re-read the cited upstream files at the new tag, update the
`opencodeValidatedTag` pin in `pkg/opencode/db.go`, re-run the `id_test.go`
format/uniqueness/monotonic tests, and refresh this packet. This packet is the
evidence base for the reconciliation contract; it is **not** active repo policy.
