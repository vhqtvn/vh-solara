> **Adoption Errata (from Solution Brief):**
> Line 52 / finding F in the original research memo cites "+65% body time in 9 days (388→674.6s)".
> The arithmetic is `(674.6 - 388) / 388 = +73.87%` (~74%), not 65%.
> The remainder of the text below is preserved verbatim as captured in research.

# Test-suite wall-time: where it goes, and ranked options to cut it

> PLACEMENT NOTE: intended durable path is `researches/decisions/test-suite-speed.md`.
> This researcher session's permission layer denies repo-tree writes outside `tmp/`,
> so the memo was captured here. An exec-capable session should `git mv`-style copy
> this file to `researches/decisions/test-suite-speed.md` (unchanged) as part of
> adopting or reviewing it.

Status: draft decision memo (research output — evidence, not policy). Nothing here changes
repo behavior until a maintainer adopts a slice.

## Context

Task: measure where the vh-solara test suite's wall-time actually goes across its lanes
(AGENTS.md → "Testing rules (this repo)", ten lanes), root-cause the slowest tests, and
rank optimization options (remove / re-seam / tighten / split / cache / parallelize).
Scope: PR-blocking lanes 1, 2, 3, 5, 6, 7 (+7b preview). Lanes 4, 8, 9, 10 are
docker-gated or dispatch-only — not run, per task contract.

**Evidence-quality caveat (read first):** this researcher session ran under a read-only
execution policy that denied fresh test execution (`exec` denied; `exec-sandbox` floor
kernel-blocks loopback sockets, so no Playwright/Go-server run was possible; system node
v18 < required 24; system go 1.22 < required 1.26; `gh` denied so no CI timings). Every
number below is therefore **mined from existing measured receipts** (dated logs under
`tmp/agent-runs/`), not re-executed today. Receipts are real full-lane runs on this
repo's own artifacts; dates and trees are stated per row. A fresh re-measurement command
list for an exec-capable session is at the end. Current tree is `4d612ed` (2026-10-31);
the newest full-lane receipts are from 2026-10-09 and 2026-10-18, so current absolute
times are likely slightly higher (growth trend F below).

## Per-lane timing table (all measured; source+date per row)

| Lane | Command | Wall | Body/test time | Measured (source, date, tree) | Count |
|---|---|---|---|---|---|
| 1 Go unit | `go test ./pkg/...` | 129 s | pkg/web alone 112.6 s (fresh) | final-suite report, 2026-10-09, bdf51df; per-pkg 2026-09-18 fresh `go test ./...` log | 20 pkgs |
| 2 Go integration | `go test ./tests/integration/` | 2 s | 0.94 s (pkg time) | final-suite 2026-10-09; 2026-09-18 | small |
| 3 Go e2e | `go test ./tests/e2e/` | 118 s | ok 116.3 s | final-suite 2026-10-09; 37.35 s on 2026-09-18; 17.0 s on 2026-08-10 | 76 Test funcs / 29 files now |
| 5 Web unit (vitest) | `npm --prefix web run test:unit` | 11 s (+3 s typecheck) | tests 39.8 s, collect 58.7 s (parallel) | final-suite 2026-10-09 | 232 files / 3024 tests (273 files now, unmeasured) |
| 6 Web e2e (Playwright) | `npm --prefix web run test:e2e` | 394 s (2026-10-09); **11.7 m** (2026-10-18) | body-sum 388.0/387.8/388.3 s (3 stable runs, 10-09); **674.6 s** (10-18) | final-suite + `tmp/agent-runs/test-speed-study/lane6-pass{1,2}.log`; `full-lane.log` 2026-10-18 | 290 tests (10-09) → **390** (10-18); 84 spec files now |
| 7 host-web e2e | `npm --prefix host-web run test:e2e` | docker 3-engine **983 s**; native 753 s (webkit env-broken) | body 968.7 s docker; per-engine webkit 344.7 / firefox 337.8 / chromium 286.3 s | final-suite 2026-10-09 | 767 lines docker |
| 7b host-web preview | `npm --prefix host-web run test:e2e:preview` | 8 s | — | final-suite 2026-10-09 | 8 tests |
| 8 real-embed (dispatch) | `make test-host-web-real-embed` | 77 s | — | final-suite 2026-10-09 | 26 |
| 9 folded (dispatch) | `make test-host-web-folded` | 74 s | — | final-suite 2026-10-09 | 15 |
| 4 docker gold | `bash tests/e2e-docker/run.sh` | **unmeasurable** (docker-gated; 2026-10-09 attempt was RED: build fail) | — | — | — |
| CI per-job wall | `gh run view` | **unmeasurable** (`gh` denied by session policy) | — | — | — |

Trend rows (same commands, older receipts — all measured):

- `pkg/web` Go tests: 90.0 s (2026-08-10) → 112.6 s (2026-09-18) → 123.7 s (2026-10-09).
- `tests/e2e`: 17.0 s (2026-08-10) → 37.35 s (2026-09-18) → 116.3 s (2026-10-09).
- Lane 6: 290 tests / body 388 s (2026-10-09) → 390 tests / body 674.6 s (2026-10-18)
  — **+65% body time in 9 days**, chromium project 288→370 tests, 383→632 s.

PR critical-path estimate (**inference**, not measured): CI runs the four code jobs on
separate runners, so PR wall ≈ max(go ≈ 129 s + vet, web ≈ 20 s, e2e ≈ 11.7 m + boot +
browser install, host-web-e2e ≈ 16.4 m + npm ci + 3-engine install) → the two Playwright
jobs dominate at roughly 15–20 m each under CI contention. CI contention is real: HEAD
`4d612ed` (2026-10-31) widened a Go test wait 5 s→30 s because CI's parallel load stalls
tickers (run 41155975937), and `e2e-flake-watch.yml` documents flakes that "reproduce
only under CI's heavy/serial load, not in a clean dev run".

Boot overhead split: lane 6's `webServer` (`scripts/fixture-web.sh`) = vite SPA build +
materialize + `go run ./tools/fixtureserver` (compile each invocation), timeout 120 s.
The vite build's cost is **unmeasured in every receipt** (output redirected to
`/dev/null`); the go-run compile is a known per-invocation cost (typically 5–20 s local,
masked in CI by cold cache). Lane 7 boots 3 vite dev servers (30 s timeouts); preview
lane boots 2 reused + one `vite build && preview`.

## Findings (top slow, with root-cause class)

Classes: **A** forced-settle waits (`waitForTimeout`/sleeps) · **B** bound by real
product time budgets (15 s fork bound, 5 s persistence, etc.) · **C** load/soak tests
parked in the PR lane · **D** engine×suite triplication (lane 7, by design) · **E**
per-invocation boot (SPA build + fixtureserver compile + browser install) · **F**
unbounded suite growth · **G** serial-by-design shared fixtures (`workers: 1`).

Slowest individual tests (lane 6, 2026-10-18 measured, per-test durations from
list-reporter receipts):

- **(finding)** multiproject-latency.spec.ts:446 — 48.7 s, one test: source=full-lane.log
  2026-10-18, confidence=high, type=fact. Class **C** (load test in PR lane).
- **(finding)** preferences.spec.ts e-ink notice persistence — 37.3 s: same source. Class
  **B** (title asserts ">5 s" persistence — deliberate real-time budget).
- **(finding)** create-certainty.spec.ts — 17.7 + 16.8 + 8.8 s (3 tests): same source.
  Class **B**; a Go-lane sibling exists (`tests/e2e/create_certainty_test.go`) → also a
  re-seam candidate (inference).
- **(finding)** fork-guard.spec.ts:130 — 17.5 s: same source. Class **B** ("real 15 s
  bound" in title).
- **(finding)** ux.spec.ts:192 — 12.9 s; opencode-down 11.4 s; send-outbox 11.3 s;
  managed 10.6 s; reply-resilience cluster 10.5–11.2 s ×4: same source. Class **B**
  (timed-out-flow/restart budgets).

Slowest spec files (body time / test count):

- **(finding)** lane 6: scroll-follow 83 s/47 (**A** — 13 `waitForTimeout` sites, 11×300 ms
  — plus volume); multiproject-latency 48 s/1 (**C**); preferences 48 s/7 (**B**);
  create-certainty 46 s/5 (**B**); reply-resilience 43 s/4 (**B**, 0 forced waits — real
  budgets); eink-surfaces 34 s/16 (**A** — 11 wait sites); ux 32 s/9; fork-guard 20 s/3;
  zoom-placement 20 s/26; send-outbox-resilience 20 s/9; read-position 18 s/6 (**A** —
  5×600 ms); terminal 17 s/10: source=full-lane.log 2026-10-18, confidence=high,
  type=fact.
- **(finding)** lane 7 (docker, per-spec totals across 3 engines):
  kill-relaunch-persistence 125 s/57; named-layouts 100 s/48; interaction-overlay 91
  s/108; workspace-tabs 65 s/63; viewport-shape 60 s/33; settings 51 s/48;
  flip-animation 47 s/33; layout-persistence 44 s/21 — classes **A/B** per test, all
  paid ×3 engines (**D**): source=hostweb-docker receipts 2026-10-09, confidence=high,
  type=fact.
- **(finding)** lane 1: `pkg/web` is 55 %+ of the Go tree's fresh test time (112.6 s of
  ~205 s, 2026-09-18) and has grown 90→124 s in two months (**F**); the whole Go tree
  uses `t.Parallel()` in only **5 places** — lanes are serial within packages:
  source=2026-09-18 fresh log + grep count, confidence=high, type=fact.
- **(finding)** lane 3 grew 17→116 s in ~2.5 months (**F**; 76 Test funcs, 12
  `StartCluster(` call sites — per-test cluster boot is amortized but nontrivial):
  source=trend receipts, confidence=high, type=fact.
- **(finding)** lane 5 vitest is a non-issue: 11 s for 3024 tests, slowest file 378 ms:
  source=final-suite 2026-10-09, confidence=high, type=fact.
- **(finding)** Go sleep outliers are few: tests/e2e/tree_stream 6 s + 4×300 ms;
  notify_fleetpoke 2×2 s; pkg/web queue_idle_gate 4×500 ms + 2×300 ms; the rest are
  20–300 ms settles: source=static grep 2026-10-31, confidence=high, type=fact.

## Options (ranked; saving/risk/invariant/effort)

Savings are **estimated** from the measured body times above (estimates labeled; none
re-measured). CI-wall savings assume the e2e/host-web jobs are the PR critical path
(inference).

1. **Parallelize pure-logic Go tests (`t.Parallel()`)** — class F/G.
   Add `t.Parallel()` to pure unit tests, starting with `pkg/web/queue_test.go` (56
   funcs, biggest file) and other no-I/O tests in `pkg/web` (112–124 s today).
   Saving: est 40–60 s off lane 1 (and the CI `go` job) if half the package
   parallelizes across CI's 2–4 cores. Risk: low–medium (must verify no shared
   globals/fixtures per file; table-driven pure tests are safe). Invariant: no
   shared-mutable fixture may race — same discipline the 5 existing uses follow.
   Effort: medium (mechanical, per-file audit).

2. **Move class-C soaks out of the PR lane** — class C.
   `multiproject-latency.spec.ts` (48.7 s single test) already has a Go-lane sibling
   (`tests/e2e/multiproject_latency_test.go`, 60 s SSE deadline) proving the API-level
   latency property; the browser test's unique value is perceived-UI latency under
   multi-project load — a soak. Move it to a dispatch/nightly lane (pattern already
   established by lanes 8/9/10) or cut its project count to shrink the soak.
   Saving: est −49 to −60 s lane-6 body (674→~615 s). Risk: medium (latency
   regressions surface nightly, not per-PR). Invariant: serial `workers: 1` preserved;
   Go lane keeps an API-level latency guard per PR. Effort: low (config/tagging).

3. **Cache/prebuild the lane-6 boot chain** — class E.
   `scripts/fixture-web.sh` pays `npm run build` + `go run ./tools/fixtureserver`
   (compile) every invocation. Prebuild the fixtureserver binary once (`go build -o`)
   and reuse a fresh SPA `dist-build` when sources are unchanged (hash guard); keep
   `CI=true` forcing a fresh server. Saving: unmeasured boot fraction — est 20–60 s
   per local invocation, smaller in CI; also make the vite build stop redirecting to
   `/dev/null` so boot cost becomes measurable. Risk: low (stale-build guard must be
   sound — hash the inputs, not timestamps). Invariant: `CI=true` fresh-server
   semantics unchanged; placeholder-guard CI check untouched. Effort: low–medium.

4. **Re-seam duplicate-coverage browser flows to their Go siblings** — classes B/F.
   Candidates (verify overlap before cutting — currently inference from names/lines):
   create-certainty (Go `create_certainty_test.go` + browser spec, 46 s), queue-recovery
   (Go + browser specs), tree-stream (Go + browser). Keep the browser version only for
   what the UI layer uniquely proves (chip state rendering, visual placement); move
   flow-level assertions to the Go lane.
   Saving: est 60–100 s off lane 6. Risk: medium (losing real UI-path coverage if
   overlap is assumed, not verified). Invariant: each moved assertion lands in a
   faster lane explicitly; no coverage silently dropped. Effort: medium.

5. **Test-mode time compression for class-B budgets** — class B.
   The 15 s fork bound, 5 s notice persistence, and reply-resilience timed-out flows
   are the single biggest lane-6 block (~150 s+ combined). Add an opt-in budget scaler
   (e.g. `VH_TEST_TIME_SCALE=0.25`) used by the PR lane, with at least one unscaled
   real-time run kept in a dispatch lane.
   Saving: est 80–120 s off lane 6. Risk: high (a scaled budget no longer proves the
   real-time property — this changes what is proven, so the unscaled dispatch run is
   mandatory). Invariant: PR proves logic; dispatch lane keeps real-time proof.
   Effort: high (product-code test hook, cross-file).

6. **Lane-7 engine strategy** — class D.
   Either (a) shard the 3 engines across 3 parallel CI matrix jobs (wall ÷3, runner
   minutes ×3, zero coverage change — safe parallelism, no shared fixture across
   runners), or (b) PR lane = chromium full + firefox/webkit on the historically
   browser-sensitive subset, full 3-engine nightly.
   Saving: (a) est −650 s PR wall for +2 runners; (b) est −650 s with real deferral
   risk. Risk: (a) low; (b) medium (late cross-browser regressions). Invariant: (b)
   requires the nightly full run to actually exist first. Effort: low (a), medium (b).

7. **Convert class-A forced waits to signal waits** — class A.
   scroll-follow (13 sites), eink-surfaces (11), read-position (10, five 600 ms),
   terminal (5). Replace `waitForTimeout` with event/DOM-condition polls.
   Saving: est 15–40 s off lane 6. Risk: low per-site but broad surface; NOTE the
   live tension — HEAD just widened a wait 5→30 s for CI contention, so tighter waits
   must be *signal-based*, never shorter sleeps, or CI flakes return. Invariant:
   polls must have deadlines and assert on the signal, not the clock. Effort: medium.

8. **Growth budget gate** — class F.
   Lane 6 grew +65% body in 9 days; tests/e2e 6.8× in 2.5 months. Add a CI annotation
   (not a hard fail) reporting per-lane body time vs a rolling baseline, plus a
   placement rule in AGENTS.md: a new browser test must justify why vitest (jsdom) or
   the Go lane can't prove it first.
   Saving: prevents the next 65% jump (no current-time saving). Risk: low (annotation
   only). Invariant: gate informs, doesn't block (hard gates on timing breed flaky
   CI). Effort: low.

**Not recommended:** making lane 6 or lane 7 parallel via `workers > 1` — both are
serial **by design** over shared mutable fixture backends / self-bootstrapped servers
(settled assumption; config comments agree). Any parallelism must come from option 6a
(separate runners, separate processes) or duplicate fixture instances with isolated
state dirs (unverified whether the fixture server supports that — open fork).

## Recommended first three moves

1. **Option 1** (Go `t.Parallel()` sweep of pure `pkg/web` tests) — cheapest, lowest
   risk, pays off on every `go test ./...` locally and in CI.
2. **Option 2** (move multiproject-latency browser soak to dispatch; Go lane already
   guards API latency) — single biggest per-test win in the PR lane (~49 s), precedent
   already exists (lanes 8/9/10).
3. **Option 3** (prebuilt fixtureserver + measurable SPA build in `fixture-web.sh`) —
   zero flake risk, makes boot cost visible, speeds every local e2e loop.

## Contradictions

None detected among documented numeric claims (AGENTS.md's lane localization states no
timings, so nothing to contradict). Tensions and flagged inferences:

- **(tension)** flake-vs-speed: `4d612ed` (2026-10-31) widened a Go wait 5→30 s for CI
  ticker stalls; any wait-tightening (option 7) must be signal-based or it regresses
  CI stability. source=git log, confidence=high, type=fact.
- **(tension)** CI e2e job installs firefox for ~20 firefox-scoped tests out of 390 —
  install cost vs usage worth revisiting alongside option 6. type=inference.
- **(inference)** duplicate-coverage list (create-certainty, queue-recovery,
  tree-stream, multiproject-latency across Go/browser lanes) is name/line-level —
  verify actual assertion overlap before removing anything (option 4 gates on this).
- **(stale)** all receipts predate current tree (newest 2026-10-18); current absolute
  times are likely higher under trend F.

## Open forks

- Does the fixture server support multiple isolated instances (state dir env)? Required
  before any in-process lane-6 parallelism beyond the config-level project split.
- Actual CI per-job wall times (needs `gh` access) — would confirm which job is the PR
  critical path; currently inference from local receipts.
- Lane 4 (docker gold) current health: the 2026-10-09 attempt was RED (build fail);
  not re-checked since (docker-gated).

## Re-measurement list for an exec-capable session (all blocked here)

```
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test -json -count=1 ./pkg/... ./tests/integration/ ./tests/e2e/'   # per-pkg + per-test
vh-agent-harness exec npm --prefix web run test:unit -- --reporter=verbose
time web/node_modules/.bin/vite build   # inside fixture-web.sh dir — the >/dev/null-masked boot cost
vh-agent-harness exec bash -c 'cd web && npx playwright test --reporter=json --output=tmp/agent-runs/<alias>/pw-web/'
vh-agent-harness exec bash -c 'cd host-web && npx playwright test --reporter=json --output=tmp/agent-runs/<alias>/pw-hostweb/'
gh run list --limit 10 && gh run view --log <id>   # CI per-job wall
```

Raw receipts used: `tmp/agent-runs/page-load-perf/final-suite/report.md` (+ its lane
logs), `tmp/agent-runs/test-speed-study/` (README.md, lane6-pass{1,2}.json,
full-lane.json, hostweb-docker-full.json, hostweb-{native,docker}-finalsuite.json,
lane6-finalsuite.json, parse-list.mjs), 2026-09-18 fresh `go test ./...` log,
2026-08-10 eod-verify log.

---
This memo is research output: evidence and ranked options, not policy. Nothing here is
repo guidance until a maintainer adopts a slice; adoption should update AGENTS.md's
testing-lane localization and, where relevant, `docs/ai/` playbooks in a follow-up
slice. Next specialist: `debate` if the class-B time-compression fork (option 5) or the
lane-7 engine strategy (option 6) needs multi-perspective adjudication; otherwise
`planner` → `build` for options 1–3, which are mechanically safe.
