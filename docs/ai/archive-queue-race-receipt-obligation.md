# Archive|Queue `-race` receipt obligation (pkg/web)

**Status:** DISCHARGED (drift-conditional) · **Scope:** `go test -race`
over the pkg/web Archive|Queue family · **Armed:** 2026-11-02 ·
**Discharged:** 2026-11-08

## Obligation

Before the next `v*` release tag is pushed, run and retain the complete
tree-bound `-race` receipt for the pkg/web Archive|Queue family. The
obligation **was armed** because pkg/web changed after the last satisfying
receipt — production fix `f3441a1` (`pkg/web/managed.go`) plus test
commits `e05dbfb`, `557d62d`, `dec5984` — and is now **discharged**: the
2026-11-08 receipt below covers ALL pkg/web changes through tree
`203b746` (including `f3441a1`, `e05dbfb`, `557d62d`, `dec5984`,
`a9273f18`, `186df7b`, `c6facf5`).

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

- Tree: `203b74646a5bd4a8bb2c4ccd03df3b757f72acd5` (2026-11-08, then HEAD)
- Outcome: ok, 184.269s, every test named and green
- Log: `tmp/race-receipts/20261108-archive-queue-race-203b746.log`
  (gitignored — which is why this durable note carries the record)

## Context

One earlier `-race -count=3` run of the family showed a single package-level
FAIL with the test name lost to output truncation. Six subsequent runs (three
post-change, three pre-change baseline) were clean. The artifact was judged
**unattributed-not-exonerated**: the failure cannot be attributed to a named
test, so it cannot be declared fixed — hence a standing receipt obligation
rather than a closed incident.

## Re-arming

Drift-conditional: the receipt has landed, but the `v*` tag is not yet cut
(`v1.86.0` is still latest). Until the tag is pushed, any further pkg/web
change re-arms the obligation at that tree; once the tag is cut with no
further pkg/web change, this receipt satisfies the gate for it. After the
tag, the obligation re-arms only if pkg/web changes again before a
subsequent `v*` tag.
