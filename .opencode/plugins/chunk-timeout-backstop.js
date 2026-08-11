/**
 * ChunkTimeout Backstop Plugin — bounded fail-safe for stalled SSE streams.
 *
 * SOLE BEHAVIOR (Leg-A, bounded): in the `config` hook, for every provider
 * whose `options.chunkTimeout` is OMITTED (undefined), set it to a 300_000 ms
 * default. Every EXPLICIT value wins — including disable forms (0, false,
 * null) and any positive number a user configured. The plugin never overrides
 * intent; it only fills in the absent.
 *
 * BOUNDED SCOPE — what this is NOT
 * ─────────────────────────────────
 * This is a single defensive backstop, NOT a stall-recovery system. It does
 * NOT:
 *   - solve stalls generally (only arms the byte-level inter-chunk SSE timer
 *     that chunkTimeout controls — see docs/ai/stream-stall-recovery.md);
 *   - bound retries (opencode's retry loop has NO max-attempts cap; a stall
 *     that aborts will be retried indefinitely);
 *   - recover keepalive-fed / non-SSE / wedged-process stalls (chunkTimeout
 *     only fires on inter-chunk byte gaps; a feed that drips keepalive bytes,
 *     a non-SSE transport, or a wedged process that holds the socket open
 *     never trips it);
 *   - provide abort or re-dispatch (Leg-B, the abort+retry path, is
 *     EXPLICITLY OUT: opencode's retryable() never accepts AbortedError, so
 *     an abort is not transparently retryable and a retry shim cannot be
 *     built soundly on top of the current runtime — see closeout).
 *
 * The hook surface is `config` ONLY. No event-driven monitoring, no
 * retry-shim, no abort, no escalation, no toasts, no timers, no
 * session.status/idle/deleted, no message.part.updated, no
 * command.executed, no session.diff.
 *
 * Why the `config` hook works (verified against checked-out opencode):
 *   - Config.get() returns the SAME cached object reference every call
 *     (config.ts:606-608, InstanceState.use(state, s => s.config)).
 *   - plugin/index.ts loads plugins and invokes each config hook with that
 *     reference: `(hook as any).config?.(cfg)` — the hook mutates cfg in
 *     place.
 *   - The provider SDK is built lazily on first chat request (provider.ts:1729,
 *     cached by key), AFTER plugin load, so the config-hook mutation
 *     persists and is observed by the provider at request time.
 *
 * Why inject ONLY when `=== undefined`:
 *   - provider.ts:1741 arms the timer iff `typeof chunkTimeout === "number"
 *     && chunkTimeout > 0`. Disable forms (0, false, null, non-number,
 *     negative) are NOT armed.
 *   - The config schema accepts PositiveInt or ABSENT; 0/false would fail
 *     PARSE. But this plugin runs POST-PARSE in-memory, so defensive
 *     preservation of every explicit value (incl. disable forms) is
 *     future-proof: a later schema relaxation or a programmatic value must
 *     not be silently overridden.
 *
 * See: docs/ai/stream-stall-recovery.md (chunkTimeout semantics)
 * See: researches/decisions/ (defer-007 stall-watchdog solution-brief)
 */

export const id = "chunk-timeout-backstop";

/**
 * The default inter-chunk SSE timeout injected when a provider omits
 * chunkTimeout. 300_000 ms (5 min) supersedes the study's earlier 120_000 ms
 * recommendation: long enough for legitimately slow thinking models between
 * chunks, short enough to kill a wedged stream within a bounded window.
 */
export const DEFAULT_CHUNK_TIMEOUT_MS = 300000;

/**
 * Apply the chunk-timeout backstop to a parsed config IN PLACE.
 *
 * For every provider under `cfg.provider`, if `options.chunkTimeout` is
 * strictly `undefined` (omitted), set it to `defaultValue`. Returns the count
 * of providers that received the injection (for verification and diagnostics).
 *
 * Pure + side-effect-bounded: mutates only the config passed in; reads no
 * module-global state; deterministic given (cfg, defaultValue). Exported so the
 * verifier can assert the injected-count contract directly.
 *
 * @param {object|null|undefined} cfg - parsed opencode Config (may be absent)
 * @param {number} [defaultValue=DEFAULT_CHUNK_TIMEOUT_MS] - value to inject
 * @returns {number} count of providers that received the injection
 */
export function applyChunkTimeoutBackstop(cfg, defaultValue = DEFAULT_CHUNK_TIMEOUT_MS) {
    // Defensive: a null/absent config or provider map fails safely (no-op,
    // zero injected). The plugin must never throw on a malformed payload.
    if (!cfg || typeof cfg !== "object") return 0;
    const providers = cfg.provider;
    if (!providers || typeof providers !== "object") return 0;

    let injected = 0;
    for (const providerID of Object.keys(providers)) {
        const provider = providers[providerID];
        // A non-object provider entry is skipped, not crashed on. The config
        // schema types provider as Record<string, Info>, but this plugin runs
        // post-parse in-memory and must tolerate a hand-constructed payload.
        if (!provider || typeof provider !== "object") continue;

        // Ensure an options object exists so the assignment below cannot
        // throw on `undefined.chunkTimeout = ...`. A provider whose options
        // are explicitly null/absent is treated as omitted (inject).
        if (!provider.options || typeof provider.options !== "object") {
            provider.options = {};
        }

        // THE contract: inject ONLY when strictly undefined (omitted). Every
        // explicit value — including disable forms 0/false/null — is preserved.
        if (provider.options.chunkTimeout === undefined) {
            provider.options.chunkTimeout = defaultValue;
            injected += 1;
        }
    }
    return injected;
}

export const server = async () => {
    return {
        // opencode invokes each config hook with the cached Config reference:
        //   (hook as any).config?.(cfg)
        // The hook mutates cfg in place; no return value is consumed.
        config: async (cfg) => {
            applyChunkTimeoutBackstop(cfg);
        },
    };
};

export const ChunkTimeoutBackstopPlugin = server;

export default {
    id,
    server,
};
