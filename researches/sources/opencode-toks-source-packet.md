---
research_question: |
  Justify vh-solara's per-turn "tok/s" algorithm: a PURE output decode rate
  (tokens.output / union of text-part decode intervals) replacing the old
  full-turn average. Cite the upstream sst/opencode sources that make
  TextPart.time the only decode-proximate timing and explain the Anthropic
  reasoning-inclusive numerator caveat.
scope: |
  Read-only citation packet against upstream sst/opencode (TS/Bun + Effect).
  No repo files modified by this packet; it backs the implementation in
  web/src/usage.ts (turnStats) and tests in web/tests/unit/usage.test.ts.
confidence: HIGH — wire shapes + processor behavior confirmed against upstream source; the Anthropic numerator caveat is a documented provider limitation, not fixable from the wire.
date: 2026-07-15
time_sensitive: STABLE — upstream sst/opencode session/processor/llm logic; revisit if TextPart.time shape or getUsage() reasoning subtraction changes upstream.
source_policy: |
  Upstream sst/opencode repo paths (cited inline below) are the primary
  sources. vh-solara forwards this JSON untouched (pkg/state/store.go), so the
  frontend reads the same shapes the daemon emits.
artifact_type: sources
---

# opencode tok/s — decode-rate algorithm source packet

## Decision (implemented in web/src/usage.ts)

```
tokPerSec = tokens.output / (unionDuration(text-part [time.start, time.end]) / 1000)
```

- **Denominator** = union (merge overlapping) of ONLY text-part intervals for
  the turn. Excludes TTFT, tool/shell/subagent `state.time`, and reasoning-part
  `time` intervals.
- TTFT is unchanged: `max(0, firstTextOrReasoningPart.time.start − info.time.created)`.
- Fail closed (null) when: no valid text interval, a text part has `start` but
  no `end` (decode not finalized), or zero-duration parts leave the union at 0.

## Why TextPart.time is the decode boundary

`sst/opencode` is TS/Bun + Effect. Text-part `time.start/end` are set via
`Date.now()` at live AI-SDK stream events:

- **`packages/opencode/src/session/processor.ts`** — the stream processor. The
  `text-start` / `text-end` (and `reasoning-*`) cases stamp `time.start`/`.end`
  with `Date.now()` as live `fullStream` events arrive. `[start, end]` brackets
  first→last decoded token; `end − start` is a faithful decode-active duration
  (network latency cancels inside the duration). Events are live, not buffered.

- **`packages/opencode/src/session/llm.ts`** — drives the live `fullStream` via
  `Stream.fromAsyncIterable`, so the per-part time stamps are emitted as tokens
  decode, not after the turn completes.

- **`packages/opencode/src/session/llm/ai-sdk.ts`** — maps AI-SDK `Usage` into
  the wire `tokens` the daemon forwards.

No provider-level decode timing exists (no first/last-token or decode-duration
field anywhere on the wire). Per-part text time is the ONLY decode-proximate
timing available — this is why the algorithm uses it.

## Why v2 KEEPS per-part time (correcting a stale comment)

The old `web/src/usage.ts` comment claimed "v2 schema drops per-part time".
That is WRONG and has been corrected. Upstream v2 KEEPS per-part `time`:

- **`packages/core/src/session/legacy.ts`** — `SessionLegacy` (the v2 path):
  `TextPart.time` (optional `end`) and `ReasoningPart.time` (required) are
  preserved on the wire. So both TTFT and the decode-rate denominator remain
  valid against v2.

## Wire `tokens.output` is already visible-only — EXCEPT Anthropic

- **`packages/opencode/src/session/session.ts`** — `getUsage()` computes
  `output = outputTokens − reasoningTokens` before exposing `tokens.output`, so
  for providers that break out reasoning, the wire numerator is visible output
  only.

- **`packages/llm/src/schema/events.ts`** — the `Usage` class. **Anthropic does
  NOT break out reasoning** as a separate token bucket, so for Anthropic-only,
  `tokens.output` includes reasoning and there is no way to separate it from
  the wire alone. This is a NUMERATOR caveat (documented in code), not a
  denominator problem — the decode-rate denominator is still the pure text
  window.

## Wire shapes (confirmed, consumed defensively in usage.ts via `(part as any)`)

- Assistant message: `info.time.{created,completed}`; `info.tokens.{output,reasoning}`.
- Text part: `part.time.{start,end}` (both numbers, ms epoch).
- Reasoning part: `part.time.{start,end}`.
- Tool part: `part.state.time.{start,end}` (tool/shell/subagent all use this;
  shell = `tool:"bash"`, subagent = `tool:"task"`).

The daemon (`pkg/state/store.go`) forwards all of this raw and untouched; the
frontend reads past its typed envelope exactly the way the prior code did.
