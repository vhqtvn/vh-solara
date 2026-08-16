---
name: web-e2e-surgery
description: Repeated web/host-web e2e test surgery in vh-solara — use this when fixing a flaky or failing Playwright e2e test, when dispatched a "web e2e regression" or "e2e CI failure" slice, when adding or repairing web/host-web e2e specs, or when a fixture-driven SPA test needs isolation before a minimal fix. Not for Go-side unit/integration tests, not for authoring new test lanes, and not for UI feature work that merely happens to touch a spec.
compatibility: opencode
---

# Web E2E Surgery

Stereotyped procedure for the most expensive repeated build work in this repo
(e2e authoring + flake surgery ≈ 17% of build sessions). The loop is:
**isolate → deterministic red → minimal fix → lane green.**

## Authority boundary

Advisory workflow only. No transition authority, no git mutations (committer
owns those), no test-infra policy changes (new lanes/runners are a coordinator
decision, not a surgery side effect).

## Non-negotiable environment facts (this repo)

- The authoritative test-localization canon is AGENTS.md → **"The eight
  lanes"** (runners, commands, serial constraints, acceptance signals). Follow
  it; this skill never duplicates its command list — when in doubt, re-read
  that section.
- **Web e2e shares ONE mutable fixture backend** (`pkg/fixtures/opencode.go`)
  — the suite runs **serially by design** (`workers: 1`, `fullyParallel:
  false`). Never "fix" a failure by parallelizing; never mutate fixture state
  another spec depends on without checking the shared-state contract.
- **`go` may not be on PATH** — Go commands run as
  `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && …'`
  (env belongs INSIDE the exec payload, never as a host prefix).
- host-web lanes self-bootstrap their servers via the Playwright `webServer`
  config; do not start them by hand.
- Application test lanes run ONLY when the implementation actually changes
  app/test code. Pure spec/skill/docs work still verifies through the lanes it
  edits.

## Procedure

1. **Identify the lane and its runner** from AGENTS.md "The eight lanes"
   (web unit / web e2e / host-web e2e / host-web preview / host-web
   real-embed). *Done when the failing spec's lane, runner command, and
   serial/shared-state constraints are named in your notes.*
2. **Isolate before diagnosing.** Reproduce the single spec in isolation with
   retries disabled (Playwright: `--repeat-each=3 --retries=0` on the one
   spec). *Done when you have a pass-rate for the isolated spec (3/3 green =
   likely interaction flake; deterministic red = real defect).*
3. **For interaction flakes: bisect the shared state.** The fixture backend
   is shared and mutable — find which other spec (or ordering) mutates the
   state your spec depends on. Prefer making the spec self-sufficient over
   re-ordering the suite. *Done when the isolated spec plus its neighbor run
   green together in both orders, or the state dependency is fixed at the
   fixture.*
4. **For deterministic reds: establish the minimal repro** (exact command,
   expected vs observed), then apply the minimal fix — spec-side if the app
   is correct, app-side only with a red-signal-first justification. *Done when
   the red signal from step 2 or the minimal repro above is green and the
   diff is minimal.*
5. **Run the whole lane serially** (the lane's canonical runner command from
   AGENTS.md) — isolation fixes must not break the serial suite. *Done when
   the full lane passes once, twice if the fix touched shared fixture state.*
6. **Typecheck/unit when the frontend changed** — use the touched tree's
   canonical check commands from AGENTS.md "The eight lanes" (web unit /
   typecheck, or the host-web equivalent for host-web edits; do not hardcode
   them here — the canon is authoritative). *Done when the touched tree's
   checks pass.*
7. **Report with receipts.** Lane, isolated pass-rate, root cause (shared
   state | real defect | environment), minimal diff, full-lane command +
   outcome. Park for review; no self-commit. *Done when the report is
   returned.*

## When not to use

- Go unit/integration failures (lane 1–4 territory — plain Go seams).
- New test infrastructure (new lane, new fixture server, CI config) —
  coordinator slice, not surgery.
- A failure you cannot isolate after step 2 — report the isolation evidence
  instead of pattern-shotgunning selectors or timeouts.

## Output shape

Return: lane + spec, isolation result (pass-rate), root-cause class, files
changed, verification commands + outcomes. One paragraph plus a table; the
diff speaks for itself.
