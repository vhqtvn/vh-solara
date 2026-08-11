// Deterministic verifier for chunk-timeout-backstop.js.
//
// Strategy: CONFIG-INJECTION (no real-stall fixture). The plugin's entire
// behavior is "set omitted provider options.chunkTimeout to 300000, preserve
// every explicit value." That contract is fully observable by constructing
// parsed-config payloads, running the REAL `(await server()).config(cfg)`
// hook (the truest crux — the same path opencode invokes), and asserting the
// post-hook state.
//
// A real-stall fixture would be non-deterministic (network timing, provider
// SDK scheduling) and would NOT exercise any additional plugin codepath: the
// plugin touches only the config object, never the request/stream. So
// config-injection is both the cheapest AND the most faithful verifier.
//
// Coverage matrix:
//   omitted (no options key)        -> 300000 injected
//   omitted (options={} no key)     -> 300000 injected
//   explicit 120000                 -> 120000 preserved
//   explicit 0 (disable)            -> 0 preserved
//   explicit false (disable)        -> false preserved
//   multiple providers independent   -> per-provider contract holds
//   absent cfg.provider             -> no throw, 0 injected
//   empty provider {}               -> no throw, 0 injected
//   provider.options = null         -> creates options, injects
//   cfg null                        -> no throw, 0 injected
//   DEFAULT_CHUNK_TIMEOUT_MS pinned -> === 300000
//
// Run: vh-agent-harness exec node .opencode/scripts/verify-chunk-timeout-backstop.js

import {
    DEFAULT_CHUNK_TIMEOUT_MS,
    applyChunkTimeoutBackstop,
    server,
} from "../plugins/chunk-timeout-backstop.js";

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${label}: expected ${e}, got ${a}`);
    }
}

// Verify the DEFAULT constant is pinned. A change to the injected default is
// a deliberate decision and must update this assertion (and the docstring).
function verifyDefaultPinned() {
    assertEqual(
        DEFAULT_CHUNK_TIMEOUT_MS,
        300000,
        "DEFAULT_CHUNK_TIMEOUT_MS must be pinned to 300000",
    );
    console.log("default-pin verification: ok");
}

// Verify the pure fn directly (tighter assertion on injected-count than the
// hook path can give, since the hook discards the return value).
function verifyPureFn() {
    // omitted (no options key at all) -> inject
    let cfg = { provider: { anthropic: {} } };
    let n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 1, "pure: omitted(no options) should inject 1");
    assertEqual(
        cfg.provider.anthropic.options.chunkTimeout,
        300000,
        "pure: omitted(no options) should set 300000",
    );

    // omitted (options={} but no chunkTimeout key) -> inject
    cfg = { provider: { openai: { options: {} } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 1, "pure: omitted(options={}) should inject 1");
    assertEqual(
        cfg.provider.openai.options.chunkTimeout,
        300000,
        "pure: omitted(options={}) should set 300000",
    );

    // explicit 120000 -> preserve, 0 injected
    cfg = { provider: { zai: { options: { chunkTimeout: 120000 } } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: explicit(120000) should inject 0");
    assertEqual(
        cfg.provider.zai.options.chunkTimeout,
        120000,
        "pure: explicit(120000) should be preserved",
    );

    // explicit 0 (disable form) -> preserve, 0 injected
    cfg = { provider: { zai: { options: { chunkTimeout: 0 } } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: explicit(0) should inject 0");
    assertEqual(
        cfg.provider.zai.options.chunkTimeout,
        0,
        "pure: explicit(0) disable form should be preserved",
    );

    // explicit false (disable form) -> preserve, 0 injected
    cfg = { provider: { zai: { options: { chunkTimeout: false } } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: explicit(false) should inject 0");
    assertEqual(
        cfg.provider.zai.options.chunkTimeout,
        false,
        "pure: explicit(false) disable form should be preserved",
    );

    // explicit null -> preserve (null is NOT undefined), 0 injected
    cfg = { provider: { zai: { options: { chunkTimeout: null } } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: explicit(null) should inject 0");
    assertEqual(
        cfg.provider.zai.options.chunkTimeout,
        null,
        "pure: explicit(null) disable form should be preserved",
    );

    // custom defaultValue honored
    cfg = { provider: { anthropic: {} } };
    n = applyChunkTimeoutBackstop(cfg, 60000);
    assertEqual(n, 1, "pure: custom default should inject 1");
    assertEqual(
        cfg.provider.anthropic.options.chunkTimeout,
        60000,
        "pure: custom default should be applied",
    );

    // multiple providers independent: A omitted, B explicit 120000, C explicit 0
    cfg = {
        provider: {
            a: {},
            b: { options: { chunkTimeout: 120000 } },
            c: { options: { chunkTimeout: 0 } },
        },
    };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 1, "pure: mixed 3-provider config should inject exactly 1 (only A)");
    assertEqual(cfg.provider.a.options.chunkTimeout, 300000, "pure: A omitted -> 300000");
    assertEqual(cfg.provider.b.options.chunkTimeout, 120000, "pure: B explicit -> preserved");
    assertEqual(cfg.provider.c.options.chunkTimeout, 0, "pure: C disable -> preserved");

    // provider.options = null -> creates options object, injects
    cfg = { provider: { anthropic: { options: null } } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 1, "pure: options=null should inject 1 (treated as omitted)");
    assertEqual(
        cfg.provider.anthropic.options.chunkTimeout,
        300000,
        "pure: options=null should create options + set 300000",
    );

    // absent cfg.provider -> no throw, 0 injected
    cfg = {};
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: absent provider should inject 0");

    // empty provider {} -> no throw, 0 injected
    cfg = { provider: {} };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 0, "pure: empty provider map should inject 0");

    // non-object provider entry -> skipped, no throw
    cfg = { provider: { bad: "not-an-object", good: {} } };
    n = applyChunkTimeoutBackstop(cfg);
    assertEqual(n, 1, "pure: non-object provider skipped, good one injected");
    assertEqual(cfg.provider.good.options.chunkTimeout, 300000, "pure: good provider injected");

    // cfg null -> no throw, 0 injected
    assertEqual(applyChunkTimeoutBackstop(null), 0, "pure: null cfg -> 0");
    // cfg undefined -> no throw, 0 injected
    assertEqual(applyChunkTimeoutBackstop(undefined), 0, "pure: undefined cfg -> 0");
    // cfg.provider non-object -> no throw, 0 injected
    assertEqual(applyChunkTimeoutBackstop({ provider: "nope" }), 0, "pure: non-object provider map -> 0");

    console.log("pure-fn verification: ok");
}

// Verify the REAL config hook path — the truest crux. opencode invokes
// `(hook as any).config?.(cfg)` with the cached Config reference; the hook
// mutates cfg in place. This case exercises that exact entry point.
async function verifyHookPath() {
    // Build the server the way opencode does, pull the config hook.
    const hooks = await server();
    assert(typeof hooks.config === "function", "server() must expose a config hook");

    // omitted provider -> hook injects 300000
    const cfg = { provider: { anthropic: {} } };
    await hooks.config(cfg);
    assertEqual(
        cfg.provider.anthropic.options.chunkTimeout,
        300000,
        "hook: omitted provider -> 300000 via real hook path",
    );

    // explicit value preserved through the real hook
    const cfg2 = { provider: { openai: { options: { chunkTimeout: 45000 } } } };
    await hooks.config(cfg2);
    assertEqual(
        cfg2.provider.openai.options.chunkTimeout,
        45000,
        "hook: explicit value preserved via real hook path",
    );

    // hook tolerates null cfg without throwing (defensive contract)
    await hooks.config(null);
    await hooks.config(undefined);
    await hooks.config({});
    console.log("hook-path verification: ok");
}

async function main() {
    verifyDefaultPinned();
    verifyPureFn();
    await verifyHookPath();
    console.log("verification: ok");
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
