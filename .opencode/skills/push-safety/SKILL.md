---
name: push-safety
description: The ONE sanctioned push verb for vh-solara — route every branch push through the checked wrapper (agents invoke scripts/push-checked.sh via `vh-agent-harness exec`; humans run `make push-checked`) so the mechanical prepush gate runs before any transport. Use this when asked to push, publish, sync, or update a remote branch, when a push-checked run returned exit 1 or 2, or when handling a push receipt. NOT for release tags (release flow), read-only checking (make prepush-check), or commits (gated-commit skill).
compatibility: opencode
---

# Push safety — the one push verb

Three mechanical layers keep CI green: the local changeset-aware gate
(`scripts/prepush-check.sh`), the checked-push wrapper
(`scripts/push-checked.sh`, Phase 2), and the CI changes-gate
(path-filtered lanes + `ci-summary`, Phase 4). This skill is only about
routing pushes onto that stack — it changes no enforcement logic.

## The one verb

Agents (exec-capable, e.g. build):

```bash
vh-agent-harness exec scripts/push-checked.sh [--remote <name>] [<refspec>]
```

Humans (terminal):

```bash
make push-checked           # same wrapper, ARGS passthrough
```

- NEVER raw `git push` — it bypasses the gate (and is mechanically denied
  to agents by shell-guard anyway). Exit-1/2 receipts are terminal: fix
  the cause or re-run the wrapper; falling back to raw push is never the
  remediation.
- Preconditions before invoking: an explicit operator request to push and
  an approved refspec. The wrapper refuses dirty tracked trees — commit
  or stash unrelated work first.

## Authority shape

The model never decides the push. You invoke the wrapper; the wrapper
resolves the exact outgoing objects, runs the gate over exactly that
range, re-verifies every input immediately before transport, and pushes
only the approved sha (never `--force`/`--all`/`--tags`/`--mirror`;
`--no-follow-tags`). A green gate is necessary, never sufficient —
destination permission comes from the operator's request + approved
refspec, not from a green result.

## Exit codes (both scripts)

- `0` — green: pushed / up-to-date (wrapper) or checks passed (gate).
- `1` — a selected check failed (mechanical red). Fix before pushing.
- `2` — refusal / environment / transport failure. Read the receipt's
  `error`; usage and input problems are yours to fix — never bypass them.

`1`/`2` receipts are TERMINAL for that run. No auto-fix-then-push, no
flake reinterpretation, no retry-past-red, no exemptions.

## Receipt hygiene

The wrapper prints exactly ONE JSON receipt line on stdout (schema
`push-checked/1`): it records the remote NAME, never the URL, and its
error text is URL-scrubbed — safe to quote in reports. Raw git stderr
(human progress channel) may contain URLs: quote remote names and
receipts, not raw stderr, anywhere a URL could be parsed.

## Diagnostics routing

- Deterministic check failure (fmt/vet/test/typecheck red) → fix as a
  normal build slice using the `debugging-loop` skill.
- Browser/e2e flake signals after a push → `web-e2e-surgery` skill.
- Refusal (exit 2) → the receipt names the refused input; correct it and
  re-run the wrapper. Do not "work around" a refusal by pushing another
  way.

## When NOT to use

- Release tags → the release flow (`scripts/release-tag.sh` / releaser).
- Read-only "what would run?" → `make prepush-check` or
  `scripts/prepush-check.sh --dry-run` (no push, no mutation).
- Commits → the `gated-commit` skill (committer route).
- Optional human-side companion hook (`.githooks/pre-push`) — installed
  per-clone by the operator via `scripts/install-prepush-hook.sh`;
  bypassable by design, never the enforcement layer of record.

## Standing adoption-gate observables

Encode these as observables, not blockers:

1. First REAL-network-remote push through the wrapper not yet observed
   (F-D3 — fixture evidence is `file://` only). Before general adoption,
   one real-remote push must be observed and its receipt recorded.
2. The first docs-only push validates the Phase-4 CI path filters live
   (expect filtered lane skips + `ci-summary` green).
3. `make prepush-selftest` is due at the next wrapper/checker touch
   (durable self-test; run it whenever `scripts/push-checked.sh` or
   `scripts/prepush-check.sh` changes).

Durable reference: `docs/ai/push-safety.md` (model, taxonomy, receipts,
operator notes).
