# Queue-Delivery Caveat Closure Arc — Durable Verification Record

Date: 2026-10-13  
Scope: Durable record of the queue-delivery Sending-chip verification arc and caveat closure.  
Commits on `main`:
1. `90dddad2acc3cfef70f3156819db2073a7b9404c` — Event-driven queue delivery resolution (`queue_delivery_watch` server watcher + frontend `queue-delivery-observed` overlay).
2. `815aca4475c71c5e09d44193b76f1f0c7458b0c7` — End-to-end verification package (`web/playwright.queue-delivery.config.ts`, `web/tests/e2e/queue-delivery-custody.spec.ts`, fixture prompt-hold latch + witness in `pkg/fixtures/opencode.go`, `pkg/web/queue_subscriber_lifecycle_test.go`).
3. `357ae4decc7ca7f9fa5b442da75e84cb905cdd5c` — Makefile target `test-queue-delivery-headed-docker` providing headed-in-Docker execution under Xvfb inside the pinned Playwright image.

---

## 1. Original Caveat and Decomposition

Commit `90dddad2acc3cfef70f3156819db2073a7b9404c` fixed the 30-second stuck "Sending…" chip in daemon-dispatch mode by resolving items early upon observing user-message persistence on the live event stream. Its closeout carried an explicit honesty caveat:

> Crux proven only at state-pipeline (Go) and FE-dispatch (unit) level; not demonstrated in a real browser end-to-end; aggFor/reload wiring seam untested directly.

The caveat decomposed into two distinct gaps:
- **O4 (Subscriber Lifecycle Seam Gap):** Shared subscriber installation from `aggFor` (delivery watcher + session-error sibling), per-project isolation, reload retirement and reinstallation on replacement stores, and clean shutdown joining were unexercised across real `aggFor` callers.
- **O3 (Browser Custody & Live-Clearance Gap):** Real user gesture (textarea input + Send click), daemon custody acquisition, frozen nonterminal browser queue reads, live SSE event delivery, and visual clearance of the Sending chip prior to the 30s stale deadline were not demonstrated in a real headed browser.

---

## 2. Closure of Gap O4 (Shared Subscriber Lifecycle)

Commit `815aca4475c71c5e09d44193b76f1f0c7458b0c7` closed gap O4 via `pkg/web/queue_subscriber_lifecycle_test.go`:
- Real `aggFor` callers install both siblings (delivery watcher and session-error signal) for default and nondefault project dirs.
- Functional proof on real event stream: delivery resolves custody item to `sent` with exact watcher detail; `session.error` updates detail only on uncertain items without state escalation.
- Project isolation: events on dir A never leak into or resolve items in default or sibling project stores.
- Real HTTP `POST /vh/reload-project` retires old store subscribers, resets install guards, preserves default project guards, and allows subsequent `aggFor` to reinstall active watchers on the replacement aggregator.
- `Server.Shutdown` retires nondefault installations and joins subscriber goroutines while preserving process-owned default guards.
- Verified with `go test ./pkg/web/ -run TestQueueSubscriberLifecycle -count=2 -race` (passed, race-clean).

### O4 Behavioral Closure Token (As Committed)

```behavioral-closure
verdict: proven
result: proven
path: "aggFor -> installQueueDeliveryWatcher + installQueueSessionErrorSignal sibling lifecycle (default/nondefault install, functional effect, isolation, reload retirement+reinstall, Shutdown join)"
verifier: "pkg/web/queue_subscriber_lifecycle_test.go"
command: "go test ./pkg/web/ -run '^TestQueueSubscriberLifecycle' -count=2 -race"
```

---

## 3. Closure of Gap O3 (Browser Custody Delivery Receipt)

Closing gap O3 required a real browser driving an end-to-end send under daemon custody.
1. In `815aca4475c71c5e09d44193b76f1f0c7458b0c7`, the test infrastructure landed:
   - Dedicated config `web/playwright.queue-delivery.config.ts`: pinned to `127.0.0.1:8098`, fresh repo-local dirs (`tmp/queue-delivery-e2e/`), probe-guarded wipe, Chromium only, workers: 1, retries: 0, serviceWorkers blocked.
   - Dedicated spec `web/tests/e2e/queue-delivery-custody.spec.ts` (excluded from ordinary discovery via `testIgnore`).
   - Fixture latch `pkg/fixtures/opencode.go`: prompt-hold latch parks upstream before persistence and event emission; witness records arrivals and persisted IDs preserving duplicates.
   - Initial run passed headless, but headed execution was unavailable on the bare host (no XServer); receipt was recorded honestly as `not-demonstrable` at that commit.
2. In `357ae4decc7ca7f9fa5b442da75e84cb905cdd5c`, `Makefile` added `test-queue-delivery-headed-docker`:
   - Runs headed under `xvfb-run --auto-servernum` inside `PLAYWRIGHT_IMAGE` (`mcr.microsoft.com/playwright:v1.60.0-noble`).
   - Configured with `--network=host` (serializes pinned port 8098 contention with probe-guard), `--ipc=host` (headed Chromium shm), and host Go bootstrap mount with `GOTOOLCHAIN=auto` and persistent caching under `tmp/queue-delivery-e2e/`.
   - Result: **1 passed (11.7s), exit 0**.
   - Daemon custody acquired (`claimGeneration > 0`); Sending chip cleared **680ms** after raw `dispatchStartedAt` (correlation ID `msg_1312d71e50010AVOFFq5v0URtE`, item `q-9819468ad0492452`), well within the unchanged 30,000ms stale deadline.
   - Browser queue GETs remained frozen on the dispatching snapshot throughout; watcher detail reached `sent` with exact delivery message; upstream witness confirmed exactly 1 arrival and 1 persisted message; zero confounds (no browser claim/resolve/direct-send, no main-frame navigation, no SSE reconnect).

### O3 Behavioral Closure Token (As Committed)

```behavioral-closure
verdict: proven
result: proven
path: "real browser Send -> daemon custody claim -> held upstream persistence -> live SSE delivered event -> Sending chip clearance with frozen nonterminal browser queue reads"
verifier: "web/tests/e2e/queue-delivery-custody.spec.ts via make test-queue-delivery-headed-docker"
command: "make test-queue-delivery-headed-docker ARGS='--reporter=list,json'"
interaction_touching: true
interaction_action: "Type unique message in composer textarea and click Send button"
interaction_target: "Visible Sending chip in queue row clears promptly upon receiving live message.upsert/updated event"
interaction_environment: "Headed Chromium under Xvfb (mcr.microsoft.com/playwright:v1.60.0-noble), fixtureserver -daemon-dispatch, built production SPA, fake OpenCode upstream with prompt-hold latch"
interaction_verifier: "xvfb-run npx playwright test --config=playwright.queue-delivery.config.ts --project=chromium --headed --workers=1 --retries=0"
interaction_tree: "commit 357ae4decc7ca7f9fa5b442da75e84cb905cdd5c on main"
interaction_outcome: "Held state observed with visible Sending chip; live event received; chip cleared at 680ms from dispatchStartedAt (<30s deadline); browser queue GETs frozen dispatching; raw queue.json sent with deliveredSentDetail; 1 upstream arrival + 1 persisted; no reload/reconnect/claim confounds"
interaction_evidence: outcome
```

### O3 Required Limits & Xvfb Residuals

The O3 receipt establishes real-process browser delivery under controlled stale browser queue reads. The following explicit limits and residuals remain attached to this proof:
1. **Virtual Display Residual:** The test executed under Xvfb (a virtual in-memory framebuffer). It was not rendered to a physical monitor or GPU.
2. **Toolchain Environment:** In-container toolchain `go1.26.9` executed the fixtureserver via `GOTOOLCHAIN=auto` against the host Go 1.25.13 bootstrap mount (same source tree).
3. **Boundary Limits:** Upstream OpenCode is a fixture simulating the protocol in memory. The test does not establish production CLI startup, real OpenCode disk/directory interoperability, restart-barrier certification, background/hidden-tab delivery, controller-tunnel/auth behavior, or general crash-recovery/ordering/retry/exactly-once guarantees across arbitrary faults.

---

## 4. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Fix commit landed & reachable on main | `git merge-base --is-ancestor 90dddad2acc3cfef70f3156819db2073a7b9404c main` | yes |
| Verification package landed & reachable on main | `git merge-base --is-ancestor 815aca4475c71c5e09d44193b76f1f0c7458b0c7 main` | yes |
| Headed docker target landed & reachable on main | `git merge-base --is-ancestor 357ae4decc7ca7f9fa5b442da75e84cb905cdd5c main` | yes |
| Subscriber lifecycle tests green | `go test ./pkg/web/ -run '^TestQueueSubscriberLifecycle' -count=2 -race` | yes |
| Headed Xvfb run green (1 passed, 11.7s) | `tmp/queue-delivery-e2e/report.json` (exit 0, elapsed 680ms, 1 test passed) | yes |
| Dedicated spec excluded from ordinary discovery | `npm --prefix web run test:e2e -- --list` (queue-delivery-custody.spec.ts absent) | yes |

## 5. Contradictions

None detected. The decomposed verification requirements (O3 browser receipt + O4 subscriber lifecycle) were satisfied and receipted in commits `815aca44` and `357ae4de`.
