# Push safety — the checked-push stack

Status: Phases 1, 2, 4 landed (`835631c` gate, `dbc3297` wrapper + selftest,
`09c04af` CI changes-gate). Phase 3 = this interface layer: one sanctioned
push verb taught to agents (the `push-safety` overlay skill) + optional
human-side pre-push hook. Phase 3 changes NO enforcement logic.

Spec of record: `tmp/agent-runs/push-safety-20261030/brief.md` (transient) —
this doc is the durable descendant. When they disagree about commands, flags,
or exit codes, the scripts' `--help` output wins; fix this doc.

## The model — three mechanical layers

1. **Local gate** — `scripts/prepush-check.sh` (Phase 1): changeset-aware,
   read-only, no network, no git mutations. Selects the right FAST checks for
   the changeset and exits mechanically (0 green / 1 red / 2 refusal).
2. **Checked transport** — `scripts/push-checked.sh` (Phase 2): resolves the
   EXACT outgoing objects for ONE branch refspec, runs the gate over exactly
   that range, fails closed on anything less than a fresh fully-green receipt
   bound to the exact tree, re-verifies every input immediately before
   transport, then pushes only the approved sha.
3. **CI changes-gate** (Phase 4): path filters on the `push` event only —
   docs-only changesets skip the code lanes; `schedule` and `pull_request`
   keep full coverage; the `ci-summary` aggregate job keeps required checks
   satisfiable.

A push that skips layer 2 lands on layer 3 unchecked by 1. The layers are
mechanical end to end: no auto-fix-then-push, no model-classified-flake
exceptions, no model-issued exemptions, no retry-past-red.

## The one sanctioned push verb

- **Agents** (exec-capable — build is the normal executor):

  ```bash
  vh-agent-harness exec scripts/push-checked.sh [--remote <name>] [<refspec>]
  ```

- **Humans** (terminal):

  ```bash
  make push-checked          # same wrapper; ARGS passthrough, e.g. ARGS='--remote origin'
  ```

- **Never raw `git push`.** For agents it is mechanically denied
  (shell-guard `git-mutation-bypass`); for humans it skips the local gate.
  An exit-1/2 wrapper receipt is TERMINAL for that run — fix the cause or
  re-run the wrapper; falling back to raw push is never the remediation.

### Authority shape (Phase-3 interface ruling)

The model never decides the push. An exec-capable agent *invokes* the
wrapper after an explicit operator request + approved refspec; the wrapper
decides everything load-bearing (scope resolution, check verdict, tree
binding, transport). A green gate is necessary, never sufficient —
destination permission comes from the operator request, not from green
output. The committer's `vh-agent-harness *: DENY` is untouched: the
committer cannot exec wrappers; the wrapper is executor-agnostic and moves
behind an upstream commit-gate `push` verb unchanged if one ever lands.

### Permission trace (rendered `opencode.jsonc`)

The invocation path needs **zero new permission entries**:

- `"vh-agent-harness *": "allow"` already held by `build` (the executor),
  `coordination` (primary), and the global default block — covers
  `vh-agent-harness exec scripts/push-checked.sh …`.
- Shell-guard scans the command string: `scripts/push-checked.sh` contains
  no forbidden token (the `git push` happens inside the wrapper — the E13
  sanctioned-wrapper seam, precedent `scripts/release-tag.sh`).
- `"make *"` has no allowlist entry anywhere — which is exactly why the
  agent-side verb is the script invocation, not `make push-checked` (the
  make target is the human-side spelling).
- The `push-safety` pack ships no `permission-pack.jsonc`: it adds no agent,
  and the only in-repo precedent configures a pack's OWN agent. Deny-side
  narrowing of core agents via a pack is unevidenced and unnecessary — the
  wrapper's own mechanics are the enforcement.

## Exit-code taxonomy (both scripts, mirrored)

| Exit | prepush-check.sh | push-checked.sh |
|---|---|---|
| 0 | green (or `--dry-run`) | pushed, or already up to date (`up_to_date=true`, no transport) |
| 1 | a selected check failed (mechanical red) | prepush check failed — fix before pushing |
| 2 | usage / environment refusal (bad range, not a repo, real-range tree ≠ `<head>`) | refusal / environment / transport failure |

`1`/`2` receipts are terminal. Refusals (exit 2) name their cause in the
receipt's `error` field — usage and input problems are the caller's to fix;
never bypass them by pushing another way.

### Refusal taxonomy (wrapper, initial surface — fail-closed)

Force (`+`), deletions, tags, globs, multi-ref, new branches on the remote,
non-fast-forwards, detached HEAD, no upstream, source branch ≠ current
branch, dirty tracked tree (gitignored dirt never blocks; untracked
non-ignored does; the wrapper never stashes/cleans/reverts to proceed),
unknown remote, ambiguous destination (multiple `pushurl`s or `url`s),
applicable `url.<base>.pushInsteadOf` rewrites, missing/stale/mismatched
prepush receipt, prepush timeout (`PREPUSH_CHECK_TIMEOUT_S`, default 3600),
inputs changed between check and push (HEAD moved, branch moved, tree
dirtied, remote destination moved), transport failure / post-push
verification mismatch. Destination binding: exactly ONE effective push
destination (the single `pushurl` if set, else the single `url`) is used for
checks AND transport; tag transport is neutralized with `--no-follow-tags`.

## Gate selection (what runs locally)

`scripts/prepush-check.sh [--dry-run] [<base>..<head>]`:

- no range → changeset = working tree vs HEAD (tracked mods + ALL untracked
  non-ignored files) — the local pre-commit posture;
- `<base>..<head>` → exactly the two named trees; real runs require the
  clean working tree to BE `<head>` (results that do not bind to the range
  are stale evidence by construction); `--dry-run` reports selection only.

Path-class map (first match wins; conservative — unknown/shared → FULL):
dependency manifests/lockfiles → FULL; `**/*.go` → go; `web/**` → web;
`host-web/**` → host-web; `docs/**`, `researches/**` → docs; tooling
(Makefile, scripts, `.github/**`, `.githooks/**`, `.opencode/**`,
`.vh-agent-harness/**`, tests, tools, `*.sh`/`*.py`/yml/jsonc …) → FULL;
docs filenames (`*.md`, `*.txt`, `*.rst`, `*.adoc`, LICENSE*, …) → docs;
anything else → FULL; any rename/copy/delete not all-docs → FULL; unmerged
porcelain states → FULL.

Tier rule: docs-only/empty → no checks; exactly one non-doc class among
{go, web, host-web} → that class; ≥2 classes or any FULL escalation → all
six. Checks run sequentially, fail-fast:

1. `make fmt-check` (go-fmt — bare `gofmt -l` always exits 0; fmt-check
   fails on non-empty OUTPUT),
2. `make vet`,
3. `make test-unit` (`go test ./pkg/...`),
4. `make typecheck` (web),
5. `npm --prefix web run test:unit`,
6. `make typecheck-host-web`.

**Deliberate omissions** (CI remains authoritative): no web build, no
placeholder-guard, no e2e/browser lanes, no host-web tests. Fast tier is a
strict subset of CI; a green fast tier means "no known local red", not "CI
will be green".

## Receipts and hygiene

Both scripts print exactly ONE JSON receipt line on stdout
(`prepush-check/1`, `push-checked/1`) — full field lists in each script's
`--help`/header. The push receipt records the remote NAME, never the URL;
its error text is sanitized (pinned URL → remote name, residual url-shaped
tokens scrubbed). Raw git stderr (the human progress channel) may contain
URLs. Rules:

- Quote receipts (they are shareable by construction) — never raw stderr —
  anywhere a URL could be parsed.
- The wrapper's receipt binds `pushed_sha`, the prepush sub-receipt
  (`exit`, `tier`, `selected`, `tested_head`, `tree_binding`, `digest`,
  `duration_s`), and timing. Treat a receipt not bound to the tree you
  assessed as stale.
- `PREPUSH_GIT` is a failure-injection test seam; the wrapper UNSETS it for
  the check, and a real push gate must never run shimmed discovery.

## Diagnostics routing

- Deterministic check failure (fmt/vet/test/typecheck red) → normal build
  fix, `debugging-loop` skill.
- Browser/e2e flake signals after a push → `web-e2e-surgery` skill.
- Refusal (exit 2) → read the receipt `error`; fix the named input; re-run
  the wrapper.

## Skill surface (the teaching layer)

`.vh-agent-harness/overlays/push-safety/skills/push-safety/SKILL.md` →
rendered to `.opencode/skills/push-safety/SKILL.md` by
`vh-agent-harness update` (pack selected under `overlays:` in
`.vh-agent-harness/vh-harness-profile.yml`). The skill teaches the one
verb, terminal receipts, hygiene, diagnostics routing, and the adoption-gate
observables below. **Restart caveat:** opencode caches the discovered skill
list per process — a running session does not see the skill until restart.

## Optional human-side pre-push hook (O3)

`.githooks/pre-push` + `scripts/install-prepush-hook.sh`
(`install` / `uninstall` / `status`). Per-clone, operator-installed,
**bypassable by design** (`git push --no-verify`) — a convenience net for
human terminal pushes, never the enforcement layer of record.

- The hook contains no checking logic: every branch update is delegated to
  `scripts/prepush-check.sh <remote-sha>..<local-sha>` (fast tier) under
  `PREPUSH_CHECK_TIMEOUT_S` (default 3600 s). Fail-closed: check red,
  refusal, or timeout blocks the push; `PREPUSH_GIT` in the environment is
  itself a refusal.
- Policy mirrors the wrapper's initial surface: new branches on the remote
  and deletions are refused; non-branch refs (tags — the sanctioned release
  flow) are allowed through with a stderr note.
- Installer preservation rules (fail-closed): refuses if
  `core.hooksPath` is already set to another directory; refuses if the
  COMMON git dir's `hooks/` (where hooks live when `hooksPath` is unset —
  `git rev-parse --git-common-dir`, so a linked worktree's scoped admin dir
  can never mask the shared hooks) holds ANY non-sample hook — switching
  hooksPath would silence them, merge first; idempotent install;
  `uninstall` unsets `core.hooksPath` only when it equals `.githooks`,
  restoring the prior state.
- Agents do not install hooks; installing into the real repo is an operator
  action.

**Hook + installer verification receipt** (disposable clone, fixture
`file://`-style remote under `tmp/` only; real repo git state untouched):

```text
command: bash tmp/agent-runs/push-safety-20261030/p3/hook-test.sh
outcome: 50 passed, 0 failed (2026-10-30) — installer preservation incl.
  linked-worktree common-dir case (T13 red pre-fix, green post-fix),
  foreign-hooksPath refusal, idempotent install/uninstall restore, green
  docs-only push through the real gate with remote advancement, dirty-tree
  fail-closed, new-branch/deletion/multi-ref refusals with remote-unchanged
  assertions, tag allow-through, PREPUSH_GIT hard refusal.
tree binding (content digests of the bytes under test):
  85eaec7055b58232a02cba60034be9b91e8b078cf8724c89877191885105a291  .githooks/pre-push
  01096abab432e5d811a129db22adcdffd30f5bb55aa4665128d3027142475692  scripts/install-prepush-hook.sh
```

Known deferred hook item: the gate invocation inside the hook inherits the
ref-list stdin; a stdin-consuming check could swallow later refs of a
multi-ref push (conditional, no current check reads stdin) — harden with
`</dev/null` at the next touch of `.githooks/pre-push`.

## Standing adoption-gate observables (not authoring blockers)

1. **F-D3 — first real-network-remote push.** All wrapper transport
   evidence to date is `file://` fixtures. Before general adoption, one
   real-remote push through the wrapper must be observed and its receipt
   recorded.
2. **First docs-only push validates Phase 4 live.** Expected: filtered lane
   skips + `ci-summary` green; audit the branch-protection required-check
   list after it.
3. **`make prepush-selftest` is due at the next wrapper/checker touch**
   (durable self-test; run it whenever `scripts/push-checked.sh` or
   `scripts/prepush-check.sh` changes).

## Operator notes

- **Branch protection:** with path-filtered lanes, require the aggregate
  `CI / ci-summary` instead of per-lane checks (skipped required checks
  need the aggregate design to stay satisfiable).
- **Upstream item (do not edit locally):** `.opencode/docs/git-execution-routing.md`
  is embedded-corpus generated and currently documents `git push` only as a
  denied raw mutation — it predates the sanctioned wrapper. Refresh it
  upstream; note locally, never hand-edit.
- **Deferred (deliberate):** upstream commit-gate `push` verb (would let the
  same wrapper logic run committer-side; executor-agnostic today);
  worktree-isolated checking inside the wrapper; background full suite.
- **Rollback of this phase:** deselect `push-safety` in
  `.vh-agent-harness/vh-harness-profile.yml` + `vh-agent-harness update`
  (skill disappears); `scripts/install-prepush-hook.sh uninstall` (hook
  inert); delete this doc. Enforcement layers are untouched.
