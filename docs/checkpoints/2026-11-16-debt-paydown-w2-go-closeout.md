# Debt-paydown W2 (Go) closeout receipt — 2026-11-16

Discharges task-2026-11-16t10-13-26-debt-paydown-w2-go-… at final tree
`80262fd` (main). Source ledger: `tmp/agent-runs/defer-restudy-2026-11-16/ledger.md`
(W2 wave plan). W1 baseline for comparison: 036b5c2.

## Per-item dispositions

| Ledger block | Disposition | Landed as |
|---|---|---|
| defer-delayedpersist-resetgen-fence | LANDED | `5334634` (pkg/fixtures/opencode.go + opencode_delayed_test.go) |
| defer-t1d-f1-reconcile-test | LANDED | `7a5ed8a` (pkg/web/queue_msg_reconcile_test.go) |
| defer-reset-gc2-boundary-isolation | LANDED | `80262fd` (pkg/fixtures/opencode_resetqueue_test.go) |
| defer-reseed-empty-tail-memo | SKIPPED (rider rule) | card stays KEEP-DEFERRED — discriminating test is absence-shaped (needs request-counting middleware + settle choreography, ~70+ LOC, pkg/aggregator outside the wave file set); ledger's own park disposition stands |
| defer-fixtures-opencode-full-matrix-sweep | EXECUTED at final tree | `npm --prefix web run test:e2e` → **396 passed / 5 deliberate skips / 0 failed (11.0m)** — identical to W1 baseline (396/5/0, ~11m); both historically-fired arrears triggers discharged |

## Verification receipts (tree-bound to 80262fd)

- `go test ./pkg/... ./cmd/` — all ok (pkg/fixtures 21.0s fresh at 80262fd;
  pkg/web 135.7s at the content-identical pre-commit tree)
- `go test ./tests/integration/` — ok (content-identical cache: commits changed
  no file contents after the 41.7s fresh run)
- `go test ./tests/e2e/` — ok 184.3s (extra diligence: in-process fixtures consumer)
- Targeted new tests `-count=2` green: TestPromptAsyncDelayedPersist*,
  TestReconcile_FenceLandingMidTerminalPassUsesRestartDetail,
  TestFixtureResetGC2NextConsumerBoundaryIsolation
- `gofmt -l pkg/fixtures pkg/web` clean; `go vet ./pkg/fixtures/ ./pkg/web/` clean
- No `t.Parallel` added (race-safety standing defer)
- Matrix sweep receipt above (11.0m, five projects, serial)

## Behavioral closure

```behavioral-closure
item: defer-delayedpersist-resetgen-fence
path: fixture POST /session/:sid/prompt_async (PromptAsyncDelayedPersist) → /fixture/reset during delay → delayed commit discarded
verifier: TestPromptAsyncDelayedPersistResetDiscardsPendingCommit
command: go test ./pkg/fixtures/ -run TestPromptAsyncDelayedPersistResetDiscardsPendingCommit -count=2
result: proven
verdict: proven
interaction_touching: false
receipt: green ×2 at 5334634; outcome observed (UserMessageCount=0 + permanent 404 after reset+delay); red-verified by temporarily disabling the fence (FAIL: "UserMessageCount after reset+delay = 1, want 0"), then restored; commit-review F1 (check-then-commit race) fixed via commitUserMessageIfGensMatch single-hold check+append and re-approved
```

```behavioral-closure
item: defer-t1d-f1-reconcile-test
path: queue_msg_reconcile pass 3 snapshot → GET window → bumpReconcileAttempt mutex-time restart-fmt selection
verifier: TestReconcile_FenceLandingMidTerminalPassUsesRestartDetail
command: go test ./pkg/web/ -run TestReconcile_FenceLandingMidTerminalPassUsesRestartDetail -count=2
result: proven
verdict: proven
interaction_touching: false
receipt: green ×2 at 7a5ed8a; mutation check — temporarily regressing reconcileOne to snapshot-time selection made the NEW test FAIL (generic fmt emitted) while TestReconcile_RestartFencedPersistent404UsesRestartDetail still PASSED under the same mutation (empirically confirming the ledger's near-refutation: pre-pass fences pin nothing); mutation fully reverted (production file diff empty)
```

```behavioral-closure
item: defer-reset-gc2-boundary-isolation
path: /fixture/reset → session.deleted → GC-2 subscriber CleanupSession (delayed) → next-consumer enqueue/claim/resolve at same id → second reset collection
verifier: TestFixtureResetGC2NextConsumerBoundaryIsolation
command: go test ./pkg/fixtures/ -run TestFixtureResetGC2NextConsumerBoundaryIsolation -count=2
result: proven
verdict: proven
interaction_touching: false
receipt: green ×2 at 80262fd; observed outcomes — List drains to zero only after the GC tombstones the retained store (proves GC ran, not just the synchronous file sweep); full lifecycle works on the recreated session at the same id (queue.json re-persists); second reset's delayed GC collects the recreated queue. ABA re-evaluation note in the test's doc comment (deleteStore keyed (root,sid), no epoch; enqueue-between-delete-and-GC window is scheduler-dependent, deliberately unforced, unreachable in the sequential serial-lane contract; epoch guard recommended if a future spec forces reset→immediate-enqueue)
```

```behavioral-closure
item: defer-fixtures-opencode-full-matrix-sweep
path: full serial web e2e matrix over the fixtures engine at final tree
verifier: npm --prefix web run test:e2e (five projects)
command: npm --prefix web run test:e2e
result: proven
verdict: proven
interaction_touching: false
receipt: 396 passed / 5 skipped (pre-existing deliberate) / 0 failed in 11.0m at 80262fd — identical pass/skip/fail shape to the W1 baseline at 036b5c2
```

```behavioral-closure
item: defer-reseed-empty-tail-memo (rider)
path: pkg/aggregator/cold-seed.go reseedCreatedSessionAgent
verifier: n/a
command: n/a
result: skipped
verdict: inconclusive
interaction_touching: false
receipt: skipped per mission rider rule ("skip without ceremony if it balloons") — the fix itself is ~3-5 LOC but a discriminating deterministic test is absence-shaped (no event, no witness for the unmarked memo) requiring hand-rolled request-counting middleware + settle choreography (~70+ LOC) in a package outside the wave's file set; ledger's KEEP-DEFERRED park disposition stands with the card's own path_touched trigger
```

## Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Fence discards reset-stale commits | new test green ×2; fence-disable mutation → red | yes |
| Mid-pass-3 test discriminates | snapshot-time mutation → new test red, pre-existing green | yes |
| GC-2 next-consumer boundary holds | new test green ×2 (lifecycle + second-reset collection) | yes |
| Full lanes green at final tree | go test ./pkg/... ./cmd/ ok; ./tests/integration/ ok; ./tests/e2e/ ok | yes |
| Matrix sweep == W1 baseline | 396/5/0 (11.0m) vs 396/5/0 (~11m) | yes |
| gofmt/vet clean | gofmt -l empty; go vet clean | yes |

## Findings

- All four ledger premises ALIVE at entry (re-derived; recorded as F3 envelope evidence on the card). No stale premise; no item STOPped.
- Tree state oscillated mid-session (5 foreign dirty files observed by the adversarial reviewer, clean again later — concurrent session activity); no in-scope file was ever dirty. HEAD moved 036b5c2 → a6cc821 (docs-only, concurrent lane-8 sync) before this wave's commits.
- Commit-review C1 was BLOCKED once (F1 check-then-commit race in the first fence shape) — fixed via the single-hold conditional commit, re-approved unanimously. C2/C3 approved first pass.
- Advisory review DEFERs triaged (resolve-first): slice-1 "force interleaving deterministically" DECLINED (the reset-during-delay interleaving is already deterministic: reset completes microseconds after the 204; the goroutine checks at +200ms); ABA epoch-guard trigger recorded here + in the C3 doc comment + first-review F5 (re-raise only if a spec forces reset→immediate-enqueue); lane-1 final-tree receipt RESOLVED (full rerun green at 80262fd).

## Contradictions

None detected. (The ledger's premise that the mid-pass-3 test was genuinely
absent was CONFIRMED by the mutation check — the pre-existing pre-pass tests
passed under the snapshot-time regression, exactly as the ledger predicted.)

## Decision record

```decision-record
{
  "version": 3,
  "items": [
    { "id": "measured_outcome[fnv1a:2ac3bc2937144968]",
      "disposition": "curated",
      "carrier": { "kind": "artifact", "path": "docs/checkpoints/2026-11-16-debt-paydown-w2-go-closeout.md" },
      "handle": "W2 discharged: fence 5334634, t1d-f1 test 7a5ed8a, GC-2 test 80262fd, rider skipped (balloons), matrix sweep 396/5/0 at 80262fd == W1 baseline",
      "provenance": "this checkpoint's Per-item dispositions + Behavioral closure sections carry the curated summary; commits 5334634/7a5ed8a/80262fd carry the per-item detail" }
  ]
}
```
