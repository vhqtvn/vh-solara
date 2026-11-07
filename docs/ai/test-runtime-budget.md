# Test runtime budget & placement policy

Status: durable policy, review-enforced (adopted 2026-10-31 from the test-suite
speed study — see `researches/decisions/test-suite-speed.md` and its adoption
errata). Nothing here is a mechanical CI gate: hard gates on wall-clock breed
flaky CI. The data that makes this policy actionable comes from the per-job
timing summaries CI attaches to every run (human-readable lines in the step
summary + machine-readable `tmp/timing-summaries/<job>.json` artifacts,
~14-day retention).

## 1. Seam placement ladder

Every new test lands at the **lowest seam that can prove it**:

1. **Unit** — Go co-located `pkg/*/*_test.go`; web `web/tests/unit/` (Vitest).
   Pure logic, no process boots, no network, no browser.
2. **Integration** — `tests/integration/`. Multiple internal components, no
   browser, no full cluster.
3. **Go e2e (in-process)** — `tests/e2e/` via `StartCluster()`. Protocol/API
   level end-to-end against the real aggregator + fake OpenCode.
4. **Browser e2e** — `web/tests/e2e/` and `host-web/tests/*`. Reserved for what
   only a real browser engine can prove.

A new browser scenario must state its **browser-only obligation** — the specific
outcome only a real engine can demonstrate (rendering/layout, cross-origin
iframe & event behavior, real input gestures, PWA/SW lifecycle) — and why each
lower seam is insufficient. State it in the PR description or the spec's leading
comment. "Easiest to write in Playwright" is not a justification; reviewers
should request re-seaming when the obligation is unstated or satisfiable lower
on the ladder.

## 2. Sleeps and slow tests carry an in-code rationale

- Any **intentional sleep** (`waitForTimeout`, `time.Sleep`, fixed delay)
  requires an adjacent comment naming why it exists and its class:
  - **Positive settling wait** — waiting for a real async effect to land
    (debounce flush, persistence, reconnect). Prefer a bounded signal poll on
    the exact expected value (`expect.poll`) over a fixed sleep. Never
    "optimize" a sleep by making it a shorter sleep — replace it with the
    signal, or CI-contention flakes return.
  - **Negative-observation window** — proving something does **not** happen
    within a real-time budget (deferred servo creep-back, no reconnect during
    a window). These are semantic contracts on real time; they may not be
    shortened or time-scaled without changing what is proven.
- Any test or spec file whose **expected body time exceeds 5 s per engine**
  carries a leading comment stating the budget and its product-level source
  (e.g. "real 15 s fork bound — see pkg/…"). Real-time budgets are contracts:
  state them, don't hide them.

## 3. Growth warning (dual-condition, review-enforced)

Wall-time growth is watched, not gated:

- A duration series is **comparable** only within the same lane, engine,
  runner class, exact command, and fresh-build mode. A CI matrix migration
  starts a new series — never compare across series.
- Once **≥ 5 comparable successful runs** exist, a new run that exceeds the
  **median** of that baseline by **both ≥ 10% AND ≥ 15 s** should be called
  out in review using the timing summaries/artifacts.
- **Missing history is "insufficient baseline"** — never a pass-by-default and
  never a failure. No annotation parser enforces this today and no hard CI
  timing gate is permitted. Required new proof may legitimately increase
  duration when the rationale is explicit (§1, §2).

## 4. Timing artifacts must not carry secrets

Any future `secrets.*` (or secret-derived value) wired into the `web`, `e2e`
(lane 6), `host-web-e2e`, or `multiproject-soak` CI jobs MUST first narrow that
job's timing/artifact upload from the whole `tmp/timing-summaries/` directory
to an explicit file list: GitHub masks secrets in **live** logs but **not** in
uploaded artifact files, and the whole-dir uploads include the raw tee'd run
logs — so any secret-derived value a failing test prints would be exfiltrated
in exactly the artifact attached to the red run that reports it. Precedent: the
`go` job's upload is deliberately `go.json` only (commit-review tier1_c-F1,
commit 1cecac5) because the banned-token deny-list test prints the
secret-derived `VH_SKILL_BANNED_TOKENS` token on failure; `multiproject-soak`
(`mp-soak.json`) is likewise already file-scoped, while `web`, `e2e`, and
`host-web-e2e` remain whole-dir and therefore must not gain secrets without
this narrowing.
