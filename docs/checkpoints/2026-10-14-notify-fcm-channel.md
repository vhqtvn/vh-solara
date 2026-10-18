# FCM Channel for vh-agent-pulse (`/vh/notify/*`) — Durable Checkpoint Record

Date: 2026-10-14  
Scope: Durable record of the `/vh/notify/*` FCM notification channel implementation for the `vh-agent-pulse` Android companion client (cross-repo contract v2).  
Commits on `main`:
1. `70607590b16ba87ba59560f1df8cb83af28344c2` — feat(alerts): /vh/notify slice 1 — notice history ring + FCM token registry
2. `26cd6add163e4d4c9fe62f98f4d597e9cf417b45` — feat(alerts): /vh/notify slice 2 — FCM HTTP v1 sender + gated dispatch
3. `c2bf5c26078da14fff311fb3d0f6b18f38c4db57` — feat(alerts): /vh/notify slice 3 — real-wiring lifecycle test, deferred units, UNREGISTERED top-level fix, v2 contract doc

Release posture: 3 unpushed local commits on `main` awaiting operator release decision (tag-driven release).

---

## 1. Architectural Decisions & Channel Posture

- **FCM Transport Choice:** Firebase Cloud Messaging (FCM) HTTP v1 data-only messages selected for the `vh-agent-pulse` Android companion client over Web Push. Web Push remains active for browser subscribers; FCM complements it as a background/native push channel.
- **Reconciliation Truth vs. Best-Effort Push:** The daemon-resident notice history ring (`GET /vh/notify/history`, capacity 500) serves as ground truth for notification state and client reconciliation. FCM push delivery is explicitly best-effort (no persistent retry queue or backoff loop).
- **Attendance Gating Mirroring Web Push:** Attendance suppression applies identically across delivery channels. If ANY device emits an active presence heartbeat within `detect.idle_sec`, ALL FCM pushes to ALL devices are suppressed. The active/foreground application handles presentation; FCM is reserved for away/idle states.

---

## 2. Confirmed Contract Points (v1 → v2)

Settled cross-repo contract points confirmed between `vh-solara` and `vh-agent-pulse` (`docs/architecture/notify-fcm.md`):

1. **`Notice.Kind` Permission vs. Question Distinction:** Waiting notices carry an explicit sub-kind captured at the engine emission site (`permission.asked`/`permission.updated` → `permission`; `question.asked` → `question`). Blended/ambiguous fallbacks (`input_pending`) were avoided. Surfaces downstream in push data as `vh_condition: permission_pending | question_pending`.
2. **`finished` → `vh_condition=session_unread`:** Client-confirmed naming convention where root-turn completion events arrive as `vh_event=finished` with `vh_condition=session_unread`. Client review counts derive strictly from `session_unread`.
3. **`vh_count="1"` Constant:** Push payloads never aggregate counts in v2; `vh_count` is fixed to `"1"`. The client computes totals from fleet status and history reconciliation.

---

## 3. Confirmed Interpretation Behaviors & Reconciliation Algorithm

### Confirmed Interpretation Behaviors
- **503-before-400:** Channel availability check precedes payload validation; unconfigured channels return 503 even for malformed requests.
- **`lastId` Head-Pointer:** `lastId` represents the highest notification ID ever allocated (persisted counter across restarts), not the highest ID in the returned page; it may exceed returned IDs after ring eviction.
- **Ascending Paging:** Forward pagination with `since > 0` returns events where `id > since` in strictly ascending order, capped at `limit` (max 200).
- **64-Rune Label Bounds:** Device token labels are truncated to 64 Unicode runes (not bytes), without raising an error.
- **Query Validation:** Negative or non-numeric `since`/`limit` parameters return 400 (`bad since` / `bad limit`).

### Client Reconciliation Algorithm
- **Page Forward:** Client queries `since = <last received id>` in successive pages until the highest received ID equals `lastId`.
- **Cursor Update:** Client advances durable `cursor = lastId` ONLY after catching up completely; jumping ahead skips limit-capped middle events.
- **Gap Detection:** If a response begins at an ID greater than `cursor + 1`, intermediate events were evicted from the 500-entry ring. History gaps are unrecoverable by design: client drops incremental delta processing and triggers a full fleet-status refresh.

---

## 4. Review Saga & Pruning Invariant (Round-1 BLOCK Resolution)

- **Round-1 BLOCK on Bare 404 Pruning:** Initial implementation pruned device tokens on HTTP 404 responses from FCM. Review identified that FCM returns 404 for project-level / sender misconfigurations (e.g., incorrect or deleted Firebase project ID). Unconditional 404 pruning would catastrophically erase all registered device tokens across the fleet.
- **UNREGISTERED Evidence Invariant:** Pruning was gated strictly on explicit `UNREGISTERED` evidence in the FCM error body:
  - `error.details[].errorCode == "UNREGISTERED"`, OR
  - top-level `error.status == "UNREGISTERED"`.
- **Validation:** Pinned red→green test cases verify that generic 404 NOT_FOUND retains registrations, while explicit UNREGISTERED responses (on 400 or 404) trigger immediate registry pruning.

---

## 5. Unresolved Open Item — Controller Route Ownership

- **Host Interceptor Interception:** `pkg/server/daemon.go:434-469` (`hostInterceptor`) currently intercepts all `/vh/notify/*` paths — including worker-subdomain traffic — and routes them to a pre-existing controller-level notification surface (the 2026-09-28 controller notify program with distinct schema and storage).
- **Validation Scope:** Current verification and test coverage of this contract are worker-local (direct worker daemon port or raw tunnel proxy).
- **Pending Decision:** Client architectural decision pending on whether `vh-agent-pulse` connects worker-direct or via the central controller URL. Controller-mediated routing requires a server-side route-ownership / proxy modification in `pkg/server/daemon.go`.

---

## 6. Open Follow-Ups (Trigger-Gated / Advisory)

1. **Gate Defer F2 (Test Assert Tightening):** `tests/integration/notify_lifecycle_test.go` helper `jsonHasNotificationBlock` inspects the JSON envelope root rather than nested `message.notification`. Must be repaired before citing that assertion as behavioral-completion evidence.  
   *Trigger:* `always_before(claiming behavioral completeness on mock notification suppression)`.
2. **Advisory (Lifecycle Test Scaffold):** Pre-existing unstopped aggregator in `tests/integration/opencode_lifecycle_test.go:63` reads swapped `http.DefaultTransport` if integration tests run concurrently.  
   *Trigger:* `path_touched(tests/integration/opencode_lifecycle_test.go)`.
3. **Comment Advisory:** `pkg/alerts/notify.go:~466` comment slightly over-specifies the exact top-level UNREGISTERED error structure.  
   *Trigger:* `path_touched(pkg/alerts/notify.go)`.

---

## 7. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Slice 1 commit reachable on main | `git rev-parse --verify 70607590b16ba87ba59560f1df8cb83af28344c2` | yes |
| Slice 2 commit reachable on main | `git rev-parse --verify 26cd6add163e4d4c9fe62f98f4d597e9cf417b45` | yes |
| Slice 3 commit reachable on main | `git rev-parse --verify c2bf5c26078da14fff311fb3d0f6b18f38c4db57` | yes |
| Canonical v2 contract doc committed | `git cat-file -e HEAD:docs/architecture/notify-fcm.md` | yes |
| Alerts package unit tests passing | `git log -1 --format=%B c2bf5c26` ("pkg/alerts 67/67") | yes |
| Web package full test suite passing | `git log -1 --format=%B c2bf5c26` ("pkg/web full ok (139.8s)") | yes |
| Lifecycle integration test stable | `git log -1 --format=%B c2bf5c26` ("TestNotifyLifecycleThroughRealInitAlerts PASS 0.36s, stable -count=5") | yes |
| Local branch ahead of origin/main by 7 (3 unpushed notify commits) | `git status` ("ahead of 'origin/main' by 7 commits") | yes |

---

## 8. Findings

- **FCM Data-Only Payload**: The Android client uses data-only payloads (`vh_kind`, `vh_event`, `vh_condition`, `vh_count`, `vh_ts`) and manages presentation locally without relying on FCM `notification` blocks.  
  *source:* `docs/architecture/notify-fcm.md §3.3`, *confidence:* high, *type:* fact
- **Token Pruning Invariant**: Pruning only upon explicit `UNREGISTERED` error detail prevents fleet-wide registration drops during misconfigured project ID events.  
  *source:* `pkg/alerts/notify.go`, commits `26cd6add` and `c2bf5c26`, *confidence:* high, *type:* fact
- **Cross-Repo Reconciliation Model**: Ring buffer pagination with monotonic `lastId` head pointers guarantees gap detection when history overflows.  
  *source:* `docs/architecture/notify-fcm.md §5`, *confidence:* high, *type:* fact
- **Controller Route Shadowing**: `/vh/notify/*` is captured by `pkg/server/daemon.go:434-469`, meaning controller-proxied worker notifications require server router intervention before non-LAN deployment.  
  *source:* `pkg/server/daemon.go`, `docs/architecture/notify-fcm.md §7`, *confidence:* high, *type:* fact
- **Release Status**: Slices 1–3 are committed to local `main` only, awaiting an operator-driven tag release.  
  *source:* `git status`, *confidence:* high, *type:* fact

---

## 9. Contradictions

<!-- List any contradictions encountered, or "None detected." -->
None detected.

---

## 10. Addendum: §7 settled (2026-10-14)

The open item in §5 above (and `docs/architecture/notify-fcm.md` §7) regarding controller route ownership and client network path was settled on 2026-10-14:

- **Settled Network Path:** V1 is **DIRECT-TO-WORKER**. `vh-agent-pulse` reaches the worker daemon directly (on-LAN, or via the operator's existing tunnel/VPN to the worker host off-LAN). Worker-local auth (session cookie + `X-VH-CSRF: 1`) is preserved without modification.
- **Controller Proxy Deferred:** No controller-mediated access in V1; the server-side route-ownership / proxy change in `pkg/server/daemon.go:434-469` is explicitly deferred, not abandoned.
  - *Rationale:* FCM delivers independently of daemon reachability (Google → phone). The client's on-push flow degrades gracefully by design: it renders immediately from payload, reconciles history/fleet when the worker is reachable, and renders staleness indicators otherwise. A controller proxy adds no critical value for V1.
- **Conditions if No-VPN Off-LAN Reconciliation Is Ever Requested:**
  1. *Clean partition:* The proxy must not disturb the pre-existing controller notification surface (`pkg/server/daemon.go:434-469` remains intact).
  2. *Auth compatibility:* Auth must remain worker-compatible (cookie + CSRF semantics), or a client auth-mode extension must be defined.
  - *Discipline:* Size and implement this only when the client explicitly asks.
- **Release Posture & Contract Settlement:** The client confirmed untagged release on `main` is acceptable now; integration will target the first tagged release (`v*`) once published. The v2 contract is now settled on both sides (`vh-solara` and `vh-agent-pulse`).

---

## 11. Addendum: v3 Contract Extension (2026-10-18)

Durable record of the v3 `/vh/notify/*` changes (client-approved cross-repo contract extension with `vh-agent-pulse`).

Commits on `main`:
1. `16ff64a63462afa93dcba947cd28a83232646113` — feat(alerts): /vh/notify v3 slice A — per-token push policy + FCM send-failure observability
2. `a1e82aded347bb6cf484f3d91a66641217b0e7a8` — feat(alerts): /vh/notify v3 slice B — session_started notice + v3 contract-doc bump

Release posture: 2 more unpushed local commits on `main` (total unpushed on `main` includes v2 + refactors/docs + v3; operator release decision pending; client targets a tagged `v*` release).

### 11.1 Motivation (The Push-Absence Diagnosis)

Real-world operator runtime diagnosis with `vh-agent-pulse` identified three concrete causes for missing pushes and observability black holes:
1. **Attendance Suppression Dominance:** The primary cause of push absence was attendance suppression triggered by the operator's open desktop web tab. Active presence heartbeats within `detect.idle_sec` suppressed all FCM pushes across all registered devices. When an operator stepped away from their desk carrying only their phone, notifications were silenced because the workstation tab was still marked "attending".
2. **Session Start Event Coverage Gap:** Notifications only fired on waiting prompts or completed turns. When an agent began work on a root session, no notice was emitted, leaving the companion app unaware that a turn was in progress until completion or manual refresh.
3. **Total Send-Failure Silence:** FCM dispatch errors (OAuth token refresh failures, 401s, 429 rate limits, 5xx server errors, network/transport drops) failed silently with zero daemon logging, leaving operators with no diagnostic path when notifications did not arrive.

### 11.2 The Three Changes Landed

1. **Per-Token `push_policy` (`when_unattended` | `always`, default `when_unattended`):**
   - In `pkg/alerts/tokens.go` and `pkg/web/notify_feature.go`, `POST /vh/notify/tokens` accepts `push_policy` (`when_unattended` | `always`, defaulting to `when_unattended` for full backward compatibility with older payloads and existing `notify-tokens.json` registries).
   - Attendance suppression is evaluated per-token rather than globally across the channel: attendance suppresses delivery only for `when_unattended` tokens; `always` tokens deliver regardless of attendance (mirroring webhook `channel_policy: always` semantics). Cooldown is evaluated per `(type, tokenHash)`.
2. **FCM Send-Failure Observability & Probe Fields:**
   - In `pkg/alerts/notify.go`, structured log lines report each failure class (OAuth, 401 exhaustion, 5xx retry exhaustion, 429 rate limit, 400/404 including UNREGISTERED pruning, transport drops).
   - Device tokens are identified only by label or 32-hex SHA-256 hash prefix, never the secret token value.
   - A periodic ~10-minute channel-health summary line is wired into `InitAlerts` (`pkg/web/alerts_feature.go`), and additive `Logger()` / `SetLogger()` wiring was added.
   - The probe route (`GET /vh/notify/probe`) reports policy token counts (`policies.when_unattended`, `policies.always`), send counters, and channel-level `last_attempt` / `last_error`.
3. **`session_started` Notice Detector & Contract Bump:**
   - In `pkg/alerts/engine.go` and `config.go`, a 20-second sweep detector tracks running root sessions. The first sweep baselines silently (no fire on daemon boot for pre-existing running sessions); count increases fire one notice carrying the first new root (once-per-increase; restarting a stopped root fires again).
   - Shape: `vh_condition=session_started`, NORMAL priority, `collapse_key=session_started`, `vh_count="1"`. All-channel visibility is documented, noting profile types filtering caveats.
   - Canonical server contract `docs/architecture/notify-fcm.md` bumped to v3 (settled 2026-10-18).

### 11.3 Observable Rulings

- **Full-State POST Policy Reset:** `POST /vh/notify/tokens` treats the body as the complete desired state of the token registration. A re-POST of an existing token *without* `push_policy` explicitly resets that token to `when_unattended`. Clients must send `push_policy` on every update to retain `always`.
- **Latest-Completed-Attempt Probe Semantics & Zero State:** Probe fields `last_attempt` and `last_error` reflect the latest *completed* attempt, not initiation. They are published as a pair under `statMu` upon attempt completion. If the latest completed attempt succeeded, `last_error` is cleared to `""`. Before any completed attempt has run, both fields are `""` (empty strings).

### 11.4 Review Saga & The b-F1 Lesson

- **Slice A:** Approved on first pass with 3 non-gating DEFER advisories (all closed in slice B).
- **Slice B Round-1 BLOCK (b-F1):** The commit reviewer blocked slice B on `contract_drift`: `docs/architecture/notify-fcm.md` promised latest-completed-attempt semantics, but the implementation updated `lastAttempt` at send initiation while writing `lastError` at send completion. Under concurrent or overlapping sends, this permitted a race where `last_attempt` reflected a newer in-flight send while `last_error` reflected an older completed send.
- **Resolution:** `lastAttempt` and `lastError` publication was unified under `statMu` at attempt completion, paired with a deterministic overlapping-send test `TestNotifierOverlappingAttemptsProbePairing` (verified with a red-check proof to catch split updates, run under `-race -count=5`). Round 2 received unanimous 4/4 approval.
- **The b-F1 Lesson:** Contract-doc-bump slices must actively verify new canonical semantics against the actual code implementation before landing. Reviewers must scrutinize the doc-code boundary for subtle timing and lifecycle contract divergences.

### 11.5 Open Trigger-Gated Follow-Ups

1. **Integration Test Wall-Clock Margins:** The 20s-ticker integration test `TestNotifySessionStartedSweepToFCM` in `tests/integration/notify_lifecycle_test.go` uses real time (~40s run); under heavy CI contention wall-clock margins could theoretically flake.  
   *Trigger:* route to DEFER curation only if it fires in CI.
2. **Comment Drift in `pkg/web/notify_feature.go:77`:** Comment states `"empty before any attempt"` instead of `"empty before any completed attempt"`.  
   *Trigger:* align when `pkg/web/notify_feature.go` is next legitimately touched.
3. **`SetLogger` Unsynchronized-Write Advisory:** `SetLogger` in `pkg/alerts/notify.go` performs a plain pointer write (safe today as it is invoked during single-threaded boot/init and tests).  
   *Trigger:* harden with atomic pointer if it ever gains dynamic production callers.
4. **Timeout Failure-Class Test Coverage:** Add dedicated timeout simulation coverage before claiming timeout failure observability is fully tested.  
   *Trigger:* `always_before(claiming complete timeout failure-class test coverage)`.
5. **Web `session_started` Types/Labels:** Web frontend TypeScript union and display labels for `session_started` to be added when a web slice next touches notification types.  
   *Trigger:* `path_touched(web/src/types/*)` or web notification UI changes.

### 11.6 Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Slice A commit reachable on main | `git rev-parse --verify 16ff64a` | yes |
| Slice B commit reachable on main | `git rev-parse --verify a1e82ade` | yes |
| Canonical v3 contract doc committed | `git grep -n "contract — v3 (2026-10-18)" docs/architecture/notify-fcm.md` | yes |
| Full pkg/alerts test suite green | `git log -1 --format=%B a1e82ade` ("pkg/alerts ok 6.67s") | yes |
| Full pkg/web test suite green | `git log -1 --format=%B 16ff64a` ("pkg/web ok 134.8s") | yes |
| Integration test with 20s ticker green | `git log -1 --format=%B a1e82ade` ("TestNotifySessionStartedSweepToFCM ... ok") | yes |
| Overlapping attempts -race test stable | `git log -1 --format=%B a1e82ade` ("-race -count=5 on the new overlapping-attempts test passes") | yes |
| Local branch ahead of origin/main by 5 | `git status` ("ahead of 'origin/main' by 5 commits") | yes |

### 11.7 Findings

- **Per-Token Push Policy Decoupling**: Evaluating attendance per-token allows companion mobile clients on `push_policy: always` to receive alerts even when a desktop web session is active, eliminating the dominant cause of missed alerts.  
  *source:* `pkg/alerts/tokens.go`, `pkg/alerts/notify.go`, commit `16ff64a`, *confidence:* high, *type:* fact
- **Send-Failure Diagnostic Visibility**: Categorized log lines with masked token identifiers provide actionable operational debugging without secret leakage.  
  *source:* `pkg/alerts/notify.go`, commit `16ff64a`, *confidence:* high, *type:* fact
- **Probe State Pairing Invariant**: Publishing `last_attempt` and `last_error` together under `statMu` at attempt completion ensures probe consumers never observe mismatched attempt timestamps and error messages under concurrency.  
  *source:* `pkg/alerts/notify.go`, commit `a1e82ade`, *confidence:* high, *type:* fact
- **Release Status**: Slices A and B are committed to local `main` only (`16ff64a`, `a1e82ade`), awaiting operator tag-driven release.  
  *source:* `git status`, `git log`, *confidence:* high, *type:* fact

### 11.8 Contradictions

<!-- List any contradictions encountered, or "None detected." -->
None detected.
