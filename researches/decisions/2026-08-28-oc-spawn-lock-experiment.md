# oc-spawn-lock-experiment — verdict report

> NOTE: Promoted from tmp/agent-runs/oc-spawn-lock-experiment/report.md to researches/decisions/2026-08-28-oc-spawn-lock-experiment.md
> Date: 2026-08-28
> Context: Backlog card P1-API-002; follows commit eb03548 split-brain guard.
> Operator-accepted decisions: two-role flock; ExtraFiles; orphaned-owner = report-never-auto-spawn; both DEFERs folded into the implementation slice.
> Implementation was dispatched against these records.
> Evidence command: `bash tmp/agent-runs/oc-spawn-lock-experiment/run_matrix.sh` (the reproducible harness scripts live in disposable tmp; the matrix is summarized inline in this report and was fully run to 0/15 racehammer violations).

**Backlog:** P1-API-002 (detached-OpenCode spawn-slot ownership)
**Brief:** `tmp/agent-runs/oc-spawn-serialization-brief/brief.md` (decision `need_evidence`)
**Date:** 2026-08-28 · **Harness:** this directory (runnable, see §7) · **No repo source changed.**

## 0. Answer

**Yes — a small Linux primitive suffices; a guardian architecture is NOT required.**

The winning shape is a **two-role flock(2) protocol on two lock files**:
a *starter-role* lock (parent-held, acquire → state publication) and an
*owner-role* lock whose open file description is created by the parent
**before fork** and passed to the detached `opencode serve` child as **fd 3**
(via `cmd.ExtraFiles`), then **immediately closed by the parent** —
close-only, never `LOCK_UN`. The parent becomes structurally *unable* to drop
the child's lock after `Start()` returns, because it no longer holds any fd
referencing that description. Exclusion is then exactly coextensive with the
opencode process (and any descendant that inherits fd 3).

This was verified end-to-end against the **real opencode binary** (v1.18.23),
not just the `sleep` stand-in. The pre-exec-shim variant (child opens its OWN
description post-fork) also passes the full crash matrix and is the fallback
if the parent must never touch the owner description at all.

## 1. The opencode fd-propagation FACT (crux empirical input)

**Claim: `opencode serve` retains stray non-CLOEXEC inherited fds (fd ≥ 3)
for its whole process lifetime, and propagates them into long-lived
descendants. Neither the runtime nor opencode source closes them.**

Source citations (from `refs/opencode/`, verified this session):

| Fact | Citation |
|---|---|
| Distribution = Bun single-file compiled native binaries (also a Node launcher `bin/opencode` that re-spawns the platform binary with `stdio: "inherit"`) | `refs/opencode/packages/opencode/script/build.ts` (~L160-185, `compile.target bun-linux-x64`, outfile `dist/<name>/bin/opencode`); `refs/opencode/packages/opencode/bin/opencode` (`#!/usr/bin/env node`, `childProcess.spawn(target, argv, {stdio:"inherit"})`) |
| `serve` stays foreground; no daemonize / re-exec / setsid | `refs/opencode/packages/opencode/src/cli/cmd/serve.ts` (`Server.listen(opts)` then `yield* Effect.never`) |
| No close-unknown-fds / close_range anywhere in runtime paths | grep over `packages/opencode/src` + `packages/core/src` for `close_range\|CLOSE_RANGE\|daemonize\|setsid\|reexec`: empty |
| All subprocess spawning uses explicit stdio arrays only; nothing closes inherited fds | `refs/opencode/packages/opencode/src/util/process.ts` (~L67: `stdio: [stdin??ignore, stdout??ignore, stderr??ignore]`); LSP: `src/lsp/launch.ts`; MCP stdio servers spawn through the same `Process.spawn` |
| Data dirs are XDG-based (safe test isolation) | `refs/opencode/packages/core/src/global.ts` L11 (`path.join(xdgData!, app)`) |

Empirical confirmations:

1. **Real binary, this session** (`realoc` subcommand, run `results/realoc/`):
   spawned real `opencode serve --port 40091 --hostname 127.0.0.1` with
   `ExtraFiles = [owner.lock fd]`; observed
   `/proc/1126901/fd/3 -> …/results/realoc/owner.lock` for the process
   lifetime; the flock was held (non-blocking acquire by others →
   `EWOULDBLOCK`) while opencode lived, and was released the moment it exited
   on SIGTERM. Output: `RETAINED=true EXCL_DURING=true RELEASED_AFTER_EXIT=true`.
2. **Live production instance**: pid 755845 (`opencode serve --port 46869`)
   holds fd1/fd2 as pipes inherited from vh-solara and has 4 long-lived
   `npm exec @z_ai/mcp-server` children — inherited non-CLOEXEC descriptors
   demonstrably flow into long-lived descendants.
3. Installed binary here: `/home/vhnvn/.npm-global/bin/opencode` →
   `lib/node_modules/opencode-ai/bin/opencode.exe`, ELF 64-bit x86-64
   (Bun-compiled), version 1.18.23.

**Version/runtime caveat:** retention is a *property of current code*, not a
contract. Both distribution shapes (Bun ELF directly; Node launcher →
platform binary) currently preserve stray fds, because neither Bun nor Node's
`spawn` closes non-CLOEXEC parent fds and opencode has no close loop. An
upstream opencode change that closes unknown fds at startup (or a runtime
change to inheritance defaults) would break **every** fd-passing design
equally — including a guardian's, if the guardian passes no fd and relies on
pid-liveness instead (which is the status quo the incident disproved). The
protocol should therefore *verify* retention at spawn time: after `Start()`,
readlink `/proc/<childpid>/fd/3` once; if missing, kill the child and fail
closed (do not spawn unowned).

## 2. Verdict table (full matrix: `results/summary.tsv`)

Legend — **B** = concurrent starter started after starter A hit the barrier;
"standins" = live stand-in "opencode" processes after B ran. PASS requires:
B never spawns while A's child lives (standins ≤ 1), B returns promptly,
C can spawn after the true owner chain exits.

| Mechanism | before-start crash | post-start crash (pre-ready) | post-ready crash, pre-state | post-state crash | state-write-failure path | contended (A mid-flight) | normal completion | grandchild retains fd after owner+standin die | racehammer (post-start crash × B-immediate) |
|---|---|---|---|---|---|---|---|---|---|
| **flock2** (two-role, separate descriptions) | PASS · B spawns (no owner ever existed) | PASS · B=OWNER_HELD 3ms | PASS · B=OWNER_HELD 3ms | PASS · B=OWNER_HELD 3ms | PASS · B=OWNER_HELD 3ms (error path released starter lock only) | PASS · B=OWNER_HELD 3ms | PASS · B=OWNER_HELD 3ms (owner still held by live child) | PASS · B=OWNER_HELD while orphaned `sleep` holds fd3→owner.lock; C spawns after sleep killed | **0/15 violations** |
| **ofd2** (F_OFD_SETLK two-role) | PASS · 24ms spawn | PASS · 3ms | PASS · 3ms | PASS · 3ms | PASS · 3ms | PASS · 4ms | PASS · 3ms | PASS · fd3→owner.lock | **0/15** |
| **abstract2** (abstract unix socket, fd=bind) | PASS · 25ms spawn | PASS · 3ms | PASS · 4ms | PASS · 3ms | PASS · 4ms | PASS · 3ms | PASS · 3ms | PASS · fd3→socket:[…] | **0/15** |
| **parentonly** (O1 baseline: parent-only flock) | PASS (trivially) | **FAIL** · B spawns, standins=2 (double-spawn beside live child) | **FAIL** · standins=2 | **FAIL** · standins=2 | **FAIL** · standins=2 | PASS (only while A lives) | PASS only while daemon lives; **FAIL after daemon restart**: B spawned beside live child (`statefail-alive +restart:SPAWNED`) — the 2026-08-28 incident reproduced | n/a | n/a |
| **inheritshared** (O1b baseline: shared description via fd 3 + parent LOCK_UN) | PASS | PASS · B=CONTENDED (crash frees nothing — description alive via child's fd) | PASS · CONTENDED | PASS · CONTENDED | **FAIL** · explicit LOCK_UN drops the child's lock → B spawns, standins=2 | **FAIL** · A's completion unlock → B spawns beside live child | **FAIL** · standins=2 (release-after-publication) | n/a | n/a |

**B-loser latency (invariant 2):** every non-spawn decision returned in
**2–4 ms** (flock2/ofd2/abstract2, all barriers); the spawn path (legitimate
winner) took ~24 ms including child spawn + recheck. Compare: today's
classify path can block a loser ~13 s (probe) + 30 s (readiness) ≈ 43 s.

**Invariants 3 & 4:** starter C always spawned after the true owner chain
(including fd-holding grandchildren) exited — every row shows `C=SPAWNED`
after cleanup; no loser was ever required to die (B is an independent
process that exits normally with code 3 `OWNER_HELD` / 2 `CONTENDED`).

## 3. Recommended primitive + protocol sketch

**Primitive: `flock(2)` on two files** (owner lock optionally
`fcntl(F_OFD_SETLK)` — both matrix-clean; abstract-socket binding is a
viable third variant that sidesteps the filesystem entirely).

Files (next to the existing state file):
`<UserConfigDir|VH_STATE_DIR>/vh-solara/opencode/<sha1(cwd)>.spawn.lock`
(starter-role) and `…/<sha1(cwd)>.owner.lock` (owner-role).

Protocol:

1. **Acquire** — starter non-block `flock(EX|NB)` on `.spawn.lock`
   (opened WITH `O_CLOEXEC`). `EWOULDBLOCK` → another starter is mid-flight:
   return `CONTENDED` immediately (ms). *Never* wait out the other starter's
   classification/readiness.
2. **Owner test** — non-block test `.owner.lock` *without holding it*
   (open CLOEXEC, try, unlock, close). Held → the slot has a live owner:
   apply the incident policy — **do not spawn, do not probe for 13 s**;
   fall through to reattach-or-report (below).
3. **Spawn (the gap-free handoff)** — open `.owner.lock` WITHOUT `O_CLOEXEC`,
   `flock(EX|NB)` **before fork** (must succeed — we held the starter lock
   and the owner test was free), set `cmd.ExtraFiles = [ownerLockFile]`
   (→ fd 3 in the child, non-CLOEXEC by construction), `cmd.Start()`.
   **Immediately after Start: verify retention**
   (`readlink /proc/<pid>/fd/3` == owner lock path; if missing → kill child,
   fail closed), then `Close()` the parent's copy. The parent now holds NO
   fd of that description — **no later code path can unlock it**. This is the
   escape from the brief's O1b rejection: the failure there was the explicit
   `LOCK_UN`, not the inheritance; `close()` on one reference never drops a
   flock held via another.
4. **Readiness → publication** — wait readiness as today, `writeOCState`
   (its error handling stays a separate known defect, but the mechanism no
   longer depends on it), then release the *starter* lock and exit the spawn
   path. Normal completion leaves the owner lock held by the child — correct,
   because the child outlives publication (Gate 2 of the brief).
5. **Loser behavior** — `CONTENDED` or `OWNER_HELD`, both fast-fail:
   - state exists + pid alive + cmdline matches → reattach as today;
   - owner held but state stale/pid dead → **orphaned owner** (opencode died
     but an MCP/LSP descendant retains fd 3): do not spawn; report the
     fd-holders (discoverable: `readlink /proc/*/fd/*` == owner lock path)
     and let the operator kill them; a starter C spawns as soon as the last
     holder exits (matrix-verified, including the orphaned-grandchild case).
6. **Crash semantics** — parent SIGKILL at *any* boundary leaves either
   (a) no child yet + freed locks (clean), or (b) a live child holding the
   owner lock (protected). There is no window where a live child exists
   without owner coverage, because the owner description is created and held
   *before* `fork(2)` and the starter lock serializes all competitors.

**Alternate (also matrix-proven): pre-exec shim.** Spawn through a shim that
opens its OWN description, `flock`s non-blocking, `dup2`s to fd 3 and `exec`s
opencode; a shim that loses the acquisition exits before exec, and the
starter rechecks (this closed the post-start µs race to 0/15 violations
across 45 hammered reps). The shim can literally be util-linux
`flock -n <owner.lock> -- opencode serve …` (it execs without forking, so
the pid/cmdline match in `ocCmdlineMatches` still holds) — at the cost of an
external-binary dependency. Choose the ExtraFiles shape unless "parent never
touches the owner fd" is preferred for auditability.

**Why not guardian (O3):** every invariant is satisfied by ~40 lines of
stdlib Go around `flock`; a guardian adds a supervisor process whose *own*
crash/restart lifecycle reintroduces exactly the coordination problem it
solves. Guardian is justified only if future requirements demand
timeout-based takeover of a wedged-but-alive owner — out of scope for the
incident policy ("probe refused + pid alive + cmdline match ⇒ NEVER spawn").

## 4. Nuances, caveats, ambiguities

- **The brief's O1b rejection is refined, not contradicted:** the shared
   description is *crash-safe* (parent SIGKILL leaves the lock alive via the
   child's fd — matrix rows `inheritshared/post-*` all PASS). It fails
   *exactly and only* on explicit-unlock paths (state-failure release,
   release-after-publication). The recommended protocol makes those paths
   structurally impossible (parent closes its only fd immediately after
   Start; it never calls LOCK_UN on the owner lock at all).
- **Grandchild conservatism:** if opencode dies but an MCP/LSP child lives,
   exclusion persists (never-double-spawn preserved; availability deferred
   until holders die or are killed). This is the correct bias under the
   incident policy but must be surfaced in UX (orphaned-owner report).
- **Upstream risk:** opencode closing stray fds at startup would break all
   fd-passing designs → spawn-time retention check + fail-closed (§3 step 3).
- **Filesystem assumption:** `flock` on NFS/sync-mounted homes is unreliable;
   `UserConfigDir`/`VH_STATE_DIR` should be on local fs (usually true;
   worth asserting). The abstract-socket variant avoids this entirely if it
   ever matters (matrix-clean; note the ~107-byte sun_path name budget — use
   the project hash only, as the harness's role-based naming bug showed).
- **Bun vs Node packaging:** identical behavior — the Node launcher
   (`bin/opencode`) re-spawns the platform binary with `stdio:"inherit"`,
   which also propagates non-CLOEXEC fds; the Bun ELF retains directly
   (empirically confirmed here on the ELF).
- **B latency context:** 2–4 ms decisions; the harness's `before-start`
   spawn verdicts (~24 ms) include an actual child spawn + 2 s-capped recheck
   loop that exits on first success.

## 5. Harness incidents (recorded for the re-debate)

1. **CLOEXEC leak contaminated the first parentonly run** — the starter's
   lock fd was opened without `O_CLOEXEC`, so parentonly's stand-in inherited
   it and silently turned the baseline into a shared-description design
   (post-crash `CONTENDED` instead of the true failure). Fixed by CLOEXEC on
   all starter-side opens. *The bug itself is a live demonstration of the
   core fact: an inherited non-CLOEXEC fd keeps a flock alive past parent
   death.*
2. **Abstract-name overflow:** the first `abstractName()` embedded the full
   lock path (>108 bytes → `EINVAL`); fixed to role-based names.
3. **Driver foot-guns:** relative-path `pgrep` broke cleanup; `kill -9 0` on
   a missing pid killed the driver's own process group (hung the first full
   run). Both fixed; `timeout` guards added.
4. Cosmetic: stand-in fd dumps show `3->?` for the dump's own transient
   `/proc/self/fd` dirhandle when fd 3 is otherwise closed — not a leak.

## 6. What is decided vs ambiguous

- **Decided by evidence:** two-role flock (and OFD, and abstract-socket)
  passes all four invariants across the full deterministic crash matrix;
  parentonly fails on every parent-death path; inheritshared fails on every
  explicit-unlock path; real opencode retains fd 3 and its lock lifetime is
  exactly the process lifetime.
- **Ambiguous / deferred to the re-debate:** ExtraFiles-vs-shim (both proven;
  ExtraFiles recommended for zero moving parts + structural no-unlock);
  orphaned-owner UX (report-only vs assisted reap); whether `writeOCState`
  error handling is fixed in the same slice (orthogonal, but the mechanism
  no longer depends on it); abstract-socket vs lock-file operability
  (readlink discoverability favors lock files).

## 7. Harness (re-runnable)

```bash
export PATH=$PATH:/usr/local/go/bin
cd tmp/agent-runs/oc-spawn-lock-experiment
(cd harness && go build -o ../vhspexp .)   # build
bash run_matrix.sh                          # full matrix → results/summary.tsv
bash run_matrix.sh quick                    # flock2 only
timeout 60 ./vhspexp realoc -runDir results/realoc   # real opencode fd-3 test
./vhspexp probe -mode flock2 -runDir <dir>  # lock-state inspection
```

Sources: `harness/main.go` (starter/shim/standin/probe/realoc; modes
flock2/ofd2/abstract2/parentonly/inheritshared), `harness/probe_abs/`
(abstract-socket isolation probe), `run_matrix.sh` (barriers: before-start,
post-start, post-ready, post-state, statefail-release, statefail-alive,
contended, normal, grandchild, racehammer ×15). Raw logs under `results/`.

## Amendment (2026-08-29) — the 2–4 ms loser figure is harness-accurate, not landed-code-accurate

> NOTE: Dated amendment; every historical section above is preserved
> unchanged.
> Date: 2026-08-29
> Context: P1-API-002 advisory-cleanup slice that followed the landed
> implementation (classify gate + two-role flock + serialized restart:
> commits eb03548, ef8e084, a0f3312).

§2's B-loser latency claim — "every non-spawn decision returned in 2–4 ms" —
is accurate FOR THE HARNESS: the experiment's loser B never classified; it
short-circuited on the lock verdicts alone. The LANDED contended loser runs
`classifyOCInstance` once when the recorded state looks reattachable (pid
alive + cmdline match), paying the probe budget — ~1 s refused-fast, ~7.5 s
with one timing-out endpoint per attempt, ~13 s worst case (3 attempts × 2
endpoints × 2 s timeout + 2 × 500 ms retry gaps) — before returning Occupied
(or reattaching at once when the probe succeeds). That is bounded by the
classify probe ALONE and never the winner's ~13 s classification + 30 s
readiness budget, which is what invariant 2 actually promises. Losers with
no recorded state, or with a dead/foreign recorded pid, remain
millisecond-fast. The landed behavior lives in the contended arm of
`EnsureDetachedOpenCode` (cmd/opencode_start.go).
