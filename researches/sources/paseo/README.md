# Paseo study (external reference)

A study of `getpaseo/paseo` (AGPL-3.0) as a design reference for vh-solara.
**Design and ideas only — no code copied (AGPL obligations would attach).**

## Pins
- **Base:** verified at `9e5accee3c688e2a766f56c76d24b6b03a07b72d` (main, 2026-07-30). The local clone at `refs/paseo` is pinned here.
- **Material areas re-verified at `d9b72e1c763a046d45f91f0ef0d56ffc39aec923`** (main, 2026-07-31) — OpenCode adapter lifecycle + protocol/versioning.
- **Delta to `5d15e40a2b057ec7775f9884861fb462e637a59d`** (main, 2026-08-02) — timeline dedup + relay opt-in.

The clone (`refs/paseo`) is stale past `9e5accee` (operator-gated refresh); delta reads used raw `raw.githubusercontent.com/getpaseo/paseo/<SHA>/...`.

## Index
- `01-streaming-timeline-sync.md` — real-time streaming, timeline-sync, backpressure (base 9e5accee).
- `02-client-sdk-mobile.md` — PaseoClient SDK, WS driver, app real-time (base 9e5accee).
- `03-agent-lifecycle-persistence.md` — lifecycle state machine, file persistence, orchestration (base 9e5accee).
- `04-opencode-adapter.md` — OpenCode provider adapter (base 9e5accee + d9b72e1 re-pin).
- `05-protocol-versioning.md` — wire/feature contracts, capability negotiation, AOT validation (base 9e5accee + d9b72e1).
- `06-security-relay.md` — E2EE-over-untrusted-relay, DNS-rebinding defense, auth (base 9e5accee).
- `delta-9e5accee-to-d9b72e1.md` — OpenCode lifecycle hardening + protocol docs.
- `delta-d9b72e1-to-5d15e40.md` — timeline dedup + relay opt-in.

## Self-corrections in the record (a study that caught its own errors)
1. **`OpenCodeStop` scope (d9b72e1 verification).** First recon said "the `stopping` turn-state variant owns the session-scoped abort." Line-verification REFUTED this: `OpenCodeStop` carries ONLY `{pendingCancellationTurnId, terminal}`; the session-scoped abort lives on the **session** as `abortSettlement` (deliberately — OpenCode aborts outlive the stop). See `04-opencode-adapter.md` §d9b72e1.
2. **4003 / version-gate "stale?" resolution (d9b72e1).** The new `docs/protocol-compatibility.md` is silent on `protocolVersion`/`4003`, which looked like a contradiction with our Area-5 claim. Resolved: it is a **two-layer model** — Layer A = the connection-accept coarse gate (`hello.protocolVersion === WS_PROTOCOL_VERSION` else close `4003`, one-way, no server echo); Layer B = within-version additive evolution via `server_info.features.*` (what the compat doc covers). No contradiction. See `05-protocol-versioning.md` §d9b72e1.

## Backpressure threshold — RESOLVED (case b: paseo doc-error)
Targeted code read at HEAD `5d15e40` settles it: paseo's own doc disagrees with its own code; we trust the code. Our 64 MiB finding is correct and NOT stale.
- **Hard cap (64 MiB) — confirmed in code at BOTH pins, byte-identical:** `packages/server/src/server/websocket/physical-socket.ts:4` `MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024` — identical at `9e5accee` and `5d15e40` (read at both commits). `docs/architecture.md`'s "8 MiB hard terminate" is a paseo DOC ERROR (same layer — `physicalSocketHasCapacity`/`sendBoundedPhysicalFrame` — wrong number in the doc).
- **Terminal-soft (4 MiB) — confirmed in code:** `packages/server/src/terminal/terminal-restore.ts` `MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024` (gated with `MAX_TERMINAL_OUTPUT_FRAME_BYTES = 256 * 1024`); read at `5d15e40`. Matches the doc's 4 MiB soft figure.
- **Relay-adapter queue — SCOPED OUT (not open):** the doc bundles "the encrypted relay adapter's async queue" into its 8 MiB claim, but that is a DIFFERENT queue (the encrypted relay adapter's), and vh-solara does NOT use paseo's relay topology at all — so it is the least transferable number in this study. No further read warranted.

Net: `01-streaming-timeline-sync.md` stands as-written (64 MiB hard, 4 MiB soft). Streaming/timeline adoption is unblocked on this item.

## Build sequencing decision (operator, 2026-08-04)
Adoption slices, in order:
1. **Surgical `#1925` catalog guard FIRST** — outbound (prompt dispatch), small, provable, immediate correctness; verified baseline before touching the reducer path. (The contract/translator rewire is INBOUND — event ingestion into `reducers.go` — so they overlap only in `client.go`; the "double work" objection is weak.)
2. **P7 `stopping` turn-state + session-scoped abort** — a REAL correctness gap (vh-solara `reducers.go` tracks only `idle`/`busy`); a turn-boundary state machine is exactly where an invariant is worth proving rather than arguing. Right after the guard, ahead of or alongside the contract work.
3. **Contract/translator rewire (normalized `AgentStreamEvent` + versioned translation interface)** — INBOUND, a state-layer rewire of the class that historically hid races in THIS repo (coherent-snapshot barrier arc: B-F1 pre-settle, C-F1 cursor regression, C-F2 stale-baseline — all found LATE, after "proven"). **Pin ingestion invariants with tests that go RED on divergence BEFORE the rewire, not after. Do not let a prose argument stand in for that.**
4. **Backpressure threshold — RESOLVED** (read at `9e5accee` + `5d15e40`): 64 MiB hard + 4 MiB soft confirmed in paseo code; the doc's 8 MiB hard is a paseo doc-error; relay-adapter queue scoped out (vh-solara doesn't use paseo's relay topology). See the "Backpressure threshold — RESOLVED" entry above. Streaming/timeline adoption unblocked.

Clone refresh is operator-gated (the deny is intentional).
