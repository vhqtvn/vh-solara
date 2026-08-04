# Paseo delta — d9b72e1 → 5d15e40 (main)
New pin: 5d15e40a2b057ec7775f9884861fb462e637a59d (2026-08-02T20:34Z). 54 commits / ~2.5 days; ZERO new releases (still v0.2.5; all unreleased main). Bulk = packaging/build (~12 Nix/Darwin) + app UI (~15) + Git/PR-identity (~5). For our areas: 2 MATERIAL deltas; OpenCode adapter UNCHANGED (no commit targets it).

## MATERIAL — timeline dedup (#2789 `26bdb1d`)
Line-verified at HEAD in `packages/app/src/timeline/session-stream-reducers.ts`:
- Client adds **page-ownership dedup** — `selectEntriesOwnedByTimelinePage(payload)` filters entries to `entry.seqStart >= startCursor.seq && entry.seqStart <= endCursor.seq` when `direction==="before" && projection==="projected" && startCursor && endCursor` (else returns all = fallback for older daemons).
- New additive `projection: "projected" | "canonical"` field on the response.
- **Render-id disambiguation** — `reservedItemIds = new Set([...tail,...head].flatMap(item => assistant_message && blockGroupId ? [id, blockGroupId] : [id]))` passed to `hydrateStreamState(..., {source:"canonical", reservedItemIds})`; fixes projected siblings sharing a provider `messageId` double-rendering.
- Tag: `COMPAT(projectedBeforePageOwnership): added in v0.2.6, remove after 2027-02-02`.
- Confirms our adoption candidate (a): epoch/window{minSeq,maxSeq,nextSeq}/startCursor.seq/endCursor.seq/direction tail|before|after/hasOlder/hasNewer/retainedRanges/catch_up on gap all stand; ADD page-ownership + projection + render-id.

## MATERIAL — relay opt-in (#2706 `d2de309`)
- New homes materialize `daemon.relay.enabled=false` (`docs/data-model.md`: `relay:{enabled,endpoint,publicEndpoint,useTls,publicUseTls}`). Consent-gated pairing UI (decline → direct TCP/Tailscale/VPN, no QR).
- **Live enable, NO daemon restart** (`DaemonConfigStore` persists desired state; `relay-runtime` starts/stops outbound transport live; pairing reads current state not startup snapshot; e2e `expectDaemonPidUnchanged`).
- **Identity-validated remote pairing** (reject a reachable daemon whose identity doesn't match the requested Paseo home before reading/mutating pairing state).
- **Capability-gated** (older daemons lacking relay-config capability get "Update the host" + NO `daemon.get_pairing_offer.request` sent). New e2e flags `E2E_RELAY_CONFIG_CAPABILITY`/`E2E_DAEMON_STATUS_RPC_CAPABILITY`.
- **Crypto/tunnel UNCHANGED** (Curve25519 ECDH + XSalsa20-Poly1305 NaCl box, zero-knowledge relay, QR public-key transfer).

## Adoption-candidate verdicts
- (a) timeline-sync → REFINE (add page-ownership + projection + render-id).
- (b) versioning/protocol → NO rethink (additive `projection` field only; 4003/two-layer/COMPAT/AOT/dotted RPC all unretracted).
- (c) relay/tunnel → REFINE default-posture (relay now opt-in `enabled:false` for new homes; consent+identity+capability gated; crypto unchanged — correct any assumption of relay-on-by-default).
- (d) OpenCode boundary → NO rethink (no commit targets opencode-agent.ts; d9b72e1 turn-state presumed intact — NOT fully line-verified at HEAD this cycle).

## CONTRADICTION surfaced (see README + 01-streaming)
- 9e5accee study: 64 MiB hard-terminate backpressure. HEAD `docs/architecture.md`: 8 MiB hard + 4 MiB terminal-soft. **8× disagreement — re-derive from code before any streaming/timeline work.**

## GAPS (non-blocking)
- OpenCode `OpenCodeAgentSession` turn-state NOT fully line-verified at HEAD (no delta commit targets it; presumed intact).
- `packages/protocol/src/messages.ts` not read — `projection` wire def + whether `relayConfig`/`daemonStatusRpc` are `server_info.features.*` (Layer B) or `CLIENT_CAPS` (hello) INFERRED from client code + COMPAT comment + e2e flags.
- `docs/timeline-sync.md` exists at HEAD (canonical timeline-sync source per architecture.md) but NOT read — high-value for adoption candidate (a).

Source access: raw `raw.githubusercontent.com/getpaseo/paseo/5d15e40.../` + GitHub compare/commits API (clone still at 9e5accee).
