# Controller-Hub Notify Program v4 — Durable Checkpoint Record

Date: 2026-10-22  
Scope: Durable record of the controller-hub notification program (v4) implementation — centralizing Firebase Cloud Messaging (FCM) in the central controller daemon while preserving workers as the sole detection authority (`docs/architecture/notify-controller-hub-brief.md` and `docs/architecture/notify-fcm.md` v4).  
Commits on `main` (S0–S5, local main, NOT pushed, NOT released):
1. `56c7ccbf4db5f8b70cbd0695cf9ee9e6c5445090` — docs(notify): freeze v4 controller-hub contract + lane-1 golden wire fixtures (S0 part 1)
2. `a68df07bd196b0266e7eaee070e515bb5c8ef8ca` — docs(notify): promote controller-hub design brief to docs/architecture/ (S0 part 2)
3. `2b6f71ac8e7547acfcd6a8d830568682f42203e5` — feat(alerts): S1 durable worker source + startup FCM fence + v4 public DTO
4. `39619cef2c453960da9c01ca848bd12d1a18010c` — feat(notify): S2 worker notify enrollment + isolated private feed + watermark-ACK groundwork
5. `d905ac0e0eed13407139b27ce059464f34f4a4e5` — feat(notify): S3 controller pull loop + central transactional ledger
6. `7aade356c62909ae9a6c4e97d47cfdf6d67409c7` — feat(notify): S4 controller v4 token registry + central FCM dispatch
7. `565f5bbfd2e41decc40a20afde44b2c1bc012495` — feat(notify): S5 public central history + watcher retirement + admin completion — controller-hub cutover complete

Release posture: All S0–S5 commits landed on local `main` awaiting operator release decision (tag-driven release; not pushed).

---

## 1. Decision Chain & Pre-Implementation Gates

- **Initial Brief (Approved 2026-10-21):** Established the controller-pull architecture (`docs/architecture/notify-controller-hub-brief.md`). Workers remain the sole detection authority; the controller owns fleet-wide registration, merged history, and FCM delivery. One controller URL covers all workers; credentials stay central; workers detect and spool locally.
- **Timestamp Gate Failure (`ts-gate FAIL`):** During pre-implementation verification, the proposed numeric timestamp `ts: 1792454400000` was run against the upstream `vh-agent-pulse` parser. Pulse's `SolaraHistory.kt` decoder uses Kotlinx serialization in strict mode expecting string representation (`ts: String?`). The numeric JSON token failed parsing with an unrecoverable decoding exception.
- **Debate Resolution (Position C):** A debate on timestamp compatibility rejected silent type divergence. Position C was adopted: public history `ts` is formatted as a **decimal string of epoch milliseconds** on BOTH public surfaces (controller central history AND worker fallback public history), while internal in-memory representations and the worker's private feed retain numeric representations.
- **S0 Contract Freeze (`56c7ccbf`, `a68df07b`):** Pinned the v4 contract in `docs/architecture/notify-fcm.md` and created machine-checked golden wire fixtures under `pkg/server/testdata/notify_v4/` validated by `pkg/server/notify_v4_fixture_test.go` (string `ts`, contiguous IDs, condition vocabulary authority).
- **Execution Slices (S1–S5):** Progressive delivery of worker durable spooling (S1), authenticated private feed & enrollment (S2), controller pull loop & transactional ledger (S3), token registry & central dispatch (S4), and public history, watcher retirement & admin completion (S5).

---

## 2. Architecture as Landed

The completed v4 pipeline establishes clean separation of responsibilities across workers and controller:

```
[Worker Session / Engine]
       │ (detects waiting/finished/etc.)
       ▼
[SourceSpool (epoch, seq)]  ──(append failure / unreadable preserve: fail-closed)
       │
       ▼ (authenticated private feed GET /vh/internal/notify/feed)
[Controller Pull Loop] (workerHTTPBounded over yamux, 3s poll, bounded concurrency)
       │
       ▼ (atomic line commit: events + dedupe + source state)
[Transactional JSONL Ledger (<notify-store>.ledger)]
       │
       ▼ (EventsAfter drain, detection-time attendance snapshot, 24h freshness, persisted cooldown)
[Central Dispatch Ladder] ──(RegGen-fenced UNREGISTERED prune)──► [v4 Token Registry (<notify-store>)]
       │
       ▼
[Central FCM Sender (FCMTransport)] ──► Google FCM HTTP v1 ──► [Android Phone (Pulse)]
```

### Component Architecture Details

1. **Durable Worker Source (`SourceSpool`, S1):**
   - Uses `(epoch, seq)` monotonic identity persisting across daemon restarts. Epoch rotates ONLY on genuine corruption or loss with witness.
   - Preserves unreadable files (`preserveFile` flag): if permissions or symlinks fail, no new epoch is minted, pre-writes are skipped, and existing state is protected from overwrite.
   - Correlation keys: `(SpoolEpoch, SpoolSeq)` are assigned before ring publication; `Kind` is retained unconditionally.
   - Startup FCM fence: Worker in controller mode (non-empty `--controller` default) starts with local FCM disabled before tunnel establishment. Standalone escape (`--controller ""`) remains supported.

2. **Authenticated Private Feed & Enrollment (S2):**
   - Private feed at `GET /vh/internal/notify/feed` guarded by per-process 32-byte crypto-random bearer tokens negotiated during tunnel registration.
   - Public route denial: private feed is blocked from worker-host, controller-main, and worker-subdomain public endpoints.
   - Enrollment message `NotifyEnrollment` on `RegisterMessage` requires authenticated registration (`RegSecret` set); unauthenticated workers are marked explicitly ineligible for central notifications.
   - Bounded transport with single-snapshot mutex locking preventing cursor-advance race conditions.
   - Watermark ACK (`POST /vh/internal/notify/ack`) allows monotonic, idempotent trimming of acknowledged spool records.

3. **Controller Ingest & Transactional JSONL Ledger (S3):**
   - Ledger file at `<notify-store>.ledger`: one ingested page = exactly ONE fsync'd JSONL line containing events, dispatch intents, and post-commit source cursors.
   - Strictly contiguous central IDs (`1..head`).
   - Fail-closed replay grammar: missing/corrupt files fail loud; `CommitPage` validates interval coverage (`explainIntervalHoles`) ensuring no unexplained gaps occur within an epoch.
   - Write-mirrors-replay invariant: write validation enforces all replay constraints before disk mutations, preventing lines the replay parser would reject.
   - Feed response origin and epoch are validated inside `fetchPage` before durable write; foreign pages mutate nothing.

4. **Central Token Registry & Dispatch Ladder (S4):**
   - Central token registry schema 2 with backup-first atomic migration from schema 1.
   - Preserves `push_policy` (`when_unattended` default or `always`).
   - Pruning fence (`RegGen`): Per-registration generation counter re-minted on refresh. Pruning via `deleteIfRegistrationCurrent` prevents in-flight `UNREGISTERED` errors from deleting re-registered or refreshed tokens.
   - Three-writer stop-join in `LoadNotifyStore`: quiesces ingest, dispatch, and legacy writers before reloading to prevent resurrecting pruned tokens.
   - Shared `FCMTransport` extracted from worker alerts to `pkg/alerts/fcm_transport.go` for uniform OAuth2 token exchange, 401 refresh, and 5xx retries.
   - Central dispatch ladder applies: channel enabled → snapshot type-filter → detection-time origin attendance (attended origin suppresses `when_unattended`; `always` bypasses attendance) → freshness (24h default) → central persisted cooldown `(source, type, token_hash)` under `<notify-store>.dispatch` → claim-before-send persistence.

5. **Public Central History, Watcher Retirement & Admin (S5):**
   - Controller serves `GET /vh/notify/history` directly with decimal string `ts`, additive condition/origin metadata (`kind`, `count`, `label`, `worker`, `source`, `ui_url`), and gap coverage.
   - Pinned against lane-1 golden fixtures (`pkg/server/testdata/notify_v4/`).
   - Legacy watcher delivery fully retired and removed; dispatcher is the sole delivery engine.
   - Admin routes moved to `/vh/admin/notify/*` (token CRUD, legacy history inspection, test send); `NotifyDialog` updated to use admin endpoints.

---

## 3. Review Sagas & Gate Catches

Every slice underwent rigorous tiered commit review with multiple gate catches and verified red-receipt fixes:

- **Slice S1 (3 Reviewer Rounds + 3 Gate Rejections):**
  - *Kind Retention:* Initial implementation dropped notice kind on certain ring promotion paths; fixed to preserve kind unconditionally.
  - *Seq Validation:* Sequence numbers were not strictly validated on load; added lastSeq presence/sign and strict monotonicity checks.
  - *Unreadable Preservation:* Inode unreadability (e.g. symlink loop or permission drop) initially risked overwriting existing files with a fresh epoch; resolved by gating fresh initialization strictly on `os.IsNotExist` and arming a `preserveFile` one-way latch that skips writes. Red-checked via `TestSourceSpoolUnreadableButPresentIsPreservedNotReplaced`.

- **Slice S3 (Reviewer Block + 3 Gate Rejections):**
  - *Write-Mirrors-Replay:* Write path accepted event fields that replay validation rejected; aligned write-side checks to mirror replay parser invariants.
  - *Interval Holes:* `CommitPage` did not enforce interval continuity across the entire consumed sequence; added `explainIntervalHoles` requiring explicit gap coverage for any non-contiguous seq ranges.
  - *Identity-Before-Reset:* Feed responses were not validated against source identity prior to durable state mutation; added decode-time origin verification in `fetchPage` ensuring foreign pages cause zero mutations (`TestNotifyIngestWrongSourcePageMutatesNothing`).

- **Slice S4 (3 Reviewer Rounds + 5 Gate Rejections):**
  - *NotifyDialog GET Migration:* Dialog initially queried legacy public endpoints; migrated to masked admin token listing.
  - *Reload-vs-Prune Resurrection:* Store reload could race with an in-flight prune and resurrect a dead token; fixed with `LoadNotifyStore` writer quiescence.
  - *Host Interceptor Admin Carve-Out:* Admin notify routes were shadowed on worker subdomains; added router carve-outs with precedence tests.
  - *Watcher Generation Fence:* Stale `UNREGISTERED` errors from the legacy watcher could prune active tokens; added `RegGen` generation checks to both writers.
  - *Three-Writer Quiescence Join:* Quiescence join in `LoadNotifyStore` lacked watcher coverage; updated to join ingest, dispatch, and watcher loops.

---

## 4. Operator Rollout Notes (Load-Bearing)

Operators deploying v4 must adhere to the following sequence:

1. **Deploy NEW CONTROLLER First:**
   - Configure controller with `--notify-store=<path>`, `--notify-dispatch`, and Firebase service account credentials.
   - If `--notify-dispatch` is omitted, the controller acts in history/registry-only mode (no FCM pushes sent, but history and registration succeed).
2. **Worker Upgrade Fences Local FCM by Default:**
   - Upgrading workers with `--controller` non-empty (the default) **automatically fences worker-local FCM**. Local worker pushes will stop immediately upon upgrade. This is intentional: the controller now delivers.
   - If a worker must run standalone, the operator MUST pass `--controller ""` to keep local FCM enabled. Release notes must highlight this behavior.
3. **Legacy Controller Token Migration:**
   - Existing schema-1 controller tokens automatically migrate to schema 2 with default `push_policy="when_unattended"`.
   - Migration is backup-first and fail-closed: `<notify-store>.bak` is written before updating.
4. **Pulse Companion Reconnect:**
   - Existing `vh-agent-pulse` clients must perform a one-time **Log out → Connect** cycle after controller cutover.
   - This resets client-side cursor state from the legacy worker stream and registers the device FCM token directly with the controller.
5. **Fleet-Condition Aggregate Pushes Retired:**
   - The legacy watcher that pushed aggregated fleet conditions (e.g. "2 sessions need attention") is retired.
   - Notifications are now strictly per-session events (`session_started`, `waiting`, `finished`, etc.) carrying precise worker attribution and deep links.

---

## 5. Defers Register & Open Trigger-Gated Follow-Ups

The following items are deferred with explicit trigger gates:

1. **Probe-Fatal Degraded-Posture Test:**
   - *Scope:* Automated test proving `/vh/notify/tokens` probe reports `enabled: false` with detailed error reason when the central dispatcher is poisoned.
   - *Trigger:* `always_before(claiming complete fatal-posture test coverage)`.
2. **Fresh-Process Controller-Restart Proof:**
   - *Scope:* E2E test exercising restart across independent OS process boundaries (current E2E covers in-process store reload).
   - *Trigger:* `always_before(claiming process-boundary restart completeness)`.
3. **NotifyDialog Worker-Link Real-Browser Click Receipt:**
   - *Scope:* Playwright interaction test verifying clicking a notification item in `NotifyDialog` navigates to the worker session URL.
   - *Trigger:* `always_before(claiming browser interaction completeness for notification dialog)`.
4. **Controller Live State Documentation Refresh:**
   - *Scope:* Clean up stale route references in `docs/architecture/controller-live-state.md` reflecting the new admin and private endpoints.
   - *Trigger:* Next documentation maintenance pass.
5. **Detection-Path Full E2E Coverage:**
   - *Scope:* End-to-end trace from live OpenCode prompt event through worker detection to central FCM delivery in Docker gold lane.
   - *Trigger:* `always_before(claiming full multi-machine gold coverage)`.
6. **Double-Persist-Failure Window Hardening:**
   - *Scope:* Handling scenario where primary and backup storage fail simultaneously during ledger compaction.
   - *Trigger:* `path_touched(pkg/server/notify_ledger.go)`.

---

## 6. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| S0 contract freeze commit reachable on main | `git rev-parse --verify 56c7ccbf4db5f8b70cbd0695cf9ee9e6c5445090` | yes |
| S0 design brief promotion commit reachable on main | `git rev-parse --verify a68df07bd196b0266e7eaee070e515bb5c8ef8ca` | yes |
| S1 worker spool & fence commit reachable on main | `git rev-parse --verify 2b6f71ac8e7547acfcd6a8d830568682f42203e5` | yes |
| S2 enrollment & private feed commit reachable on main | `git rev-parse --verify 39619cef2c453960da9c01ca848bd12d1a18010c` | yes |
| S3 pull loop & ledger commit reachable on main | `git rev-parse --verify d905ac0e0eed13407139b27ce059464f34f4a4e5` | yes |
| S4 registry & dispatch commit reachable on main | `git rev-parse --verify 7aade356c62909ae9a6c4e97d47cfdf6d67409c7` | yes |
| S5 central history & cutover commit reachable on main | `git rev-parse --verify 565f5bbfd2e41decc40a20afde44b2c1bc012495` | yes |
| V4 contract doc committed at HEAD | `git cat-file -e HEAD:docs/architecture/notify-fcm.md` | yes |
| V4 design brief committed at HEAD | `git cat-file -e HEAD:docs/architecture/notify-controller-hub-brief.md` | yes |
| Golden v4 fixtures committed at HEAD | `git cat-file -e HEAD:pkg/server/testdata/notify_v4/history_response_v4.json` | yes |
| S5 Go test suites passing cleanly | Verified in S5 commit receipt (`server 28.4s / alerts 6.8s / web 134.4s / e2e 132.3s / integration 41.7s`) | yes |
| S5 web unit tests passing cleanly | Verified in S5 commit receipt (`web unit 3457 passed + typecheck clean`) | yes |
| Local branch ahead of origin/main by 14 commits (includes S0-S5) | `git status` ("ahead of 'origin/main' by 14 commits") | yes |

---

## 7. Findings

- **Centralized FCM Topology**: Centralizing FCM delivery at the controller simplifies token registration to a single endpoint and allows one Android registration to receive notices from all workers.  
  *source:* `docs/architecture/notify-controller-hub-brief.md`, *confidence:* high, *type:* fact
- **Timestamp Strict-Typing Incompatibility**: Kotlinx serialization in `vh-agent-pulse` rejects numeric JSON numbers for string fields, necessitating string-typed timestamps in v4 public history payloads.  
  *source:* S0 debate Position C and `pkg/server/notify_v4_fixture_test.go`, *confidence:* high, *type:* fact
- **Transaction Line-Commit Pattern**: Formatting ledger pages as single JSONL lines guarantees commit atomicity on POSIX filesystems without requiring external database dependencies.  
  *source:* `pkg/server/notify_ledger.go`, commit `d905ac0e`, *confidence:* high, *type:* fact
- **Generation-Fenced Token Deletion**: Adding `RegGen` generation counters prevents in-flight asynchronous UNREGISTERED responses from erroneously deleting re-registered devices.  
  *source:* `pkg/server/notify_store.go`, commit `7aade356`, *confidence:* high, *type:* fact
- **Worker Local FCM Fencing**: Controller-mode workers structurally disable local FCM at boot to eliminate duplicate or competing push notifications across the fleet.  
  *source:* `pkg/alerts/notify.go`, commit `2b6f71ac`, *confidence:* high, *type:* fact
- **Release Status**: The entire v4 program (S0–S5) is committed to local `main` only, awaiting an operator-driven tag release.  
  *source:* `git status`, *confidence:* high, *type:* fact

---

## 8. Contradictions

<!-- List any contradictions encountered, or "None detected." -->
None detected.
