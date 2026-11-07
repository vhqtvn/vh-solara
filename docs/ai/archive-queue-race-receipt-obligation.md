# Archive|Queue `-race` receipt obligation (pkg/web)

**Status:** ARMED — release gate · **Scope:** `go test -race` over the
pkg/web Archive|Queue family · **Armed:** 2026-11-02

## Obligation

Before the next `v*` release tag is pushed, run and retain the complete
tree-bound `-race` receipt for the pkg/web Archive|Queue family. The
obligation is **armed**: pkg/web changed after the last satisfying receipt —
production fix `f3441a1` (`pkg/web/managed.go`) plus test commits `e05dbfb`,
`557d62d`, `dec5984` — so the prior receipt no longer covers the tree.

## Recipe

```bash
export PATH=$PATH:/usr/local/go/bin && git rev-parse HEAD   # tree binding
go test -race -count=3 -run 'Archive|Queue' -v ./pkg/web/ 2>&1 \
  | tee tmp/race-receipts/<YYYYMMDD>-archive-queue-race-<sha>.log
```

Every flag is load-bearing: `-v` names every test (the original failure mode
was a truncated, unnamed FAIL), `-count=3` is the stress depth, and `tee`
survives terminal truncation. Record HEAD (header + filename) so the receipt
is tree-bound.

## Last satisfied receipt

- Tree: `c7ca81a661a131b30b75f33c9c5134c2bf28e4b3` (2026-11-02)
- Outcome: ok, 222.549s, every test named and green
- Log: `tmp/race-receipts/20261102-archive-queue-race-c7ca81a6.log`
  (gitignored — which is why this durable note carries the record)

## Context

One earlier `-race -count=3` run of the family showed a single package-level
FAIL with the test name lost to output truncation. Six subsequent runs (three
post-change, three pre-change baseline) were clean. The artifact was judged
**unattributed-not-exonerated**: the failure cannot be attributed to a named
test, so it cannot be declared fixed — hence a standing receipt obligation
rather than a closed incident.

## Re-arming

Drift-conditional: once the receipt lands and the tag is cut, the obligation
re-arms only if pkg/web changes again before a subsequent `v*` tag.
