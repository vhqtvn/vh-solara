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

## Open contradiction — RESOLVE BEFORE ANY STREAMING/TIMELINE WORK
Our `9e5accee` study cited a **64 MiB** hard-terminate backpressure (`physical-socket.ts:MAX_PHYSICAL_SOCKET_BUFFERED_BYTES`). Paseo's HEAD (`5d15e40`) `docs/architecture.md` describes **8 MiB per-socket outbound high-water (hard terminate) + 4 MiB terminal-stream soft**. These disagree by 8×. Possibly a layering distinction (per-socket send budget vs aggregate/relay-frame OOM backstop). **The number must be re-derived from code, not trusted from either source.** Flagged in `01-streaming-timeline-sync.md`.

## Build sequencing decision (operator, 2026-08-04)
Adoption slices, in order:
1. **Surgical `#1925` catalog guard FIRST** — outbound (prompt dispatch), small, provable, immediate correctness; verified baseline before touching the reducer path. (The contract/translator rewire is INBOUND — event ingestion into `reducers.go` — so they overlap only in `client.go`; the "double work" objection is weak.)
2. **P7 `stopping` turn-state + session-scoped abort** — a REAL correctness gap (vh-solara `reducers.go` tracks only `idle`/`busy`); a turn-boundary state machine is exactly where an invariant is worth proving rather than arguing. Right after the guard, ahead of or alongside the contract work.
3. **Contract/translator rewire (normalized `AgentStreamEvent` + versioned translation interface)** — INBOUND, a state-layer rewire of the class that historically hid races in THIS repo (coherent-snapshot barrier arc: B-F1 pre-settle, C-F1 cursor regression, C-F2 stale-baseline — all found LATE, after "proven"). **Pin ingestion invariants with tests that go RED on divergence BEFORE the rewire, not after. Do not let a prose argument stand in for that.**
4. **Backpressure re-derivation (64 vs 8 MiB) gates ALL streaming/timeline-sync adoption.**

Clone refresh is operator-gated (the deny is intentional).
