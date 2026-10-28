# Solution Brief: Version-stamping advisory findings

**Date:** 2026-08-20  
**Status:** COMPLETE (solution brief; Option O1 recommended: Makefile accuracy-only, defer F1)  
**Origin:** Version-stamping advisory findings following commit `6645bb5`  

> Promoted-from: tmp/agent-runs/version-stamp-advisories/brief.md  
> Original date: 2026-08-20  
> Provenance: researcher -> debate -> planner pass, 2026-08-20; read-only static source inspection  
> Scope: disposition of three advisory findings left by commit 6645bb5; Makefile accuracy correction.  

---

## Decision frame

- **Question:** How should vh-solara disposition the three advisory findings left by commit `6645bb5e992b2a2d2418ed5b54bd0dac64fd9d2e`, and what exact change set should address any fix-now findings?
- **Objective:** Separate current, evidenced accuracy defects from latent future version-semantics risks.
- **Constraints:** Read-only analysis; no release-workflow or tag-policy changes; no update-flow behavior change beyond the evidence; use actual vh-solara verification lanes; no pytest.
- **Success criteria:** Re-derive the premises, trace current version flows, choose fix-now/defer/drop for each finding, and provide a minimal file list and proportionate verification.
- **Framing confidence:** Not supplied at kickoff; no framing shift occurred.

## Researcher packet summary

### Evidence register

- **E1 (fact, high):** `cmd/opencode_update.go`'s `semverRe`/`normVer` excludes build metadata, so `v1.60.0+dev` normalizes to `1.60.0`.
- **E2 (fact, high):** Current `normVer` callers process OpenCode installed/latest/changelog versions, not vh-solara `cmd.Version`.
- **E3 (fact, high):** `cmd/local-server.go` separately wires `SetAppVersion(Version)` and `SetOpenCodeVersion`; the app and OpenCode version domains do not currently cross.
- **E4 (fact, high):** `pkg/web/opencode.go` uses string inequality for OpenCode installed/running/latest state; it does not compare SemVer precedence.
- **E5 (fact, high):** `cmd/update.go` treats a release as current only when `rel.TagName == Version`. Thus `v1.60.0+dev` is distinguishable from, but not proven newer than, `v1.60.0`.
- **E6 (fact, high):** Existing tests cover core/prerelease SemVer cases but do not pin build-metadata behavior.
- **E7 (inference, high):** F1 is latent under current wiring. Hardening it now would define a contract for a hypothetical future domain crossing rather than fix a reachable defect.
- **E8 (fact, high):** The `fixtures` recipe supplies an ldflag targeting `cmd.Version`, but `tools/fixtureserver` does not import/link package `cmd`.
- **E9 (fact, high):** The fixture server does not call `SetAppVersion`, so its web-server app version remains the server fallback (`dev`) regardless of that ldflag.
- **E10 (fact, high):** Fixture OpenCode installed/running/latest values are explicitly supplied and are separate from vh-solara's app version.
- **E11 (fact, high):** The fixture target's comment claims a stamp that has no observable fixture-server consumer.
- **E12 (fact, high):** The Makefile header's “newer-than/no-equal-to” wording overstates the current exact-equality mechanism.
- **E14 (fact, high):** `cmd.Version` stamping remains useful for real vh-solara binaries and their CLI/skill/MCP/web-app consumers; only its fixture-server use is inert.

### Options compared

1. **O1 — accuracy-only Makefile correction; defer F1:** remove the inert fixture ldflag and claim, correct the comparison wording, and defer parser/API changes until version domains actually meet.
2. **O2 — proactively harden build-metadata handling:** change `normVer`/comparison APIs and add tests, plus Makefile corrections.
3. **O3 — make fixture stamping real:** introduce a fixture-local version variable and call `SetAppVersion`.
4. **O4 — comments only:** correct prose but retain the inert flag.
5. **O5 — no action:** drop all advisories.

Research favored **O1**: it repairs two demonstrated Makefile defects without inventing future version semantics or new fixture behavior.

## Debate outcome

- **Status:** `recommend`
- **Leader:** **O1**
- **Confidence:** Medium-high for the dispositions; medium for the exact future-risk boundary because F1 is latent.

### Per-finding disposition

| Finding | Disposition | Rationale |
|---|---|---|
| F1 — `normVer` strips `+dev` | **Defer with trigger** | The behavior is real, but no current path sends `cmd.Version`/appVersion through the OpenCode version normalizer or comparator. Changing it now would select a speculative API contract. |
| F2 — fixture target carries an inert stamp and overclaim | **Fix now** | The ldflag cannot affect the fixture binary's app version and the comment is false. Remove the dead signal rather than create unsupported fixture behavior. |
| F3 — “newer-than” wording | **Fix now** | Current self-update behavior proves exact non-equality only, not ordering or SemVer precedence. Correct operational documentation now. |

### Corrected F1 trigger

Reopen F1 when a future change does one of the following:

1. passes `cmd.Version` or an app-version derivative into `normVer` or `compareSemver`;
2. changes `cmd/update.go` self-update logic from exact equality to normalization or precedence comparison; or
3. directly compares vh-solara app-version values with OpenCode-version values.

Do **not** use a generic `path_touched(pkg/web/server.go)` trigger. Current dependency direction is `cmd -> pkg/web`, and `pkg/web/server.go` receives an app-version value rather than importing or comparing `cmd.Version`.

### Key objections resolved

- **“This is trivial post-landing churn.”** The changes remove dead build configuration and correct two proven false claims. They are operational accuracy maintenance, not cosmetic redesign.
- **“A future footgun warrants hardening now.”** The risk is credible but unreachable today. `normVer` preservation, SemVer precedence, and a vh-solara-specific `IsDevBuild` helper are different contracts; choosing among them without a caller would be speculative.
- **“Make fixture stamping real instead.”** No UI or test requirement currently needs a stamped fixture app version. Adding one would create behavior solely to vindicate an accidental flag.
- **“Add a regression test now.”** The chosen slice does not introduce or alter runtime semantics. A new behavior test would pin a contract the decision explicitly declines to introduce.

## Planner brief

### Goal

Make the Makefile accurately describe and invoke existing version stamping, without changing runtime version or update behavior.

### Exact change set

- **Single file:** `Makefile`
- **Single slice:** yes; F2 and F3 are two parts of one Makefile accuracy correction.

Change sketch:

1. In the version-stamping header comment, remove “newer-than” and any implication of SemVer precedence. State that a local `<latest-tag>+dev` stamp is distinguishable from / does not exactly equal the corresponding bare release tag under the current self-update equality check.
2. In the `fixtures` target description, remove the claim that it stamps `cmd.Version=$(VERSION)`.
3. In the `fixtures` recipe, remove `-ldflags "$(VERSION_LDFLAGS)"` from `go run ./tools/fixtureserver`.
4. Leave stamping on the actual binary-producing targets unchanged.

### Explicit non-goals

- No edits to `cmd/opencode_update.go` or `cmd/opencode_update_test.go`.
- No new `IsDevBuild` helper yet.
- No edits to `cmd/update.go` behavior.
- No fixture-local version variable or `SetAppVersion` wiring.
- No edits to `pkg/web/server.go`.
- No edits to `.github/workflows/release.yml` or release/tag policy.

### Verification

Direct proof:

```bash
vh-agent-harness exec-ro make -n fixtures
```

Expected: the rendered `go run ./tools/fixtureserver ...` command contains no `-ldflags`/`cmd.Version` stamp.

Regression guard that real binary stamping remains intact:

```bash
vh-agent-harness exec-ro make -n build
```

Expected: the main Go binary build still contains `-ldflags "$(VERSION_LDFLAGS)"` after Make expansion. Review output rather than relying on a fragile grep pipeline.

Diff hygiene:

```bash
vh-agent-harness exec-ro git diff --check
```

Optional conservative targeted regression (not proof of fixture behavior and not full verification):

```bash
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./cmd/...'
```

No new test is required because the fix-now slice changes comments and removes an inert flag; it does not change runtime behavior.

### Acceptance checklist

- [ ] The header no longer claims local builds are “newer than” a tagged release.
- [ ] The header accurately describes exact inequality/distinguishability under current self-update logic.
- [ ] The fixture target no longer claims to stamp `cmd.Version`.
- [ ] The fixture command no longer receives `VERSION_LDFLAGS`.
- [ ] Actual binary-producing targets retain their version ldflags.
- [ ] Only `Makefile` is changed.
- [ ] F1 remains deferred with the corrected trigger recorded in the work item/backlog mechanism selected by the operator.

### Risk and rollback

- **Risk:** Very low. The only executable change removes an inert argument from a developer fixture command.
- **Rollback:** Revert the single Makefile slice through the repository's normal gated git workflow if an unexpected fixture requirement is discovered.

## Contradicted premises

1. **Contradicted:** `+dev` makes a local build “newer than” its corresponding release. Current code establishes exact inequality only.
2. **Contradicted:** the `fixtures` target effectively stamps the fixture server's app version. The symbol is not linked and the server does not call `SetAppVersion`.
3. **Partially contradicted/mislocated:** a future comparison trigger specifically in `pkg/web/server.go`. Current code has no such comparison and importing `cmd` there would invert the existing dependency direction.

## Confidence and remaining uncertainty

- **Overall confidence:** Medium-high.
- **Remaining uncertainty:** A future feature may need to distinguish a release build from `dev`, `+dev`, or `+dirty`. The correct API should be selected when a real caller supplies its requirements. SemVer precedence alone cannot express “development build is newer,” because build metadata is ignored in SemVer precedence.

## Recommended next command

Run `/implement` with this brief, or dispatch the `build` agent with a strict `Makefile`-only scope. Record F1 separately as defer-with-trigger; do not include its implementation in the same slice.
