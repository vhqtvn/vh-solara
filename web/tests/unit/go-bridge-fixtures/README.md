# go-bridge-fixtures — Go→TS bridge fixtures (verification pilot slice 2)

Card: `task-2026-11-07t04-03-03-o12-gots-bridge-ob1-ob2` (whole-data-flow
pilot; see `tmp/agent-runs/formal-verify-fullflow/o11-obligation-map.md` for
the obligation identities OB1/OB2 these exercise).

These are **real wire bytes**: every `.sse` file is the ACTUAL response body
of the real `/vh/stream` handler (pkg/web/stream_http.go) captured through
`httptest` against a real `aggregator`+`state.Store` by
`pkg/web/stream_bridge_fixture_test.go`. The TS half of the bridge
(`web/tests/unit/session-cursor-bridge.test.ts`) feeds these bytes through
the REAL `web/src/sync/session-stream.ts` module — the module's own decode
path runs on the `data:` lines verbatim.

## File format

Each fixture starts with `:`-comment header lines (ignored by SSE clients):

```
: bridge-fixture: <name>
: request:        <the generator's request URL and cursor derivation>
: journal:        <the always-on "stream baseline" journal line for that connect>
: normalizations: <the three documented byte normalizations>
```

followed by the handler's response bytes from the first flushed byte (`:`
hello / retry hint) to the post-live-tail idle.

## Normalizations (documented, shape-preserving)

| Raw | Normalized | Why |
|---|---|---|
| `retry: <n>` | `retry: 2000` | per-connection random SSE retry hint (`sseRetryBaseMs + rand.Intn(sseRetryJitterMs)`) |
| `ep-<24 hex>` | `ep-0000000000000000000aaaaa` | per-store-lifetime epoch id (`state.newEpoch`, crypto/rand) |
| `time=<RFC3339>` (journal line only) | `time=<normalized>` | vhlog wall-clock timestamp on the captured journal line |

`manifest.json` is the machine contract: per scenario, the request shape,
the journal line, the expected client disposition, and the full frame list
(event + id). The Go drift guard and the TS consumer both cross-check against
it.

## Scenario matrix (scenario → journal line → client disposition)

| File | Chain | Journal discriminator | Client disposition (observed by the TS harness) |
|---|---|---|---|
| `R1-initial-cursorless.sse` | R | `path=fresh fallback_reason=cursorless` | fresh snapshot applies (floor=4); live tail delivered as a PREFIX — the tail `part.append@7` is WITHHELD (real disconnect shape) |
| `R2-replay-in-range.sse` | R | `path=replay fallback_reason=none cursor=6 replayed=1` | replay repair: every replayed frame's globalSeq > 6; the withheld obligation re-served and applied |
| `C3-compat-fallback.sse` | C | `path=fresh fallback_reason=compatibility_fallback part_append_in_range=true cursor=5` | legacy fresh-snapshot fallback applies; the missed part content arrives as FULL TEXT via the snapshot |
| `E1-initial-cursorless.sse` | E | `path=fresh fallback_reason=cursorless` | fresh snapshot applies (floor=4); live tail `m2@5` WITHHELD |
| `E2-ring-eviction.sse` | E | `path=fresh fallback_reason=ring_eviction had_cursor=true cursor=4 head=10` | fallback discharge: fresh snapshot@10 applies, DISCHARGES the withheld m2@5; the NEXT reconnect claims cursor=10 |
| `S1-stale-cursor-exceeds-head.sse` | S | `path=fresh fallback_reason=stale_cursor_exceeds_head cursor=50003 head=3` | Go-side-only pin (journal discriminator); not consumed by the TS harness |
| `T1-tree2-replay-reconnect-pair.sse` | T | `path=replay fallback_reason=none cursor=2 replayed=1` | Go-side-only pin (tree stream / Stream 1): the treeEmitter-gated reconnect pair `tree.op` → `tree.snapshot` + `snapshot` + `snapshot.complete` |

The five-way fresh discriminator (`epoch_mismatch` excluded — that is the OB5
surface, deliberately deferred by the pilot) is covered: `cursorless`,
`none` (replay), `compatibility_fallback`, `ring_eviction`,
`stale_cursor_exceeds_head`.

## Regeneration + drift guard

```sh
# regenerate (after ANY handler behavior change):
VH_BRIDGE_FIXTURE_REGEN=1 go test ./pkg/web/ -run TestStreamBridgeFixture

# the default mode regenerates IN MEMORY and byte-compares against these
# committed files — any drift between handler behavior and these fixtures is
# RED with these regeneration instructions.
go test ./pkg/web/ -run TestStreamBridgeFixture
```

The generator also captures every scenario TWICE from two freshly-built
store/server instances and requires byte-identical output (a determinism
receipt — residual nondeterminism fails loudly at generation, not as CI
drift).

## Honest scope

- The fixtures' stores use a **ring-capacity test knob** (4 for the eviction
  chain, 1000 elsewhere). The production premise of a 4096-event ring is a
  user-supplied settled premise; the fallback discriminator path is
  capacity-independent.
- The generator's requests omit `dir=` (selects the default aggregator) and
  `epoch=` (an absent epoch param never mismatches — stream_http.go:248);
  both are store-routing/handshake parameters that do not change the branch
  selection under test. The TS harness sets its own project dir; the
  obligations are dir-invariant.
- The claim these fixtures support is an **obligation-preservation
  OBSERVATION at this revision** — real Go emission consumed by the real TS
  module — not production correctness, and not a live-server bridge.
