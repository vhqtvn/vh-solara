# Paseo — protocol & versioning contract
Pin: base 9e5accee; **4003/validation/rpc-namespacing docs RE-PINNED to d9b72e1**. Source: local clone @ 9e5accee + raw @ d9b72e1.

## Two contracts (proven by executable `packages/server/src/server/wire-compat.test.ts`)

### Protocol contract — "always compatible" (schema-level, both directions)
- New fields are `.optional()` with a sensible default. Never flip optional→required, remove a field, or narrow a type (`string`→enum, nullable→non-null). A field you stop sending stays accepted.
- **Wire schemas are PURE STRUCTURAL:** no `.transform()`, `.catch()`, `.preprocess()` on WebSocket message schemas — normalization is a separate post-validation pass. (`server_info`'s strict `.transform()` coexists because it sits OUTSIDE the outbound union.)
- `z.discriminatedUnion()` MANDATORY when branches share a literal tag (plain `z.union()` forbidden then). `.default()` on primitive leaves only.
- Hard-break escape hatch: `WS_PROTOCOL_VERSION` + close code (see d9b72e1 below).

### Feature contract — "per feature, gated once"
- Features don't have to work across versions; a new feature usually needs a new daemon capability. **No fallback paths / no degraded shims.** Detection in ONE place; downstream reads a clean shape.
- Capability flags live in `features` on the `server_info` message. Gated enum emission: the wire asks `session.supports(CLIENT_CAPS.x)` before emitting new enum values.

### COMPAT tagging rule
- Exact format: `// COMPAT(name): added in vX.Y.Z, remove after <date/condition> once <removal condition>.` `rg "COMPAT\("` is the full cleanup backlog. Never bury compat in an untagged `??` fallback. (Live examples: `COMPAT(opencodeSlowAbort)`, `COMPAT(projectedBeforePageOwnership)`.)

## d9b72e1 RE-PIN — 4003 / version-gate RESOLUTION + validation pipeline + RPC namespacing

### 4003 is REAL — two-layer model (resolves apparent contradiction with docs/protocol-compatibility.md)
- `WS_PROTOCOL_VERSION = 1` (`websocket-server.ts:451`); `WS_CLOSE_INCOMPATIBLE_PROTOCOL = 4003` (`:449`). `WSHelloMessageSchema.protocolVersion: z.number().int()` **NO default** (`messages.ts:5787-5792`). `handleHello` gate (`:1400-1413`): mismatch → `ws.close(4003, "Incompatible protocol version")`. Client sends LITERAL `protocolVersion: 1` (`daemon-client.ts:5276`) — hardcoded, not from a shared constant.
- **Layer A (this gate):** connection-accept coarse check, ONE-WAY (client→server); `server_info` carries NO `protocolVersion` field → no negotiated version exchange.
- **Layer B (what `docs/protocol-compatibility.md` documents):** within-version additive evolution via `server_info.features.*`. The doc's silence on 4003 is scope, NOT contradiction.
- Accept-boundary close-code cluster: 4001 hello-timeout, 4002 invalid-hello (empty clientId), 4003 incompatible-protocol, 4401 daemon-auth-failed.

### AOT validation pipeline (`docs/protocol-validation.md`) — mobile perf
- Inbound (server→client) messages validated by zod-aot GENERATED validators (not runtime Zod) on the hot path. Pipeline: `packages/protocol/codegen/ws-outbound.compile.ts` → `scripts/generate-validation-aot.mjs` (exact-pinned zod-aot + local patches) → gitignored `src/generated/validation/ws-outbound.aot.ts`; shipped boundary `src/validation/ws-outbound.ts` (calls generated `WSOutboundMessageSchema.safeParse`, no normalize/repair); hooks `prebuild/pretypecheck/pretest/watch`; installs SKIP generation (consume prebuilt dist).
- **Open Q:** AOT target is the OUTBOUND tree only; `messages.ts` has transforms on some inbound/attachment sub-schemas — the purity rule may be outbound-only, not blanket.

### RPC namespacing (`docs/rpc-namespacing.md`)
- Dotted `Domain.namespace.op.direction`. **CANONICAL new-pattern example = `checkout.forge.set_auto_merge.request` (forge-neutral)**; `checkout.github.*` is the COMPAT shim being migrated away (CORRECTS any packet citing github.* as the exemplar). Verb-not-noun; responses wrap correlated data under `payload` with `requestId` in both; dots-not-slashes; flat names deprecated (4-step migration: add dotted → gate via features → keep old accepted → mark COMPAT + removal date). Separate `forge.search.*` namespace; no GitHub-specific enums inside `checkout.forge.*`.

## Migration examples (from wire-compat.test.ts)
- `assistant_message.messageId` added `.optional()`. Rewind caps `.optional().default(false)`. Gated enum `reasoning_merge` in `collapsed[]`. `create_paseo_worktree_request` accepts old (`nameContext`+`attachments`) AND new (`firstAgentContext`), normalized post-validation.

## d9b72e1 additive (#2565)
- New capability-gated `project.list` channel + `projectList` capability. `projectKey` → nullable opaque cross-host grouping key (`string | null`, backfilled, no migration; consumers must not parse/rederive it). Remote-parse scp-vs-URL fix (`git-remote.ts`).

## vh-solara relevance
- Strong pattern for client/daemon evolution: two-contract model + capability detection + COMPAT cleanup tags + AOT validation + dotted RPC namespacing. Directly applicable to vh-solara's SPA↔binary protocol evolution.
