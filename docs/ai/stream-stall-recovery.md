# Stream-stall recovery — `provider.<id>.options.chunkTimeout`

> opencode ships a byte-level inter-chunk timeout that detects half-open provider
> streams and triggers native automatic retry. Set it per-provider; it is **OFF
> by default**. This is the operator-side recovery for the zero-token stream-stall
> failure class.

This is a domain-free core doc. `chunkTimeout` is an opencode setting, not a
harness- or vendor-specific one, so it ships to all consuming repos. Use the
`<provider-id>` placeholder below — do NOT hardcode a provider id here, and do
NOT seed a value in any `opencode.jsonc` template (provider ids are
deployment-specific; that would violate the domain-free-core rule).

## What it does

`provider.<id>.options.chunkTimeout` is a byte-level inter-chunk timeout. When
set, each `reader.read()` in the SSE response stream races a
`setTimeout(chunkTimeout)`; if no bytes arrive within the window the request is
aborted (the fetch controller is aborted and the reader cancelled) and a
`ResponseStreamError("SSE read timed out")` is raised.

That error maps to a retryable `APIError`, which opencode's native retry policy
picks up:

```
chunkTimeout trips on zero-byte stall
  → ResponseStreamError (provider.ts wrapSSE)
  → retryable APIError{isRetryable: true} (message-v2.ts)
  → Effect.retry(SessionRetry.policy(...)) (processor.ts)
  → exponential backoff 2s × 2^n, capped at 30s (retry.ts)
  → session status {type:"retry", next} bus-visible (processor.ts)
```

Both detection AND retry are upstream-native code paths. No harness plugin is
required for the covered failure class.

**How the parent unblocks (transient case).** The parent task-await resolves on
child JOB COMPLETION (`Deferred.await(job.done)`, `background-job.ts:296`), NOT
on retry-status bus publication. So chunkTimeout + native retry unblocks the
parent in the transient case: stall → trip → retry → retry succeeds → turn
completes → child job completes → `job.done` resolves → parent unblocks. The
`{type:"retry", next}` status is bus-visible (useful for observability) but does
not itself drive the unblock.

**Looping case is NOT covered by chunkTimeout alone.** If retry never succeeds
(too-low chunkTimeout + a prompt huge enough to keep failing the time-to-first-
chunk window), the child never completes and the parent STILL HANGS — via the
same timeout-less `job.done` await that produced the original field hang. That
is the separate parked task-await-timeout gap (see the disposition checkpoint),
NOT covered by chunkTimeout. This is why the recommended value is minutes-scale.

Upstream doc: "Timeout in milliseconds between streamed response chunks. If no
chunk arrives within this window, the request is aborted."

## Recommended value

**300000 ms (5 min).**

Rationale:

- `chunkTimeout` is **byte-level**: provider SSE keepalive comments/pings RESET
  the timer, so it only trips on genuine zero-byte stalls.
- Reasoning models legitimately go 60 s+ between visible deltas.
- Therefore a minutes-scale value has near-zero false-positive risk while
  bounding worst-case stall from hours to ~5 min + backoff.

## TTFT + unbounded-retry caveat (important — read this)

`chunkTimeout` bounds **time-to-first-body-chunk** (≈ time-to-first-token for
SSE providers) and all inter-chunk gaps thereafter. The timer starts at the
first body-read AFTER response headers (created inside `ReadableStream.pull()`
at `provider.ts:45-53`); `fetchFn(...)` is awaited (headers received) before
`wrapSSE` is called (`provider.ts:1755-1762`). The request-dispatch-to-headers
gap is bounded by the SEPARATE `headerTimeout` — an optional,
provider-configurable pre-header bound that the OpenAI integration defaults to
300000ms (`OPENAI_HEADER_TIMEOUT_DEFAULT` at `provider.ts:35`, wired at `:208`
and `:1742-1743`); other integrations (e.g. `meta`, `xai`) do not default it
(`config/provider.ts:102-110`). opencode's retry policy
(`packages/opencode/src/session/retry.ts`) has **NO max-attempts cap** — the
only exit is the error ceasing to be retryable.

So **do NOT set this to seconds-scale**. A too-low value (e.g. 30 s) combined
with a prompt large enough to consistently fail to emit a first body chunk
within the window will **loop indefinitely**: each trip is retryable, retry is
unbounded, backoff is capped at 30 s. 5 min is safe; 30 s would not be.

## What it does NOT cover

`chunkTimeout` does not cover:

- A **keepalive-fed stall** — a "server pings but never emits tokens" failure.
  SSE keepalive comments/pings reset the byte-level timer, so the stall evades
  detection.
- **Non-SSE / WebSocket transport paths** — the timer is wired into the SSE
  read loop only.
- A **fully wedged opencode process** — the timer runs inside the opencode
  server process; if the process itself is wedged, no in-process timer can fire.

For these classes, a watchdog plugin is the backstop. A completed design exists
(config-hook injection of `chunkTimeout` as a backstop, plus an event-hook abort
for keepalive-fed stalls), but it is **not yet shipped**: it is parked behind a
named trigger (a keepalive-alive-but-dead stall observed anywhere in the fleet,
a retry-loop incident, or a second consumer stall report of any class). See the
disposition checkpoint for the parked-items list.

## Where to set it

`provider.<id>.options.chunkTimeout`, in either:

- the project `opencode.jsonc` (per-provider under `provider.<id>.options`), or
- the user-global config at `~/.config/opencode/opencode.json`.

Example (domain-free — substitute your provider id):

```jsonc
{
  "provider": {
    "<provider-id>": {
      "options": {
        "chunkTimeout": 300000
      }
    }
  }
}
```

## Cross-references

- The `maxoutputtokens.js` plugin already lists `chunkTimeout` as defense layer
  #1 ("provider.options.timeout + chunkTimeout — kills stuck streams"). See
  `.opencode/plugins/maxoutputtokens.js`.
- The full disposition (observed failure class, root cause with citations, the
  TTFT + unbounded-retry analysis, and the parked backstop items) lives at
  `docs/checkpoints/2026-07-25-stall-disposition-config-first.md`.
