# Paseo delta — 9e5accee → d9b72e1 (main)
New pin: d9b72e1c763a046d45f91f0ef0d56ffc39aec923 (2026-07-31T11:58Z). 22 commits / 210 files; 2 releases (v0.2.4, v0.2.5); HEAD post-v0.2.5 unreleased. Bulk = #2565 (113 files, app/UI). MATERIAL to our areas = #2662 + #2696 (OpenCode lifecycle) + #2565 (additive protocol).

## MATERIAL — OpenCode adapter lifecycle (Areas 3+4), #2662 + #2696
Line-verified at d9b72e1 in `packages/server/src/server/agent/providers/opencode-agent.ts` (full detail in `04-opencode-adapter.md` §d9b72e1):
- `OpenCodeTurnState = idle | running | stopping`; `OpenCodeRunnerStatus = idle | busy | retry`.
- **`OpenCodeStop` carries ONLY `{pendingCancellationTurnId, terminal}` — abort lives on the SESSION as `abortSettlement` (correction to first recon).**
- `shouldStartAutonomousTurn` = busy/retry ONLY (message.updated path GONE — message records mutable post-stop; root cause of #2696: OpenCode stamps fs-snapshot diff onto user message after idle, falsely reopening turns).
- On-subscribe `reconcileExternalRunnerStatus` adopts an already-busy session; `runnerStatusRevision` race guard.
- Live `COMPAT(opencodeSlowAbort)` tag in `interrupt()`.

## MATERIAL — protocol/versioning (Area 5), additive + docs
- **4003/version-gate CONFIRMED REAL** (`WS_PROTOCOL_VERSION=1`, close 4003; one-way handshake). Two-layer model reconciles with `docs/protocol-compatibility.md` (Layer A gate vs Layer B features) — see `05-protocol-versioning.md` §d9b72e1.
- New `docs/protocol-validation.md` (zod-aot generated validators; exact-pinned; outbound-only AOT target — purity rule scope is an open Q).
- New `docs/rpc-namespacing.md` (canonical = `checkout.forge.set_auto_merge` forge-neutral; `github.*` is the compat shim).
- New `docs/protocol-compatibility.md` (formalizes the two contracts + COMPAT format + "two six-month questions" self-test).
- #2565: capability-gated `project.list` + `projectList`; `projectKey` → nullable opaque cross-host key; scp-vs-URL remote-parse fix.

## UNCHANGED (9e5accee findings stand, none refuted)
- Streaming/backpressure (Area 1) — EXCEPT the 64-vs-8 MiB contradiction surfaced later at 5d15e40 (see that delta).
- Client/SDK (Area 2); security/relay crypto (Area 6).
- Area-3 cross-provider switch `dispatchStreamEventByType` + `attention_required` outbound (not in opencode-agent.ts, untouched).
- #2680 (skills install) = COSMETIC (no protocol surface).

## Self-corrections captured
1. `OpenCodeStop` scope: terminal on stop, abort on session (first recon conflated them).
2. 4003: real, not stale; two-layer model resolves the compat-doc silence.

Source access: raw `raw.githubusercontent.com/getpaseo/paseo/d9b72e1.../` + GitHub compare/commit API (clone still at 9e5accee; git fetch deny-ruled).
