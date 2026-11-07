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
| `ep-<24 hex>` | `ep-0000000000000000000aaaaa` (first store life) / `ep-0000000000000000000bbbbb` (second store life) | per-store-lifetime epoch id (`state.newEpoch`, crypto/rand), ROLE-mapped per scenario by the generator's builder so distinct store lives never collapse to one token (OB5 chain K) |
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
| `K1-epoch-preserved-replay.sse` | K | `path=replay fallback_reason=none cursor=6 replayed=1` | epoch-preserved resume (OB5 K1): the reconnect URL's cursor+epoch PAIRING matches the store — the handshake does not flip same-epoch resume; withheld obligation repairs in the same epoch |
| `K2-epoch-change-fresh.sse` | K | `path=fresh fallback_reason=epoch_mismatch had_cursor=true cursor=6 head=7` | epoch-change crux (OB5 K2): the DEAD-store cursor+epoch pair forces epoch_mismatch → fresh snapshot@7 with B-exclusive ids (n1..n3); obligations re-seed under the NEW epoch; dead-epoch obligations take the explicit `expired` disposition; the NEXT reconnect claims B's snapshot seq paired with B's epoch |
| `K3B-epoch-change-low-live.sse` | K | `path=fresh fallback_reason=epoch_mismatch had_cursor=true cursor=6 head=4` | epoch-change low resume (OB5 K3): B's live tail (n1@5 delivered, q1up@6 withheld by the TS harness) leaves an OPEN epoch-B obligation at a seq the dead A-cursor covers — the perturbation leg's over-claim geometry |

The six-way discriminator is covered on real bytes: the five fresh
fallback_reasons (`cursorless`, `compatibility_fallback`,
`ring_eviction`, `stale_cursor_exceeds_head`, `epoch_mismatch` — the OB5
K family landed the last one) plus `none` (replay).

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
drift). This holds for the epoch-change scenarios too: the per-life epoch
tokens are assigned ROLE-based (first store life → `…aaaaa`, second →
`…bbbbb`) by the scenario's builder, never by first appearance in the
bytes, so the random epoch ids never reach the committed output.

## Honest scope

- The fixtures' stores use a **ring-capacity test knob** (4 for the eviction
  chain, 1000 elsewhere). The production premise of a 4096-event ring is a
  user-supplied settled premise; the fallback discriminator path is
  capacity-independent.
- The generator's requests omit `dir=` (selects the default aggregator — a
  store-routing parameter that does not change the branch selection under
  test). `epoch=` IS exercised by the K family: K1 carries the store's REAL
  epoch (a matching handshake must stay `replay`), and K2/K3B carry the
  DEAD store-A pairing (`cursor=` from A's seq space + A's epoch against a
  SECOND store life — the client's real reconnect URL shape, forcing
  `epoch_mismatch`). The TS harness sets its own project dir; the
  obligations are dir-invariant.
- The claim these fixtures support is an **obligation-preservation
  OBSERVATION at this revision** — real Go emission consumed by the real TS
  module — not production correctness, and not a live-server bridge.
