# Web unit testing — vitest `--repeats` stance and module singletons

**Status:** current · **Scope:** Lane 5 (`web/tests/unit/`, Vitest)

Vitest's `--repeats=N` flag is **not a supported repo-wide stability tool** for the web unit suite. Running `--repeats` will produce ~13 failing test files, but these failures are expected-by-design rather than latent test rot or flakiness.

## Mechanism and singleton conventions

In Vitest 5.0.5, `--repeats=N` re-runs each test `N+1` times within a single test file execution. However, module scope, `beforeAll` hooks, and the jsdom environment are **not** reset between repeats — only per-test hooks (`beforeEach`/`afterEach`) re-run.

The web unit suite relies on deliberate single-execution conventions and module-level singleton state that `--repeats` inherently trips:

- **Notify de-dupe cache (`web/src/notify.ts:33`):** The `recent` Map is a production feature providing a 4-second suppression window against rapid duplicate notifications.
- **Queue migration guard (`web/src/queue.ts:974`):** The `migrated` Set prevents redundant rescanning once a session has migrated. As documented in `web/tests/unit/queue.test.ts:56-59`, tests route around module-level migration guard state by using unique session IDs per test rather than resetting module state.
- **E-ink live-escape store (`web/src/components/Part.tsx:37`):** The `einkLiveParts` store is module-global and keyed by part ID. As documented in `web/tests/unit/ChatViewEinkEscapeFollow.test.tsx:156-160`, tests allocate unique part IDs per test to avoid leaking escape state between tests.

Because repeat executions re-run the same test body with the same identifiers against unreset module singletons, they trip duplicate suppression, migration locks, or shared escape state. Two of these conventions are consciously documented in the tests' own comments; tests route around them with unique IDs per test, which a repeat re-run breaks.

## Normal runs and historical flakes

- **Zero normal-run risk:** Normal single-execution runs do not encounter these repeat failures. Plain full runs are consistently green. CI executes plain `npm run test:unit` (`.github/workflows/ci.yml:67`); `--repeats` appears nowhere in CI, project scripts, or workflow docs.
- **Historical flakes were different in kind:** The historically real flake class in this suite was load-amplified async timing rather than state accumulation across repeated runs. That class was addressed through controlled test doubles and deterministic barriers (see the `DETERMINISM HISTORY` header in `web/tests/unit/sesSnapshotOwnership.test.ts`, stabilized in commits `060c739` and `7d58e0c`).

## Future flake hunting

If a repeats-based flake hunter is ever desired for this suite, it will require adding explicit test-reset hooks or harnesses for the three named module singletons (`recent` Map, `migrated` Set, and `einkLiveParts` store) before `--repeats` can execute cleanly. This is out of scope today.
