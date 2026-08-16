# host-web e2e spec dedup (Finding-8 residue) + docker-route tree-bound receipt

**Date:** 2026-08-16 · **Session:** host-web-dedup (build) · **Slice:** one commit —
9 spec files + this doc.

Two items, one slice:

1. **Finding-8 residue dedup.** Commit `af41692` promoted shared helpers into
   `host-web/tests/e2e/util.ts` (`MOCK_ORIGIN`, `serverUrl()`); settings /
   server-mgmt / viewport-shape were already converted. This slice converts the
   remaining 9 specs that still carried local clones. Pure mechanical dedup —
   no behavior, coverage, timeout, or assertion changes; `util.ts` untouched.
2. **Tree-bound receipt for the docker route** (commit-review DEFER F2
   follow-up). Commit `571e13d` cited "392 passed / 7 skipped / 0 failed, 6.6m"
   for `make test-host-web-docker` without a tree-bound receipt. Re-run on the
   current tree and recorded below per the behavioral-closure retained-receipt
   rule.

## Item 1 — conversion inventory (all 9 files)

All 9 files already had `import * as H from "./util"`; no imports added.

| Spec file | Local clone removed | Use-site conversion |
|---|---|---|
| `workspace-tabs.spec.ts` | `const MOCK_ORIGIN` (+ its 2-line dedicated comment) | 1× → `H.MOCK_ORIGIN` |
| `shell.spec.ts` | `const MOCK_ORIGIN` | 1× → `H.MOCK_ORIGIN` |
| `route-state.spec.ts` | `const MOCK_ORIGIN` | 5× → `H.MOCK_ORIGIN` |
| `attention-next.spec.ts` | `const MOCK_ORIGIN` | 17× → `H.MOCK_ORIGIN` |
| `i3.spec.ts` | `const MOCK_ORIGIN` — **declared but unused** (verified by full-file read: the only local helper `captureOrientation` is pure geometry; zero textual references) | none needed; deleted |
| `interaction-overlay.spec.ts` | `const MOCK_ORIGIN` | 13× → `H.MOCK_ORIGIN` |
| `session-attention.spec.ts` | `const MOCK_ORIGIN` | 6× → `H.MOCK_ORIGIN` |
| `layout-persistence.spec.ts` | local `function serverUrl()` (with function-scoped `MOCK_ORIGIN`) | 1× call → `H.serverUrl("ws-persist")` |
| `survival.spec.ts` | local `function serverUrl()` + module `const MOCK_ORIGIN` (+ dedicated comment) | 1× call → `H.serverUrl("ws-switch-b")` |

**Param-shape check (mission rule 2):** both local `serverUrl()` clones were
diffed param-by-param against `H.serverUrl`. Both build
`new URLSearchParams({ server, view: "chat" })` and return
`` `${MOCK_ORIGIN}/?${q.toString()}` `` — byte-identical output to the shared
helper (the only difference was `layout-persistence`'s `MOCK_ORIGIN` being
function-scoped). **No clone was kept partially; no param-shape mismatch
found.** `WRONG_ORIGIN` constants (interaction-overlay, session-attention) are
a different value (`:9999`) and stay local by design.

Diff shape: 8 const declarations deleted, 2 local `serverUrl` functions
deleted, 43 origin use-sites rewritten to `H.MOCK_ORIGIN`, 2 `serverUrl` call
sites rewritten to `H.serverUrl`. `git grep` confirms zero remaining
`const MOCK_ORIGIN` / `function serverUrl` in `host-web/tests/e2e/*.spec.ts`.

## Item 2 — docker-route tree-bound receipt (F2 follow-up)

Retained receipt (compact, bound to the assessed revision):

- **Command:** `vh-agent-harness exec make test-host-web-docker`
  (agent route documented in `docs/ai/docker-test-routes.md`; full three-engine
  lane 7: chromium + firefox + webkit, serial).
- **Outcome:** exit code 0 — **392 passed / 7 skipped / 0 failed, 6.6m**
  (job window 2026-08-16 10:31:49Z → 10:38:26Z; Playwright summary lines
  `7 skipped` / `392 passed (6.6m)`; no failed/flaky lines, rc=0).
- **Tree binding:** `git rev-parse HEAD` re-derived immediately before launch
  = `571e13d871315fdf0aac03c521e3029bd5d11b3e` (the docker-route commit, as
  the mission expected). Working-tree dirt at run time was exactly the two
  known unrelated files (`docs/planning/backlog.md` modified +
  `researches/sources/2026-08-16-ordering-fix-defer-followups.md` untracked);
  **no host-web/ files were modified** during this run (this session's spec
  edits had not started). Honesty note: a concurrent session committed those
  two files mid-session (HEAD later observed at `f95dff6`); those commits
  touch only `docs/planning/` + `researches/` — the lane-7 read surface
  (host-web/ + tmp/) was byte-identical to `571e13d` throughout the run.

## Item-1 proof — full lane-7 suite post-conversion

- **Post-edit docker full-suite run** (the load-bearing proof):
  `vh-agent-harness exec make test-host-web-docker`, job window 10:57:25Z →
  11:04:03Z, exit 0 — **392 passed / 7 skipped / 0 failed (6.6m)**. Tree =
  HEAD `f95dff6` + the 9 converted spec files (uncommitted, working tree) +
  unrelated concurrent harness-doc churn outside lane 7 (`.vh-agent-harness/`,
  `AGENTS.md`, untracked skills/docs — no host-web content). Totals are
  identical to the pre-conversion run: coverage and outcomes unchanged, which
  is exactly what a behavior-preserving dedup must show.
- **Native run** (`vh-agent-harness exec npm --prefix host-web run test:e2e`,
  10:47:10Z → 10:52:20Z): **265 passed / 7 skipped / 0 failed on
  chromium + firefox** — both engines fully green post-conversion; all 127
  webkit tests failed at `browserType.launch` because the HOST system lacks
  webkit OS libraries (`libevent-2.1-7t64`, `libgstreamer-plugins-bad1.0-0`,
  `libavif16`, `libwoff1`). This is an environmental host limitation, not a
  test or conversion defect; installing host packages at runtime is
  harness-forbidden (`apt-get install` / `sudo npx playwright install-deps`).
  The native result is therefore recorded as a **partial (targeted at the
  engine level)** observation; the full three-engine proof rests on the docker
  route, which exists precisely to remove host-toolchain dependence
  (`docs/ai/docker-test-routes.md`).
- **Typecheck:** `vh-agent-harness exec npm --prefix host-web run typecheck`
  (`tsc --noEmit`) — clean, exit 0, post-conversion.

## Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| HEAD at kickoff = `571e13d…` | `git rev-parse HEAD` → `571e13d871315fdf0aac03c521e3029bd5d11b3e` (before any edit) | yes |
| Docker route green pre-edit (Item-2 receipt) | bgshell job `docker-lane7`: rc=0, `7 skipped` / `392 passed (6.6m)`, 10:31:49Z–10:38:26Z | yes |
| 9 specs converted; no clones remain | `git grep -E "const MOCK_ORIGIN|function serverUrl" host-web/tests/e2e -- *.spec.ts` → no matches; diff = 8 consts + 2 fns deleted, 43+2 use-sites rewritten | yes |
| Local `serverUrl` clones param-identical to shared helper | side-by-side read: both `new URLSearchParams({ server, view: "chat" })` + `${MOCK_ORIGIN}/?${q}` | yes |
| `i3.spec.ts` const truly unused | full-file read (214 lines): only local helper is `captureOrientation` (geometry-only); zero textual refs | yes |
| Typecheck clean post-conversion | `npm --prefix host-web run typecheck` → exit 0 | yes |
| Full three-engine suite green post-conversion | bgshell job `docker-lane7-postedit`: rc=0, `7 skipped` / `392 passed (6.6m)`, 10:57:25Z–11:04:03Z | yes |
| Native suite: chromium+firefox green post-conversion | bgshell job `lane7-native`: rc=1 — 265 passed / 7 skipped; 127 webkit `browserType.launch` host-deps failures | partial (webkit env-blocked) |
| Coverage unchanged (dedup is behavior-preserving) | pre- and post-conversion docker totals identical: 392 passed / 7 skipped / 0 failed | yes |
| HEAD moved mid-session; no host-web files in the move | `git log --name-status 571e13d..f95dff6` → 2 commits touching only `docs/planning/backlog.md` + `researches/sources/…` | yes |

## Deviations & environment notes

- **Native full-suite run could not complete on this host**: webkit is
  uninstallable-without-forbidden-apt on the host (missing system libs). The
  full-suite green claim for Item 1 therefore rests on the post-edit docker
  run (same Playwright suite, same three engines, pinned image). The native
  run is recorded above as a chromium+firefox-only (engine-targeted) green.
- **HEAD moved mid-session** (`571e13d` → `f95dff6`) from concurrent doc-only
  commits; proceeded against the recorded actual HEAD per the mission's
  sequencing rule. The commit slice for this work is exactly the 9 spec files
  + this doc; all other dirt belongs to other sessions and is excluded by the
  commit gate's private-index mechanism.
- No denies fired on any harness command this session. No `util.ts`, popover,
  source, Makefile, docker-plumbing, or playwright-config changes.

<!-- behavioral-closure
deliverable: host-web-e2e-spec-dedup
crux: full host-web lane-7 e2e suite (three engines, incl. all 9 converted specs) green post-conversion — outcome observed via the Playwright summary, not mechanism assertions
verifier: Playwright full-suite runs (docker route for three engines; native route for chromium+firefox) + tsc typecheck
verdict: proven
result: proven
receipt: post-edit docker full-suite 2026-08-16 10:57:25Z–11:04:03Z rc=0 "392 passed / 7 skipped / 0 failed (6.6m)" on working tree = f95dff6 + the 9 converted specs; corroborated by native run 10:47:10Z–10:52:20Z (chromium+firefox green, 265 passed / 7 skipped; 127 webkit launch-failures were host-env missing OS libs — libevent/libgstreamer/libavif/libwoff — installing them is harness-forbidden, environmental, not content); totals identical to the pre-conversion docker run (392/7/0), demonstrating unchanged coverage
-->
