# Controller stream and shared history read-state solution brief

**Date:** 2026-09-29  
**Status:** COMPLETE (solution brief; GET /vh/fleet/stream live SSE stream + shared notification read state)  
**Origin:** Controller stream and read-state synchronization (Slice 1)  

> Promoted-from: tmp/agent-runs/android-push-20260928/stream-readstate-brief.md  
> Original date: 2026-09-29  
> Provenance: researcher -> debate -> planner pass, 2026-09-29; read-only static source inspection  
> Scope: foreground phone fleet status updates via SSE stream and synchronized notification-history read state.  

---

**2026-09-29 — DO-NOT-EXECUTE: all implementation and verification plans below are proposals.**

Workflow completed: researcher → debate → planner, read-only source inspection. No implementation, tests, durable state, or git changes were performed. This transient brief is the sole written artifact. Landing on local main at `1f83da9f` was accepted as user-settled, not re-audited. Evidence describes inspected working-tree sources, not a tested revision receipt.

## Decision frame

- Objective: provide foreground phone fleet updates promptly after server observation, and synchronize notification-history read state between the single operator's devices.
- Open question: which smallest additive stream and durable cursor contracts meet that objective without changing existing API semantics?
- Constraints: existing schemas/semantics and vocabulary remain intact; additions only; cookie authentication; mutation CSRF in handlers; plain-text `http.Error`; existing persistence discipline; handful of clients; lane 1 primary and lane 3 for controller routing.
- Success criteria: validated immediate snapshot and bounded latest-state delivery; refresh without polling or configured notifications; safe reconnect; global monotonic read-through cursor; acknowledged cursor and supporting history persisted together; coherent retained-window unread metadata; explicit failure behavior.
- Out of scope: permission/question actions, condition-detail drill-down, server quiet hours/severity filtering (app-side only), condition/push vocabulary changes, watch-specific surfaces, implementation, test execution, and durable research/task/session state.
- No kickoff `framing_confidence` signal was supplied. None was inferred retroactively. Debate assessed confidence as medium; scope did not shift. No manual step-back occurred.

## Research packet

Source policy: repo-first, repository-only. No fresh external facts were necessary for selection. Source facts are separated below from design preferences and unmeasured predictions.

### Evidence register — static source observations

| ID | Finding | File:line anchors |
|---|---|---|
| E1 | Consumer contract: single operator, cookie auth, CSRF, plain-text errors, ETag/history expectations. | `tmp/agent-runs/android-push-20260928/app-handoff.md:20–29,108–111,163–187` |
| E2 | Immutable status generations; `serve` checks registry/config stamps, TTL, and single-flight acquisition. | `pkg/server/status.go:406–443,460–500` |
| E3 | Refresh/fallback set current generation under service mutex; publication itself need not reject obsolete stamps. | `pkg/server/status.go:525–550,556–594` |
| E4 | **Fleet status** ETag hashes exact body including generated timestamp; GET retains 304/error behavior. | `pkg/server/status.go:2017–2067` |
| E5 | Watcher immediately and every 15s calls ordinary cached `serve`; watcher starts only with store and transport. | `pkg/server/notify_watcher.go:141–164,365–384` |
| E6 | Initial observation silent; decreases recorded without push; incomplete coverage suppresses clears; dispatch waits before append. | `pkg/server/notify_watcher.go:178–234,269–273,282–339` |
| E7 | History bounded at 500; missing file empty, malformed file failure; append memory-first, persistence errors logged; restart IDs derived from persisted history. | `pkg/server/notify_history.go:65–74,127–185,203–279` |
| E8 | History first/last IDs are page-local; default limit 50/max 200; disabled store 409. | `pkg/server/notify_history.go:282–358` |
| E9 | Atomic0600 helper uses exclusive temporary file, sync/close/rename; callers serialize; registry mutation persistence precedes visibility and bumps structural generation. | `pkg/server/notify_store.go:328–387,431–439,493–553` |
| E10 | History at store path + `.history` loads before registry installation. | `pkg/server/notify_store.go:763–784`; `pkg/server/notify_history.go:192–201` |
| E11 | Existing bounded JSON, CSRF, disabled-store, schema-1 response helpers; actual CSRF helper accepts nonempty header, client convention remains `1`. | `pkg/server/notify_http.go:89–143,169–181` |
| E12 | Authentication precedes host interception; global CSRF guard covers unsafe `/api/` only; exact fleet exceptions, existing notify-prefix exception. | `pkg/server/daemon.go:334–349,376–388,407–440` |
| E13 | Worker SSE uses flushing, buffering/transform protections, retry 2000, named 15s ping without ID, dropped-consumer closure. | `pkg/web/server.go:2417–2468,2961–2972,3052–3059` |
| E14 | Local verification seams exist for cache/auth/routing, history reload/trim, persistence, watcher gating, real controller/tunnel rollup. | `pkg/server/status_test.go:1327,1371,1419,1483,1569`; `pkg/server/notify_watcher_test.go:587,627`; `pkg/server/notify_history_test.go:132,188,221`; `pkg/server/notify_store_test.go:334,367,426`; `pkg/server/notify_http_test.go:577`; `tests/e2e/fleet_status_e2e_test.go:3–17,42` |

### Material options and debate outcome

| Option | Comparison | Verdict |
|---|---|---|
| O1 full-rollup SSE | Complete replacement snapshots, coalescing safe, one request stream. | Lead; recommend design direction. |
| O2 changed-ping + ETag GET | Smaller signals but generally same full body plus another request; timestamps weaken semantic-change suppression. | Credible but inferior at this scale. |
| O3 deltas | Lower possible bytes, but needs ordering/base validation/resync protocol. | Reject for current scope; reconsider only on measurements. |
| O4 global cursor in history file/holder | One ownership/atomic persistence boundary for supporting events and read state. | Lead; lean pending implementation verification. |
| O5 global cursor in token store | Wrong ownership, structural generation coupling, two-file consistency/lock concerns. | Do not choose. |
| O6 tiny cursor sidecar | Isolated format but crash ordering must first persist supporting history; extra recovery boundary. | Strongest alternative, not preferred. |
| O7 per-token cursors | Does not synchronize reading across devices; token rotation complicates identity. | Reject against stated objective. |

Debate overall verdict: **lean O1 + O4**. Its critical objection was acknowledgement of memory-only history IDs that might otherwise be reused after restart. Planner identified a feasible same-file transaction using existing helpers; this resolves the design question, **not** the requirement for failure/restart tests. No revision/reframe was required. Debate's relabeling of A1–A5 as evaluation criteria is not used here: the following numbering matches the user's questions. Its phrase “history ETag” was a labeling error; E4 concerns fleet status.

## Per-question decisions

### A1 — Full body, not invalidation fetch or deltas

Send exact existing rollup JSON per delivered generation, with latest-state coalescing. This is a current-state stream, not a transition log; intermediate generations may be skipped.

**Assumption:** payloads are a few KB for this deployment; not measured. For compact one-line JSON of B bytes, `event: fleet.status\ndata: <JSON>\n\n` costs approximately **B + 28 bytes** before transport/TLS overhead. Example only: B=4 KiB and one frame/15s is about 0.99 MB/hour/client; one/5s is about 2.97 MB/hour/client. General budget is `N × (B + 28) × foreground_seconds / cadence_seconds`, plus heartbeat/transport overhead. A named empty ping costs about 22 bytes (~5.3 KB/hour at 15s), excluding transport. Concurrent GETs/publications may make the stream faster than its demand refresh target; these are examples, not enforced rates.

Prediction: avoiding the additional GET is simpler and likely cheaper than O2 at this small scale. Battery cannot be inferred from byte count: radio wakeups, heartbeats, reconnects and OS policy dominate unknowns. Recommend one connection per foreground app instance, backoff/jitter on reconnect, and existing push/poll fallback when suspended. Do not promise indefinite Android background SSE or quantified battery savings.

### A2 — Coalesced wakeups, bounded subscribers, close blocked writers

- Add service-owned mutex-guarded subscriber set; capacity-one **wake channel**, not an unbounded body/event queue.
- Register and capture current pointer under the same lock used for publication; signal nonblocking at both normal and fallback publication. A full wake channel means coalesce, not disconnect. Pending notification must always cause reconciliation to newest state.
- Handler calls existing validated `serve(ctx)` after registration and each wake; never sends a raw captured publication blindly (E2/E3). Deduplicate already-sent immutable generation. Do not claim linearizability against a registry change occurring after normal `serve` validation.
- Never perform network writes under service lock. Cleanup unregisters on all exits; avoid send-on-closed-channel races. Demand-driver lifecycle follows first/last subscriber and daemon shutdown.
- Preference: daemon-wide **16 subscribers**, including bootstrapping reservations. At cap return plain-text **503**, `Retry-After: 5`, before headers. Obtain bootstrap before committing 200; failure returns plain-text 503 and releases slot.
- Preference: **10s finite write/flush deadline**, refreshed per frame; close on timeout/error. Confirm `ResponseController` support through actual middleware; fail before headers if finite writes cannot be enforced rather than silently lose the bound. No new per-client acquisition goroutine or infinite writer queue.
- Heartbeat: **named `ping` with `{}` every ~15s**, no ID, matching E13. Comment frames would also be valid; choosing named ping is consistency, not a claim that comments fail. Heartbeats are not generation publications.
- Reconnect resends a validated current snapshot; no replay buffer or `Last-Event-ID` recovery. Ignore supplied `Last-Event-ID` rather than promising its meaning.

### A3 — One subscriber-demand refresh loop; Wear polling unchanged

The existing watcher does **not** suffice as a universal driver: it is absent without store/transport, uses cached `serve`, and dispatch can delay it (E5/E6). Add one service-owned demand driver only while subscribers exist, targeting ~15s observations through ordinary `serve`. Recent GET/watcher publications and single-flight acquisition satisfy/coalesce demand; no per-client cadence and no separate aggregation code. Do not enable notification watching or change notification history semantics just to support streaming.

TTL expiry is not autonomous refresh, and registry invalidation alone is not a push publication. Promise prompt delivery **after a validated generation is published**, not sub-second detection or guaranteed instantaneous registry-change refresh. Demand cadence plus acquisition latency bounds expected observation timing, not a hard real-time SLA. Wear remains on existing `GET /vh/fleet/status` with ETag; no watch-specific server change.

### A4 — Controller-owned safe GET with exact host exception

Route `GET /vh/fleet/stream` through authenticated userMux; other methods 405; safe GET is CSRF-exempt. Add exact hostInterceptor exception so a worker-subdomain request is not forwarded to the worker. Preserve clean unauthenticated `/vh/*` 401. Add history mutation route separately; existing `/vh/notify/` host exception already covers it. Require its in-handler CSRF check using existing helper; clients send `X-VH-CSRF: 1`.

SSE headers: `Content-Type: text/event-stream`, `Cache-Control: private, no-cache, no-transform`, `X-Accel-Buffering: no`. Flush each frame; do not set hop-by-hop `Connection` header (HTTP/2 compatibility). Operator note: disable reverse-proxy buffering (`proxy_buffering off` for nginx), set read timeout comfortably above heartbeat (e.g. 60s), and check compression/CDN buffering. Header presence is not proof that a deployed proxy honors flushing. No proxy configuration changes are authorized here.

### A5 — Named full-state event, no event ID, existing GET fallback

```text
retry: 2000

event: fleet.status
data: <unchanged compact fleet-status JSON>

event: ping
data: {}

```

No `id:`: generated timestamps are not a replay cursor, and an added process-local sequence provides no needed recovery guarantee. Do not place a changing ETag on the entire held response. Existing GET/If-None-Match stays the conditional fallback and optional bootstrap. SSE itself bootstraps, so a redundant GET is not mandatory. If switching to GET after SSE, use the last GET validator or an unconditional GET; do not fabricate an ETag from generated_at. Once 200 is committed, terminal failure closes the stream; never append `http.Error` text into SSE.

### B1 — One global cursor stored with history

Add optional persisted `read_id` to the existing history file and holder, missing field → zero. Keep token store format/generation untouched. Single operator means no token/session ownership parameter. This represents **read through N**, not individual event read marks, push delivery acknowledgements, or fleet `session_unread`.

Under the history mutex, validate against assigned high-water `nextID - 1`, then persist a candidate containing **all current retained entries and the new cursor** via `persistAtomic0600`, before making the cursor visible. Existing `persistLocked` writes the full retained array (`pkg/server/notify_history.go:269–281`); extend all later history writes to preserve cursor too. Candidate-first is preferred; a lock-contained temporary assignment with rollback can work but must not leak partial state.

Reasoning, not proof: a successful acknowledgement includes any previously memory-only supporting entries in the same atomic replacement. Later failed append persistence leaves that last successful snapshot intact. This prevents acknowledged cursor IDs from being lost/reused under the existing process-restart/file-replacement model without changing frozen memory-first append semantics. It does **not** repair ID reuse for unacknowledged failed appends, external file deletion, unsupported downgrade, or establish stronger power-loss durability than the existing helper provides. Planner's phrase “entirely safe” is narrowed to this invariant.

Startup: absent legacy field zero; malformed, negative, or cursor above loaded history high-water fails load with existing startup failure posture. Missing whole file follows existing empty-history behavior. Older strict-decoding binaries may reject the extended file: document backup/forward-version/downgrade compatibility hazard, not a silent reset/migration. Successful new-format writes make this relevant even if cursor is zero unless serialization omits zero.

### B2 — Monotonic idempotent POST, explicit validation/errors

`POST /vh/notify/history/read` body `{"id":123}`. Follow auth → in-handler CSRF → configured store → bounded strict decode → holder mutation. Wrong method 405; missing CSRF uses existing forbidden response; disabled store **409**, including when body is otherwise valid. Configured store without transport may still serve/read existing history.

Require exactly one `id`, present/non-null, nonnegative signed-int64 JSON integer. Reject unknown fields, duplicates, strings/bools/fractions/exponent notation, overflow, malformed/trailing documents: plain-text **400**. Reuse size limits; a local decoder wrapper must reject duplicate keys because ordinary strict struct decoding does not. Do not change shared decoder behavior for frozen endpoints.

- `id > highest assigned` → **400**, never clamp.
- `id <= read_id` → **200**, unchanged/no disk write; stale devices must not receive spurious conflict failures. Zero is valid.
- Trimmed historical IDs remain valid watermarks; retained membership is not required.
- Advancement persistence failure → plain-text **500**, old cursor remains visible.
- Success → `{"schema":1,"read_id":123,"unread_count":7}` with coherent values captured under holder lock.

### B3 — Echo through history, not tokens

Add `read_id` and `unread_count` to history GET response without changing `schema:1`, events, pagination, order, or existing fields. Capture page plus metadata under the same lock. `unread_count` counts **all retained events with ID > read_id**, independent of `since`/`limit`/device scopes; maximum 500. Tokens GET unchanged. No fleet cache invalidation or token-generation bump for acknowledgements.

Shared storage does not itself instantly update device screens: devices reconcile history metadata on foreground/history fetch and after their own acknowledgement. Fleet SSE carries no read-state field/event; a watch needs a history GET to learn shared read state, not just a fleet ETag poll. This uses existing history API, not a watch-specific surface. Instant read-state fanout is not promised by this slice.

### B4 — Retained-window unread semantics

When cursor is below oldest retained ID, keep it unchanged and count retained entries after it. Do not reset cursor to the head, infer archive unread totals, or interpret page-local `first_id`/`last_id` as global bounds. Trimming can lower unread_count without an acknowledgement. Clients acknowledge the greatest event actually considered read, not an assumed newest event from an unrelated page. Newly arriving IDs beyond the explicit submitted N remain unread.

## Planner — DO-NOT-EXECUTE

### Recommended split: two small sequential slices

Independent behavior/persistence risks justify two slices; `daemon.go` is shared, so implement sequentially. No authorized implementation is implied by this brief.

#### Slice 1 — fleet stream

Exact proposed scope:
- Modify `pkg/server/status.go`, `pkg/server/daemon.go`, `pkg/server/status_test.go`.
- Add `pkg/server/status_stream.go`, `pkg/server/status_stream_test.go`, `tests/e2e/fleet_stream_e2e_test.go`.
- Add `docs/guides/controller-live-state.md` documenting wire contract, latest-state semantics, foreground/reconnect and proxy requirements. This is a proposed new path, not an asserted existing guide.

New test coverage:
1. Exact-body bootstrap, headers/retry/ping, GET-only, unauth401 and no GET CSRF.
2. Subscribe/publication race, refresh and fallback wakeups, stamp validation and generation deduplication.
3. Coalescing latest-state correctness; cap admission/release, cancellation/shutdown, finite blocked-write termination; no writes while service lock held.
4. One demand loop; zero-subscriber shutdown; progress with notifications disabled; watcher/GET reuse and single-flight; acquisition failure before versus after headers.
5. Reconnect resnapshot ignores Last-Event-ID; existing status ETag/304 semantics unchanged.
6. Lane 3 real HTTP/controller/tunnel fixture proves controller route under worker Host, first-frame flush and subsequent full snapshot; verifies middleware supports write deadlines. Deployed nginx and physical-phone latency/battery remain separate unexecuted checks.

Proposed commands (not run; targeted suite, not full-repo green):
```sh
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test -race ./pkg/server/'
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
```

#### Slice 2 — global read cursor

Exact proposed scope:
- Modify `pkg/server/notify_history.go`, `pkg/server/notify_history_test.go`, `pkg/server/notify_http_test.go`, `pkg/server/daemon.go`, `docs/guides/controller-live-state.md`.
- Add `tests/e2e/notify_history_read_e2e_test.go` for the new controller route/security/cross-device behavior.

New test coverage:
1. Legacy load zero, valid reload, malformed/negative/future persisted cursor rejection, mode0600 retained.
2. Strict input/error matrix including missing/null/duplicate/unknown/negative/fraction/exponent/overflow/trailing body and future IDs; disabled409, CSRF/auth and method checks.
3. Concurrent increasing/decreasing requests cannot regress; old/zero IDs are no-write success; read-through N leaves later append unread.
4. Ack failure leaves cursor unchanged; memory-only append followed by successful ack then restart preserves entries+cursor; successful ack followed by failed append persistence then restart cannot reuse an acknowledged ID. Preserve original unacknowledged append failure semantics.
5. Whole-window unread count independent of pagination; coherent page+metadata; >500 trim with cursor below head; empty history; page-local first/last unchanged.
6. No token structural-generation bump/fleet invalidation; all subsequent appends persist cursor.
7. Lane 3: phone-like POST then watch-like history GET sees shared cursor/count via real controller route; worker Host carveout, cookie401/CSRF protection exercised with fixtures, no FCM call required.

Proposed commands (not run; targeted suite, not full-repo green):
```sh
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test -race ./pkg/server/'
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
```

Keep `notify_watcher.go`, `notify_store.go`, `notify_http.go`, and `pkg/web/server.go` implementation unchanged unless a discovered blocker requires explicit scope revision. Reuse helpers, not copied implementations. No frontend/app changes in either server slice. Before future completion claims, retain actual tree-bound command receipts and declare the load-bearing path; this brief supplies no such receipt.

## Premise corrections and re-derivation tuples

Commands below denote read-tool operations, not executed shell commands. Re-read at build handoff; source lines may drift. All observed_at values: **2026-09-29, researcher/planner static inspection**.

1. **(value:** watcher is conditional and calls TTL-cached serve, not unconditional forced refresh; **source:** E2/E5; **re_derivation_command:** `Read pkg/server/notify_watcher.go lines 141–164 and 365–384; Read pkg/server/status.go lines 460–500`; **observed_at:** as above**)**.
2. **(value:** raw publication may hold obsolete stamps; stream must reuse validated serve; **source:** E2/E3; **re_derivation_command:** `Read pkg/server/status.go lines 460–594`; **observed_at:** as above**)**.
3. **(value:** history IDs are restart-monotonic only insofar as supporting history persisted; unacknowledged failed appends can be lost/reused; **source:** E7; **re_derivation_command:** `Read pkg/server/notify_history.go lines 203–281`; **observed_at:** as above**)**.
4. **(value:** history first_id/last_id are page-local, not validation high-water; **source:** E8; **re_derivation_command:** `Read pkg/server/notify_history.go lines 282–358`; **observed_at:** as above**)**.
5. **(value:** decreases can produce history without push and first baseline is silent; handoff wording must not imply all changes push; **source:** E6 and handoff lines 202–205; **re_derivation_command:** `Read pkg/server/notify_watcher.go lines 178–234; Read tmp/agent-runs/android-push-20260928/app-handoff.md lines 202–205`; **observed_at:** as above**)**.
6. **(value:** conditions never sampled cannot be recovered from history; handoff caveat is not a recording guarantee; **source:** E6 and handoff lines 243–245; **re_derivation_command:** `Read pkg/server/notify_watcher.go lines 159–235; Read tmp/agent-runs/android-push-20260928/app-handoff.md lines 243–245`; **observed_at:** as above**)**.
7. **(value:** existing history writer serializes the full retained array and atomic helper permits a single-file history+cursor transaction; **source:** planner inspection, E7/E9; **re_derivation_command:** `Read pkg/server/notify_history.go lines 269–281; Read pkg/server/notify_store.go lines 328–387`; **observed_at:** as above**)**. This supports plan feasibility, not a tested correctness claim.

These corrections inform additive design; they do not authorize altering the existing handoff, schemas, watcher, or failure semantics.

## Confidence, remaining uncertainty, and next action

- Confidence high in static source observations, medium in selected design. Debate's persistence condition is addressed by an explicit same-file transaction plan; failure/restart behavior remains unverified until implementation tests.
- Unknowns: actual rollup sizes/rates, phone battery/background constraints, deployed proxy buffering, middleware deadline support, measured cap/deadline suitability. None warrants replacing the simple design now.
- **Operator decisions required before build: zero** under stated additive scope and existing persistence/downgrade posture. If transparent old-binary downgrade is a protected requirement, stop and revisit O4 versus O6 before writes; no such requirement was supplied.
- Next recommended command, **DO-NOT-EXECUTE in this pass**: `/draft-plan Implement only Slice 1 from tmp/agent-runs/android-push-20260928/stream-readstate-brief.md; preserve scope and verification gates; hold implementation for approval.` Slice 2 follows separately.
- No implementation, runtime performance, test pass, or deployed proxy outcome is claimed. The brief is a proposal, not transition authority.
