# OpenCode latest — backward message cursor (`?before=<token>&limit=N`) (cold-load paging authority)

> Source packet. Read-only source study of the **deployed** OpenCode instance on
> `127.0.0.1:43889` (the operator's live source-of-truth) cross-checked against
> the upstream `sst/opencode` `refs/opencode` snapshot under `refs/` and the
> vh-solara consumer (`pkg/opencode/client.go`). A live **read-only probe** was
> run against the deployed instance to confirm the cursor API behavior; no
> vh-solara or OpenCode code was mutated, and the host opencode DB was opened
> strictly read-only (`file:…?mode=ro`).
>
> SCOPE: this packet records the upstream + deployed facts that make a backward
> (older-than-cursor) message-page fetch correct. It **corrects** a prior
> inference ("opencode REST has no backward cursor") that was wrong for the
> deployed/latest OpenCode. It is the evidence base for any future cold-load
> "past-resident older-page" work (Part B) and supersedes option (c) direct-SQLite
> paging as a design alternative.
>
> Related: `researches/sources/opencode-v1.17.18-messageid-exact-lookup.md`
> (the v1.17.18 messageID + exact-lookup authority — the prior validated tag).
>
> NOTE: Promoted from `tmp/agent-runs/` (probe + source study) to
> `researches/sources/opencode-latest-message-backward-cursor.md`.

---

## Mission recap / source policy

- **Primary**: the DEPLOYED OpenCode instance on `127.0.0.1:43889` (confirmed
  live, returns 200), corroborated by the `refs/opencode` source snapshot and the
  vh-solara consumer. The deployed instance is authoritative for "what the daemon
  can rely on now"; the source snapshot explains the mechanism.
- A **read-only probe** was run against the deployed instance (GETs only; the host
  opencode DB was opened strictly read-only via `file:…?mode=ro` to predict page
  contents). No mutations.
- Scratch kept under `tmp/agent-runs/`.
- OpenCode is a moving target — see §8 (drift handling). The durable evidence is
  the deployed-probe matrix + committed `file:line` citations, NOT floating
  `refs/opencode` "latest" links as the sole basis.

---

## 1. Cursor API (the headline)

`GET /session/:id/message?before=<cursor-token>&limit=N` returns the **N strictly-
older** messages relative to the cursor, in chronological order, plus paging
response headers:

- **`X-Next-Cursor`** — the cursor to fetch the NEXT older page (the oldest tuple
  of the returned slice).
- **`Link: <url>?limit=N&before=<cursor>; rel="next"`** — the same, as a
  ready-to-follow link.

**Cursor token format:**

```
base64url( JSON({ "id":"msg_…", "time":<time_created-unix-ms> }) )
```

- Keys are `id` then `time` (insertion order). **Unpadded** base64url (no `=`
  padding). `time` is the message's `time_created` as **Unix milliseconds**
  (numeric, NOT seconds — the same unix-ms unit the `message` table stores).
- The token encodes BOTH the id and the time so the page query can compare on the
  indexed `(time_created, id)` tuple without re-reading the row.

`MessageV2.page(cursor)` semantics (strictly-older, deterministic tiebreak):

- `older(cursor)` = rows where `time_created < cursor.time` **OR**
  (`time_created == cursor.time` **AND** `id < cursor.id`).
- Orders `time_created DESC, id DESC`, `LIMIT N+1`, then **reverses** the slice to
  chronological (oldest-first) for the response.
- The **next cursor** = the **oldest** row of the returned slice (NOT the newest).

Citations (`refs/opencode`, committed snapshot):

- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:179-190`
  (cursor decode + page entry)
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:106-145`
  (the `before` query param → `cursor.decode`; the `X-Next-Cursor` / `Link`
  response headers; `400 BadRequest` on a malformed cursor)
- `packages/opencode/src/session/message-v2.ts:63-78,95-96,425-467`
  (`MessageV2.page`, `older()`, the DESC/DESC + reverse-to-chronological shape,
  next-cursor = oldest tuple)

---

## 2. Deployed confirmation (the live probe)

The DEPLOYED OpenCode on `127.0.0.1:43889` supports the cursor API **now** — the
backing migration **`20260312043431_session_message_cursor`** (which adds the
`(session_id, time_created, id)` index the page query uses) has landed in this
instance. **No OpenCode upgrade is required** for vh-solara to consume it.

Probe matrix (read-only GETs; the host opencode DB was read in parallel under
`file:…?mode=ro` to predict page membership):

| Request | Status | Body | Headers | Match |
|---------|--------|------|---------|-------|
| `?limit=10` (no cursor) | 200 | newest-10, chronological | **no** `X-Next-Cursor` / `Link` (historical probe hit exhausted window) | body == DB newest-10 |
| `?before=<cursor>&limit=10` | 200 | 10 strictly-older msgs, chronological | **`X-Next-Cursor` + `Link` present** | body == DB predicted strictly-older-10 |
| `?before=<raw msg_ id>` (old probe) | **400** | BadRequest | — | raw id is NOT valid base64url-JSON → cursor.decode fails (see §3) |

- The returned strictly-older set **exactly matched** the DB prediction (same ids,
  same order) for the cursor case.
- `X-Next-Cursor` decodes (base64url → JSON) to **the oldest item of the returned
  page** — consistent with §1's "next cursor = oldest tuple" rule. Sending it as
  the next `?before=` pages one window further back.
- *Historical note (superseded)*: A prior deployed probe found the no-cursor baseline (`?limit=10`) returned the newest-10 and carried NO cursor headers. This occurred because that specific probe hit an **exhausted window** (total session messages ≤ limit).
- **Current contract:** A limited no-before tail fetch (`?limit=N`) **does** carry the `X-Next-Cursor` and `Link` response headers whenever there is more history beyond the requested limit (i.e. `rows.length > input.limit`). It is omitted only when the session is fully exhausted.

---

## 3. The 1.17.x contradiction — CORRECTION OF RECORD

Our prior inference — **"opencode REST has no backward cursor"** (recorded in
`tmp/agent-runs/delivery-proof/cold-load-overfetch.md` §Open Decision 1) — was
**WRONG for the deployed/latest OpenCode.** The backward cursor exists and is
deployed (§1–§2).

The root cause of the prior wrong inference: the earlier probe used a **raw
`msg_…` id** as the `?before` value, which 400'd. That 400 is **not** "the API
doesn't exist" — it is `BadRequest` from `cursor.decode(before)` in
`handlers/session.ts:111-117`: a raw `msg_…` id is not valid base64url JSON, so
the cursor decoder rejects it before the page query runs. The route DOES accept
`?before`, but it must be a **cursor token** (§1), never a raw id.

**Corrected claim:** the deployed/latest OpenCode REST supports backward paging
via `?before=<cursor-token>&limit=N`. The prior "no backward cursor" conclusion
applied only to the (mis-shaped) raw-id probe, not to the API.

---

## 4. Delivery contract (UNCHANGED from v1.17.18)

The cursor addition is purely a paging mechanism; the SSE/REST delivery contract
vh-solara already relies on is unchanged:

- **SSE event envelope**: `{ id, type, properties }`.
- **Event types**: `session.created/updated/deleted`, `message.updated/removed`,
  `message.part.updated/removed/delta`, `session.diff`, `session.error`
  (+ server lifecycle events).
- **`WithParts` REST shape**: `{ info: User|Assistant, parts: Part[] }`.
- **REST endpoints**: list/page (`GET /session/:id/message[?before=&limit=]`),
  by-id (`GET /session/:id/message/:mid`), prompt, prompt_async, etc.
- **Part schema — 12 types**: `text`, `reasoning`, `tool`, `file`, `step-start`,
  `step-finish`, `snapshot`, `patch`, `agent`, `retry`, `compaction`,
  `subtask` (`subtask` may be new in latest vs v1.17.18 — flagged, low-impact).
- **Daemon render coverage**: the vh-solara daemon renders **9 dedicated** part
  types + a **catch-all** (added at `6fe09ae`) for the remainder
  (`subtask`/`snapshot`/`retry`/…). The catch-all is a **deliberate fallback, NOT
  a silent drop** — so the Part.tsx render-filter gap documented in the
  delivery-proof invariants (INV-7) is a CLIENT-render concern, not a daemon-
  side drop. (The `6fe09ae` catch-all narrows but does not eliminate INV-7 on the
  client.)

---

## 5. Delta vs v1.17.18

Relative to the v1.17.18 validated tag (`pkg/opencode/db.go:50`
`opencodeValidatedTag`):

- **ADDED**: `?before=<cursor-token>&limit=N` backward paging + the
  `X-Next-Cursor` / `Link` response headers; the `message_session_time_created_id_idx`
  index (migration `20260312043431_session_message_cursor`).
- **ADDED (schema, optional)**: `CompactionPart.tail_start_id` (optional field;
  does not affect the page/`WithParts` contract).
- **UNCHANGED**: event types, the `WithParts` envelope, the SSE envelope, and the
  list-vs-by-id cardinality. The exact-lookup + messageID-mint facts in the
  sibling packet (`opencode-v1.17.18-messageid-exact-lookup.md`) still hold.

---

## 6. Direct-SQLite schema (now strictly dominated by the REST cursor)

Recorded for completeness; option (c) "direct-SQLite older-page" is now
**strictly dominated** by the REST cursor (§1–§2) — the REST path is sufficient
and avoids the "direct SQLite reads against the opencode DB" architecture
non-goal.

- **`message` table**: `id` (PK), `session_id` (FK, cascade), `time_created` /
  `time_updated` (Unix-ms, NOT NULL), `data` (JSON). Indexed by
  `message_session_time_created_id_idx` (`session_id, time_created, id`) — the
  index the cursor page query scans.
- **`part` table**: `id`, `message_id` (FK), `session_id`, `Timestamps`, `data`
  (JSON).
- Migration: `20260312043431_session_message_cursor.ts` (backs the cursor index).
- Hydrate/join: `message-v2.ts:98-123`.

---

## 7. Implementer caveats (for any future Part B consumer)

1. **Read the `X-Next-Cursor` response header** — do NOT reconstruct the cursor
   client-side. The server computes it as the oldest tuple of the returned slice;
   reconstructing risks an off-by-one (newest vs oldest) that re-fetches or skips
   a row.
2. **The cursor is the OLDEST tuple of the page, not the newest.** Sending the
   newest would re-return the same page.
3. **`Client.getJSON` discards response headers** (`pkg/opencode/client.go:53-68`)
   — a header-aware variant is needed to consume `X-Next-Cursor` / `Link`.
4. **`MessagesTail`'s doc comment is now stale** (`pkg/opencode/client.go:347-353`):
   it should note the `?before=<token>` paging surface exists alongside `?limit=N`.
5. **Send a cursor TOKEN, never a raw `msg_…` id** — the route runs
   `cursor.decode` on `before`; a raw id is `400 BadRequest` (§3).
6. **Initial (tail) fetch**: `?limit=N` with no `?before` returns the newest-N and **does** include the `X-Next-Cursor` header if more history exists. Consume the authoritative response header to page backward. Do NOT construct the first cursor client-side.

---

## 8. Drift handling

- **Source snapshot**: this packet is grounded in (a) the DEPLOYED instance on
  `127.0.0.1:43889` (probe matrix, §2) and (b) the committed `refs/opencode`
  snapshot with stable `file:line` citations. The **deployed probe is the durable
  evidence**; the `refs/opencode` paths explain the mechanism but are version-
  drifting (OpenCode is a moving target).
- **Do not** cite floating `refs/opencode` "latest" links as the SOLE durable
  evidence — anchor to the deployed-probe matrix + committed `file:line` citations.
- On an OpenCode version bump: re-run the §2 probe matrix against the new
  deployed instance, re-confirm the migration landed, and refresh the §1
  `file:line` citations at the new snapshot. The cursor token FORMAT
  (`base64url(JSON{id,time})`, keys id-then-time, unpadded) and the
  `older()` / oldest-tuple-next-cursor semantics are the load-bearing facts to
  re-verify.

---

## 9. Part B status note (out of scope for this packet)

Part B — the cold-load **past-resident older-page** paging that would consume this
cursor — is **UNAPPROVED and OUT OF SCOPE** for this packet. This packet is the
**factual source study only**; it does not specify Part B's design, wire shape, or
client contract. Part B remains parked (the revert at `7648673` restored full
older-history access, so there is no live paging bug at HEAD); this packet exists
so that IF Part B is later approved, the cursor authority is already established
and the prior "no backward cursor" blocker is corrected.

---

## CONFIDENCE + GAPS

| # | Finding | Confidence | Type | Basis |
|---|---------|------------|------|-------|
| 1 | `?before=<cursor-token>&limit=N` returns strictly-older-N chronological + `X-Next-Cursor`/`Link`; cursor = oldest tuple of slice | **high** | fact | deployed probe (§2) + message-v2.ts:63-78,95-96,425-467; handlers/session.ts:106-145 |
| 2 | Cursor token = `base64url(JSON({id,time}))`, keys id-then-time, unpadded; `time`=time_created unix-ms | **high** | fact | deployed probe decode of `X-Next-Cursor`; groups/session.ts:179-190 |
| 3 | Deployed `127.0.0.1:43889` supports it NOW (migration `20260312043431_session_message_cursor` landed); no upgrade needed | **high** | fact | deployed probe matrix (200 + strictly-older set == DB prediction + headers present) |
| 4 | Prior "no backward cursor" inference was WRONG for latest; the raw-id `?before=<msgid>` 400 is `cursor.decode` rejecting a non-base64url-JSON value, not API absence | **high** | fact (correction) | handlers/session.ts:111-117 + the raw-id 400 in the probe matrix |
| 5 | SSE/REST delivery contract unchanged (event types, `WithParts`, envelopes, list-vs-by-id cardinality); delta is only the cursor paging + index + optional `CompactionPart.tail_start_id` | **high** | fact | refs/opencode snapshot vs v1.17.18 sibling packet |
| 6 | Direct-SQLite older-page (option c) is strictly dominated by the REST cursor | **high** | inference | REST cursor (§1–§2) covers the need; direct-SQLite is an architecture non-goal |
| 7 | `Client.getJSON` discards headers → a header-aware variant is needed to read `X-Next-Cursor`; `MessagesTail` doc is stale | **high** | fact | pkg/opencode/client.go:53-68,347-353 |

### Gaps / not verified
- The probe was run against ONE deployed instance (`127.0.0.1:43889`); other
  deployments / older OpenCode versions may lack migration
  `20260312043431_session_message_cursor` (i.e. no cursor support). vh-solara
  should feature-detect (e.g. probe for the `X-Next-Cursor` header on a tail
  fetch) rather than assume.
- The `subtask` part type ("may be new in latest") was flagged but not
  definitively dated to a release; low-impact (daemon catch-all handles it).
- Did not exercise the cursor to exhaustion (page until `X-Next-Cursor`
  disappears / the session's oldest message); the "next cursor = oldest tuple"
  rule was verified for one paging step, not the full backward walk.

---

## Findings

- **(finding)**: source=deployed opencode 127.0.0.1:43889 probe + refs/opencode message-v2.ts/handlers/session.ts, confidence=high, type=fact — `GET /session/:id/message?before=<cursor-token>&limit=N` returns strictly-older-N (chronological) + `X-Next-Cursor`/`Link` headers; cursor = `base64url(JSON{id,time})` (id-then-time, unpadded, time=time_created unix-ms); next cursor = oldest tuple of the slice.
- **(finding)**: source=deployed opencode probe + refs/opencode message-v2.ts:425-467, confidence=high, type=fact — the deployed instance supports the cursor NOW (migration `20260312043431_session_message_cursor` landed); strictly-older set == DB prediction; `X-Next-Cursor` decodes to the oldest page item; baseline `?limit=N` (no cursor) = newest-N with `X-Next-Cursor` present if more history exists (the historical probe saw no headers because it hit an exhausted window).
- **(finding)**: source=refs/opencode handlers/session.ts:111-117 + the raw-id probe 400, confidence=high, type=fact (correction of record) — the prior "opencode REST has no backward cursor" inference was WRONG for latest; the raw-id `?before=<msgid>` 400 is `cursor.decode` rejecting a non-base64url-JSON value, NOT API absence.
- **(finding)**: source=refs/opencode snapshot vs v1.17.18 sibling packet, confidence=high, type=fact — delta vs v1.17.18 is ONLY the cursor paging + `message_session_time_created_id_idx` index + optional `CompactionPart.tail_start_id`; SSE/REST delivery contract (event types, `WithParts`, envelopes, list-vs-by-id cardinality) unchanged.
- **(finding)**: source=pkg/opencode/client.go (prior to `1dfcd9e903b778864ecbdb71f7df8a8c8a1babbd`), confidence=high, type=fact — `Client.getJSON` discarded response headers (a header-aware variant was needed for `X-Next-Cursor`); `MessagesTail`'s doc comment was stale. (Resolved in vh-solara commit `1dfcd9e903b778864ecbdb71f7df8a8c8a1babbd` which adds header-aware reading in `MessagesTail`).
- **(finding)**: source=REST cursor (§1–§2) vs cold-load-overfetch.md option (c), confidence=high, type=inference — direct-SQLite older-page is strictly dominated by the REST cursor; the REST path is sufficient and avoids the direct-SQLite-reads architecture non-goal.

## Contradictions
- **One, RESOLVED (correction of record).** The prior inference "opencode REST has
  no backward cursor" (cold-load-overfetch.md §Open Decision 1) **contradicts**
  the deployed-latest facts (§1–§2). Resolution: the inference was wrong for
  latest — it generalized a raw-id-probe 400 (`cursor.decode` rejecting a
  non-token) into "API absence." The deployed cursor API exists and works. The
  cold-load-overfetch.md Open Decision 1 should be updated to reflect that the
  backward cursor is available (this packet is the evidence; the doc update is a
  promotion target, §recommended next).

---

## Recommended next specialist / command

This packet is the **evidence base, not active repo policy.** If/when Part B
(cold-load past-resident paging) is approved:

- `planner` → `build`: design Part B around the REST cursor (§1) — read the
  `X-Next-Cursor` header via a new header-aware client method (§7 caveat 3), send
  cursor tokens (never raw ids), and page backward from the tail's oldest tuple.
- **Promotion targets** (separate from this packet): update
  `tmp/agent-runs/delivery-proof/cold-load-overfetch.md` §Open Decision 1 (the
  contradiction, §Contradictions).
  *Note: Consumer-side promotion (header-aware client variant and `MessagesTail` update) has already landed in vh-solara commit `1dfcd9e903b778864ecbdb71f7df8a8c8a1babbd`.*
- On an OpenCode version bump: re-run the §2 probe matrix, confirm migration
  `20260312043431_session_message_cursor` is present, and refresh the §1
  `file:line` citations.
