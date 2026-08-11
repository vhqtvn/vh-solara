# Part-append suffix streaming — wire protocol & instrumentation

> A negotiated, seq-stamped suffix frame (`part.append`) that removes the
> store-egress O(L²) wire cost of today's `part.upsert`-per-flush streaming.
> This document is the **contract** for slices 2–6: frame shape, capability
> negotiation, resume/repair rules, the v1 field allowlist, and the
> incident-capture procedure for the unresolved relay-vs-browser root cause.
> Slice 1 (this doc + telemetry) changes NO live wire format.

**Status:** contract frozen for slice 2; live emission is slice 2+.
**Spec source-of-truth:** `tmp/agent-runs/part-stream-redesign-brief/brief.md`
(the adjudicated `/solution-brief`, medium confidence). Treat that brief's
Decision, Q1–Q4 resolutions, and slice-1 definition as ground truth; this doc
expands them into an implementable contract. Do not re-debate them here.

---

## 1. The problem this replaces

The store accumulates `message.part.delta` server-side and, on each throttled
flush (`deltaFlushInterval=30ms`, `pkg/state/store.go` `deltaFlushInterval`
const), rebuilds and emits `part.upsert` carrying the **entire accumulated
field text** for the part. Wire bytes per part are therefore O(L²) over the
part's lifetime (L = final field length): the 1st flush ships ~L₁ bytes, the
2nd ~L₂ ≥ L₁, …, the Nth ~L_N ≈ L. Summed, that is L·(N/2) ≈ O(L²).

Code anchors (re-verify line numbers before editing; they drift):

- `pkg/state/reducers.go` — `appendPartDeltaLocked` (the native accumulator +
  time-throttled flush trigger) and `flushPartDeltasLocked` (the rebuild +
  `s.emit(KindPartUpsert, updated)` that ships the FULL accumulated text each
  flush).
- `pkg/state/store.go` — `deltaFlushInterval = 30 * time.Millisecond`,
  `partTextCap = 1 << 20` (1 MiB), and the `Kind*` event-kind constants.
- `pkg/state/ring.go` — `ringBuffer` (the 4096-event resume ring, capacity
  asserted by `pkg/state/ring_test.go`).
- `pkg/state/subscriptions.go` — `emit` (seq-stamp + ring push + fanout), the
  256-event per-subscriber channel, and the close-on-overflow slow-reader drop.
- `pkg/state/translate.go` — the `message.part.delta` → `NormPartDelta`
  translator that sources `Field` straight from the upstream payload.
- `pkg/web/server.go` — `wantsCompress(r)` (`z=1`, the capability-negotiation
  pattern this spec mirrors) and the `/vh/diag/latency` mount.
- `pkg/diagnostics/handler.go` — the authenticated GET `/vh/diag/latency`
  snapshot surface.

The fix is **source suffixing**: emit only the newly-appended tail bytes per
flush (`part.append`), so wire bytes per part are O(L) over its lifetime. This
is necessary AND sufficient to remove O(L²) — the daemon never saw SSE
backpressure (`slow_writes=null`, max 653µs; see brief §"Verified facts"), so
neither relay batching nor FE rendering can substitute.

---

## 2. Frame shape — `part.append`

A `part.append` frame is a seq-stamped suffix into the existing 4096-event
ring, emitted INSTEAD of `part.upsert` for the v1 field allowlist (§5) on an
opted-in connection (§3). It carries only the bytes appended since the
previous flush.

```
event: part.append
id: <seq>
data: {"sessionID":"<sid>","messageID":"<mid>","partID":"<pid>","field":"text","start":11,"text":" world"}
```

Fields:

| field       | type   | meaning                                                                 |
|-------------|--------|-------------------------------------------------------------------------|
| `sessionID` | string | session the part belongs to (unchanged from `part.upsert`).            |
| `messageID` | string | message the part belongs to.                                            |
| `partID`    | string | the part being appended to.                                             |
| `field`     | string | the top-level field name being appended to; v1 ∈ {`"text"`,`"reasoning"`}. |
| `start`     | uint32 | **UTF-8 byte offset** into the field's current value where `text` goes. |
| `text`      | string | the appended bytes (UTF-8; a valid suffix of the field).               |

`start` is a **byte offset, not a rune offset** — the FE MUST validate
`currentFieldLen == start` (in bytes) before applying, and MUST NOT apply a
frame whose `start` disagrees with its local length (see §4 resume/repair).

`part.append` is message-class (filtered by the same `IsMessageClassKind` /
`sendable()` session-interest rules as `part.upsert`), recorded in the 4096
ring with the next `s.seq`, and fanned out under `s.mu` exactly as `part.upsert`
is today. The frame is emitted from the existing flush boundary in
`flushPartDeltasLocked` — the only change is WHAT bytes are shipped (the suffix
vs. the full field), not WHEN flushing happens. **Immediate first-token
latency is preserved**: the first flush of a burst still fires immediately
(`deltaLastEmit` zero → elapsed huge); subsequent flushes stay throttled at
`deltaFlushInterval`.

### Worked example (one streaming token at a time)

Field `text`, append `"Hello"`, then `" world"`, then `"!"` across three
flushes on an opted-in connection:

```
event: part.append
id: 1001
data: {"sessionID":"s","messageID":"m","partID":"p","field":"text","start":0,"text":"Hello"}

event: part.append
id: 1002
data: {"sessionID":"s","messageID":"m","partID":"p","field":"text","start":5,"text":" world"}

event: part.append
id: 1003
data: {"sessionID":"s","messageID":"m","partID":"p","field":"text","start":11,"text":"!"}
```

Total wire payload (field bytes only): 5 + 6 + 1 = 12 bytes — the field's final
length. The legacy `part.upsert` path would have shipped 5 + 11 + 12 = 28 bytes
for the same three flushes (and O(L²) over the part's lifetime).

For contrast, the current legacy frame (unchanged, still used on non-opted-in
connections and for all repair/allowlist-excluded events):

```
event: part.upsert
id: 1003
data: {"id":"p","sessionID":"s","messageID":"m","type":"text","text":"Hello world!"}
```

---

## 3. Capability negotiation — `part_delta=1`

Mirror the existing `z=1` (gzip64 snapshot) pattern exactly:

- **Opt-in:** client appends `part_delta=1` to the `/vh/stream` query string.
  The server reads it via a `wantsPartDelta(r *http.Request) bool` helper that
  returns `r.URL.Query().Get("part_delta") == "1"` — the same shape as
  `wantsCompress` (`pkg/web/server.go`).
- **One encoding per connection.** A connection either gets `part.append`
  suffix frames (opted-in) OR legacy full `part.upsert` frames (not opted-in),
  NEVER both for the same `(part,field)`. This is the "no dual-emit" rule from
  the brief Q4: dual-emit on one connection would double the wire cost and
  force the FE to deduplicate, defeating the purpose.
- **Legacy/non-opted-in connections are unchanged.** A stale cached PWA (old
  client) sends no `part_delta` and continues to receive bit-for-bit identical
  full `part.upsert` frames. This is the same protection `z=1` gives against a
  new server emitting gzip64 to an old client.
- **Client kill switch.** The client MAY drop `part_delta=1` on reconnect to
  force the server back to full-upsert encoding — a one-reconnect rollback
  without a server change (brief Q4).
- **Server canary.** The server MAY gate emission behind an internal flag
  independent of the query param, so a canary rollout sends `part.append` only
  to a controlled subset even when the client opts in.

The capability is per-CONNECTION and established once at `/vh/stream` open. It
does not change mid-stream.

---

## 4. Resume, repair, and the fallback hierarchy

`part.append` is seq-stamped into the 4096-event ring, so resume reuses the
existing ring machinery with one new rule: a suffix frame is only applicable
if the client's local field length matches the frame's `start`.

### 4.1 Incremental resume (the happy path)

On reconnect with `Last-Event-ID` (cursor), the server replays ring events
with `seq > cursor`. For a `part.append` event, the client applies it iff
`currentFieldLen == start`. When this holds for every replayed suffix in
order, the client ends resume with the exact same field value the server
holds — no snapshot needed.

### 4.2 Cursorless snapshot fallback (the repair path)

A connection takes a **cursorless authoritative snapshot** (the existing
snapshot path — no mixed suffix+snapshot replay) in ALL of these cases:

1. **Offset mismatch.** A replayed `part.append` has `start !=
   currentFieldLen` (the client's local field diverged — a lost earlier
   suffix, a snapshot base that differs, etc.). The client MUST NOT
   byte-splice a suffix at the wrong offset.
2. **Ring gap (existing).** The cursor is older than the oldest retained ring
   event (`ringBuffer.since` returns `ok=false`). Unchanged from today.
3. **Overload (existing).** The subscriber's 256-event channel filled and the
   store closed+dropped it (`emit` default-case → `subscriber_drops++`). The
   client reconnects and re-snapshots. Unchanged from today.
4. **Excessive event age.** A replayed suffix whose ring residency exceeds the
   configured max-age (TBD; no evidence supports an arbitrary threshold yet —
   brief uncertainty #4/#5) is treated as unreliable → snapshot. (Bound to be
   wired in slice 3/4 once retention is measured; slice 1 does not set the
   threshold.)

In every fallback case the client receives a fresh authoritative snapshot and
resumes live-tail from the snapshot's seq. **There is no mixed replay**: a
connection either replays pure suffixes incrementally OR takes a snapshot,
never a hybrid that interleaves suffix frames with snapshot data for the same
part.

### 4.3 Legacy replay of a suffix-only range

A connection that did NOT opt into `part_delta=1` but whose cursor replay range
contains `part.append` events (e.g. an old client reconnecting against a server
that has already emitted suffixes into the ring) takes a **snapshot** rather
than interpreting frames it cannot decode. The server detects "replay range
contains a kind the client didn't negotiate" and falls back to snapshot for
that connection. Legacy must NEVER be asked to interpret a `part.append` frame.

### 4.4 Authoritative `part.upsert` still repairs

A wholesale `part.upsert` (from `message.part.updated`, a cold-load reconcile,
or the snapshot itself) remains authoritative and supersedes any in-flight
suffix accumulation, exactly as today's `discardPartDeltaLocked` discards the
buffered accumulator when a snapshot arrives. The FE's existing
**merge-if-absent / upgrade-on-completed** semantics are UNCHANGED — slice 1
does not touch them, and slices 2–6 must preserve them.

---

## 5. Field allowlist (v1)

V1 emits `part.append` for **top-level `text` and `reasoning` fields only**.

| surface                                                  | v1 encoding               |
|----------------------------------------------------------|---------------------------|
| `part.text` (top-level)                                  | `part.append` (opted-in)  |
| `part.reasoning` (top-level)                             | `part.append` (opted-in)  |
| Tool status / type transitions                           | full `part.upsert`        |
| Nested `state.output` / `state.error` (tool output)      | full `part.upsert`        |
| Completion / non-append mutation                         | full `part.upsert`        |
| All repair / snapshot / cold-load                        | full `part.upsert`        |

Rationale (brief Q3): `text` and `reasoning` are the proven append-only
top-level streaming fields. Everything else — tool status changes, nested tool
output, completion, any non-append mutation — stays on the authoritative
full-upsert path. Extending the allowlist requires (a) confirming the field is
append-only at the source and (b) the offset/repair rules in §4 still hold for
it.

### 5.1 Open-question #1 — does nested tool output flow through the append-delta path today?

**Resolved by static inspection (slice 1): NO.** Nested tool output
(`state.output` / `state.error`) does NOT flow through the append-delta path
today.

Static evidence:

- The delta translator (`pkg/state/translate.go`, `case "message.part.delta"`)
  reads `field` straight from the upstream payload's `field` JSON property and
  passes it through as `NormalizedEvent.Field`. The daemon does not synthesize
  or restrict field names at the translate boundary.
- The accumulator (`pkg/state/reducers.go` `appendPartDeltaLocked`) keys its
  `strings.Builder` by `partID + "\x00" + field`, and the flush
  (`flushPartDeltasLocked`) applies it with `part[field] = buf.String()` — a
  **flat top-level string assignment**. It cannot represent a nested path:
  even if upstream sent `field:"state.output"`, the result would be a
  malformed top-level key `part["state.output"]`, NOT the nested
  `part.state.output`.
- Nested tool output (`state.output` / `state.error`) is updated via the
  authoritative `message.part.updated` snapshot path (`NormPartUpsert` →
  `upsertPartLocked`), NOT via `NormPartDelta`. The tool's streaming stdout is
  bounded by `partTextCap` at the snapshot level (`capPartJSON`), not via the
  delta accumulator.

So: the append-delta path only ever mutates a **flat top-level string field**
whose name is whatever upstream OpenCode supplies. Whether upstream ever
supplies a `field` value OTHER than `text`/`reasoning` (e.g. a literal
`"state.output"`) is not determinable from daemon code alone — that depends on
OpenCode's publisher. But even if it did, the daemon would mis-store it as a
flat key, so no real nested tool output reaches the SPA through this path.

**Runtime confirmation (slice 1 telemetry):** the
`probes.part_delta_fields` table added to `/vh/diag/latency` (§6) records every
distinct `(part.type, field)` pair that actually flows through
`flushPartDeltasLocked`, with a per-pair flush count and flushed-byte total.
After a representative tool-heavy session, the table should show only
`(text, text)` and `(reasoning, reasoning)`-style pairs; the appearance of any
other pair (e.g. `(tool, state.output)`) would empirically refute the static
finding and reopen the allowlist question. As of slice 1, the static finding
stands and the telemetry is in place to confirm or refute it under load.

---

## 6. Slice-1 telemetry — `probes.part_delta_fields`

A new bounded-cardinality probe on `/vh/diag/latency` records the
`(part.type, field)` combinations actually materialized by
`flushPartDeltasLocked`. It exists to (a) empirically confirm open-question #1
and (b) give slice 4 a per-field byte baseline (the success metric is "part
bytes scale linearly with final text length").

Shape (added under `probes` in the `/vh/diag/latency` JSON):

```json
"part_delta_fields": [
  {"part_type":"text","field":"text","count":412,"bytes":81234},
  {"part_type":"reasoning","field":"reasoning","count":88,"bytes":5102}
],
"part_delta_field_overflow": 0
```

- `part_type` — the part's `type` field at flush time (always present; the
  delta placeholder defaults it to `"text"`).
- `field` — the streaming field name being appended (post-defaulting; empty
  upstream `field` is normalized to `"text"` by `appendPartDeltaLocked`).
- `count` — number of flushes observed for this pair.
- `bytes` — sum of the flushed field-text length (the O(L)-per-flush quantity;
  summed across flushes this is the O(L²) cost the suffix protocol removes).
  This is a finer-grained view than the existing aggregate
  `probes.emit.class_bytes["part"]`, which carries the FULL upsert payload
  bytes (the quantity slice 4 must drive to linearity).
- `part_delta_field_overflow` — observations that arrived after every slot was
  claimed by a DIFFERENT pair (the slot cap is `MaxPartDeltaFieldSlots`).
  Non-zero means the cap is too low for the workload, NOT that data was lost
  unattributably.

The probe is bounded-cardinality (fixed slot cap), pure-atomics on the hot
path (a single linear scan + one atomic add; at most one allocation on a
first-ever distinct pair, bounded by the slot cap for the process lifetime),
and adds **zero per-flush allocation** — the JSON unmarshal+marshal already
happens in `flushPartDeltasLocked`, and `part["type"]` is read from that
already-unmarshaled map. The flush path runs under `s.mu` (writer-serialized);
the `/vh/diag/latency` snapshot read is lock-free.

**Slice-4 success metric (for reference; not slice 1):**
`probes.emit.class_bytes["part"]` scales linearly with final field length, and
`probes.part_delta_fields[*].bytes` (per pair) sums to ≈ final field length
(no O(L²) growth).

---

## 7. Incident-capture procedure — relay-vs-browser root cause (~10 min)

The live incident (brief §"Verified facts") streamed in large lumps then
looked stuck >60s; manual reload was instantly current. The daemon was
exonerated (`slow_writes=null`, `subscriber_drops=6` lifetime), so the backlog
formed DOWNSTREAM of the daemon's SSE write — somewhere in
`SSE → yamux tunnel → controller proxy io.Copy → WebSocket → browser apply/render`.
The exact leg is unresolved (brief uncertainty #1). When the symptom recurs,
capture the following within ~10 minutes WHILE the stall is live, then apply
the decision rule.

### 7.1 Capture steps (in parallel where possible)

1. **Browser DevTools → Network → the `/vh/stream` EventSource connection.**
   - Open the connection's **Events** tab (or the equivalent timeline). Record
     per-frame **arrival time**, **frame size** (bytes of the `data:` field),
     and **inter-frame gaps**.
   - What you are looking for: are frames arriving promptly (sub-second gaps,
     growing sizes = the O(L²) upserts) or is there a multi-second arrival gap
     during the stall?
2. **In-app diagnostics panel** (the SPA's Performance/servers diagnostic view
   backed by `/vh/diag/latency`). Note the live `stream` class counters and
   whether the stall coincides with a snapshot/replay fallback.
3. **`GET /vh/diag/latency`** (authenticated; same surface the panel reads).
   Capture two snapshots ~30s apart during the stall and diff:
   - `probes.stream[*]` (the `/vh/stream` SSE pump): `bytes`, `writes`,
     `write_dur` (p50/p95/p99), `interarrival`, `slow_writes`,
     `disc_reason` (esp. `subscriber_channel_closed`), `snapshot_path` vs
     `replay_path`. A healthy pump shows sub-ms `write_dur` and short
     `interarrival`; `slow_writes` populating means the daemon SSE Write
     itself blocked (would contradict the prior `slow_writes=null` finding —
     re-exonerate or find the new blocker).
   - `probes.yamux.write_by_dir[*]` (esp. `yamux_response` = worker
     local-service → yamux): `bytes`, `dur`, `slow_writes`,
     `slow_write_incidents`. Growing `yamux_response.dur` / `slow_writes` with
     a full send window = the tunnel leg is the wedge.
   - `probes.ws_write[*]` (`mutex_wait_dur` vs `write_msg_dur`): head-of-line
     serialization on the single WebSocket write critical section shows up as
     rising `mutex_wait_dur`.
   - `probes.copy[*]` (`yamux_to_browser` vs `browser_to_yamux`): `bytes`,
     `dur`, `term`. Stalled `yamux_to_browser.bytes` while
     `yamux_response.bytes` keeps advancing = bytes queued between yamux and
     the controller's io.Copy.
   - `probes.emit.class_bytes["part"]` and the new
     `probes.part_delta_fields[*]`: confirm the O(L²) upsert volume is still
     being generated (pre-suffix-protocol) and which `(part.type, field)`
     pairs dominate.
4. **Controller / yamux / WebSocket queued bytes, blocked writes, copy
   progress** — read from the same `/vh/diag/latency` fields above
   (`active_streams`, `yamux.write_by_dir`, `ws_write`, `copy`). The
   controller proxy is protocol-agnostic (raw `io.Copy`), so its signal is
   byte-rate + copy duration, not frame content.

### 7.2 Decision rule

Apply in order:

| Observation during the stall                                                                 | Verdict  | Next                                                                 |
|----------------------------------------------------------------------------------------------|----------|----------------------------------------------------------------------|
| DevTools shows frames **arriving promptly** (sub-second gaps, growing sizes) but the **app applies/renders them late** (UI frozen while the EventSource buffer drains). `/vh/diag/latency` stream/yamux/ws_write `write_dur` all nominal. | **Browser** | Slice 3 FE apply/render work (frame-batched application, one reactive SET per frame, preserve object identity). Relay is not the wedge. |
| DevTools shows **delayed arrival** (multi-second gaps, frames bunched into lumps) AND `/vh/diag/latency` shows **growing relay queues** (`yamux_response.dur` / `slow_writes` rising, or `ws_write.mutex_wait_dur` rising, or `copy.yamux_to_browser.bytes` stalled while `yamux_response.bytes` advances). | **Relay** | Slice 6 relay-policy follow-up (relay buffering prevented timely failure propagation). The O(L²) fix (slices 2–5) is still necessary but not sufficient for this class. |
| Frames arrive promptly AND apply promptly BUT the stall is the initial snapshot/replay (no live frames at all). | **Snapshot/replay** | Separate failure class (the 715/727 snapshot-vs-replay skew, brief §"Verified facts"). Not the live-stuck class. |

Record the verdict, the two `/vh/diag/latency` snapshots, and the DevTools
frame timeline in the incident ticket. The unresolved root cause is the
load-bearing input to the slice-6 relay-policy decision (gated: only pursue if
the relay verdict fires).

---

## 8. What slice 1 did NOT change (non-goals, carried to slices 2–6)

- **No `part.append` frames are emitted.** The live SSE wire format is
  byte-for-byte unchanged. Slice 1 only adds the contract (this doc) and the
  `(part.type, field)` telemetry.
- **No FE apply/render logic changed.** Slice 3.
- **No egress conflation added.** Gated behind the slice-4 slow-reader test.
- **No snapshot/cold-load (`messages.batch`, gzip64) format change.** Out of
  scope entirely.
- **No controller relay/tunnel buffering policy change.** Slice 6, gated.
- **FE merge semantics (merge-if-absent, upgrade-on-completed) unchanged.**
- **First-token latency unchanged** (slice 1 does not touch the flush path's
  timing; the telemetry call is after the field-text is already materialized
  and adds no allocation).

---

## 9. Slice-2 handoff

The contract is now stable. Slice 2 may begin emitting seq-stamped
`part.append` for the `text` + `reasoning` allowlist behind `part_delta=1`,
reusing this doc as the wire-format spec. Specifically, slice 2 should:

1. Add `wantsPartDelta(r)` mirroring `wantsCompress` and thread the per-
   connection capability into the stream handler + the store's emit path.
2. In `flushPartDeltasLocked`, for an opted-in connection AND a field in the
   v1 allowlist, emit `part.append {sessionID,messageID,partID,field,start,text}`
   (where `start` = the field length BEFORE this flush's suffix, `text` = the
   bytes appended since the last flush) INSTEAD of `KindPartUpsert`. Keep the
   immediate-first-flush behavior. Keep legacy full-upsert for non-opted-in.
3. Add `KindPartAppend = "part.append"` to `pkg/state/store.go`, classify it as
   message-class (`IsMessageClassKind`), and seq-stamp it into the 4096 ring.
4. Leave FE apply, repair, conflation, and relay policy to slices 3/4/5/6.
5. Re-verify the code anchors in §1 before editing — line numbers drift.
