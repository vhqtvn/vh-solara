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
