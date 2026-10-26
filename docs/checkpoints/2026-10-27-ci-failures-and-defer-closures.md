# 2026-10-27 — CI Failures and DEFER Closures Verification Record

Date: 2026-10-27  
Scope: Durable record of remediation and verification for two CI-failure fixes, three reviewer DEFERs, and annotation of the archived epsilon-threshold DEFER card.  
Commits on local `main`:
1. `c3069586c5c700ac490a440359a048e4ccf6f7c4` — Fix GO-2026-6809: bump Go to 1.26.10, pin docker golang:1.26.10-alpine
2. `0248798ecb4ff63ad27a9e84331e22d7a5696629` — Fix epsilon-threshold e2e flake: retry an absorbed probe once

---

## 1. GO-2026-6809 Remediation and FD1 Closure Receipt

### Vulnerability Remediation
- Vulnerability `GO-2026-6809` in `crypto/x509` was addressed upstream in Go 1.26.10.
- Commit `c3069586` bumped the `go.mod` directive to `1.26.10` and pinned both Dockerfiles (`Dockerfile` and `Dockerfile.e2e`) to `golang:1.26.10-alpine`.
- Pinning the patch tag prevents the rolling `golang:1.26-alpine` cache trap where older toolchain versions (e.g. 1.26.9) cause `GOTOOLCHAIN=local` build failures.
- Post-bump verification with `govulncheck ./...` returned clean ("No vulnerabilities found.").

### FD1 Reviewer DEFER Closure Receipt
- Commit-review DEFER FD1 requested verification of containerized builds under `GOTOOLCHAIN=local` against the pinned Go 1.26.10 toolchain.
- Full build of `Dockerfile` producing image `vh-solara:fd1-receipt`:
  - Command: `docker build --no-cache-filter=gobuild -t vh-solara:fd1-receipt .`
  - Verified binary runs: `vh-solara dev`
- Target build of `Dockerfile.e2e` producing image `vh-solara-e2e:fd1-gobuild`:
  - Command: `docker build --no-cache-filter=gobuild --target gobuild -t vh-solara-e2e:fd1-gobuild -f Dockerfile.e2e .`
  - Successfully built all test binaries: `e2eserver`, `fakellm`, and `vh-solara`.
- Build conditions:
  - Both builds executed under `GOTOOLCHAIN=local` at clean tree `0248798e` (with `c3069586` ancestor-verified).
  - Base image digest `sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba` confirmed reporting `go1.26.10`.
- FD1 is discharged and closed.

---

## 2. Epsilon-Threshold Flake Fix and DEFERs A1/B1/D1 Closure Receipts

### Flake Mechanism and 2026-10-26 Recurrence Verdict
- Test 18 in `web/tests/e2e/scroll-follow.spec.ts` ("epsilon threshold: small scroll-ups drop following (data for the DEFER card)") experienced a recurrence in CI run 40333545109 (repeat 4/10).
- Telemetry: `dpx=24` absorbed on attempt 1 with `probeMs=1201` and `late=null` (true absorb).
- Diagnosis: Pixel-diff analysis of failure video frames (`f_008` → `f_010`) confirmed a persistent whole-transcript geometry shift concurrent with the programmatic scroll-up write, while the dock remained unchanged. The write raced intentional product absorb paths (viewport-churn guard absorbing `|residual| <= |viewportDelta| + 1`, scrollEl-RO re-pin, or clamp to shrunk maxBottom classifying as reached-bottom).
- Verdict: The single absorb was a write-vs-geometry-churn race, not a threshold shift.

### Landed Fix (Commit `0248798e`)
- Commit `0248798e` introduced a bounded one-retry path for any absorbed delta in the asserted-drop range (`dpx >= 3`):
  - On `late=null` (true absorb), the runner re-glues to tail and retries the delta once.
  - Telemetry: `retried[dpx]` is recorded in `EPSILON_SCAN`.
  - Loud failure contract: If both attempts absorb, `retried[dpx]` remains `false`, `dropped[dpx]` remains `false`, and `expect(dropped[dpx]).toBe(true)` fails loudly. Real threshold regressions remain fully visible.
  - Finite `late` (delayed drop / window stall) is counted as dropped without triggering a retry.
  - Threshold data remains unchanged: `<= 1px` reliably absorbed, `2px` sub-pixel transition zone, `>= 3px` reliably drops.

### Closure of Reviewer DEFERs A1, B1, D1 via Temp Probe
- To demonstrate the retry path in action without permanently modifying the test suite, temp-probe runs were conducted at tree `0248798e` following the 2026-10-25 calibration precedent (commit `b749b37`):
  1. **Absorb-retry mode:** Induced concurrent viewport churn during attempt 1. `EPSILON_SCAN` logged `retried:{"24":true}` in a PASSING run with `probeMs=1202` and `late=null`, exactly reproducing and recovering the run-40333545109 signature.
  2. **Double-absorb mode:** Churn applied to both initial write and retry write. The test FAILED loudly with `dropped["24"]=false` and `retried=false`, confirming that genuine regressions are never masked.
  3. **Late-finite mode:** Delivered scroll event delayed past the 1.2s window. Resulted in `late=875ms` (finite) and was correctly counted as dropped without invoking the retry path; test passed.
- The temporary probe spec was deleted after demonstration.
- Reviewer DEFERs A1, B1, and D1 are discharged and closed.

---

## 3. Working Tree and Local Main Status

- **Commits and Push Status:** At initial checkpoint authoring (2026-10-27), commits `c3069586` and `0248798e` resided on local `main`, with local `main` ahead of `origin/main` by 4 commits:
  1. `c96afc1` — `feat(notify): v4.1 fleet_changed status poke + session_started masking fix`
  2. `1b9ee1e` — `docs(notify): correct v4.1 deploy order and record client verification`
  3. `c3069586` — `Fix GO-2026-6809: bump Go to 1.26.10, pin docker golang:1.26.10-alpine`
  4. `0248798e` — `Fix epsilon-threshold e2e flake: retry an absorbed probe once`
  Push to remote was initially deferred by the operator, but subsequently pushed prior to this checkpoint committing (observed 2026-10-27: `git status -sb` → `## main...origin/main` in sync; `origin/main` HEAD is `0248798e`, with all 4 commits landed on the remote).
- **Working Tree State:** A +12-line comment-only documentation edit detailing the 2026-10-27 retry-path demonstration in `web/tests/e2e/scroll-follow.spec.ts` and this checkpoint file itself (`docs/checkpoints/2026-10-27-ci-failures-and-defer-closures.md`) are the remaining uncommitted working-tree items, pending their gated commit via the committer agent.

---

## 4. Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| GO-2026-6809 fixed by commit c3069586 | `git log -1 --stat c3069586` (go.mod + Dockerfile + Dockerfile.e2e pins to 1.26.10-alpine) | yes |
| govulncheck clean post-bump | `govulncheck ./...` → "No vulnerabilities found." | yes |
| FD1 closure: full docker build under GOTOOLCHAIN=local | `docker build --no-cache-filter=gobuild -t vh-solara:fd1-receipt .` → `vh-solara dev` runs | yes |
| FD1 closure: Dockerfile.e2e gobuild stage | `docker build --no-cache-filter=gobuild --target gobuild -t vh-solara-e2e:fd1-gobuild -f Dockerfile.e2e .` → built e2eserver, fakellm, vh-solara | yes |
| Base image digest reports go1.26.10 | Digest `sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba` reports `go1.26.10` | yes |
| Commit c3069586 ancestor of tree 0248798e | `git merge-base --is-ancestor c3069586 0248798e` | yes |
| Epsilon flake fix commit 0248798e landed | `git log -1 --stat 0248798e` (bounded retry + retried telemetry in `scroll-follow.spec.ts`) | yes |
| Epsilon 2026-10-26 recurrence diagnosed | Pixel-diff of CI run 40333545109 failure video (write-vs-geometry-churn race, late=null true absorb) | yes |
| A1/B1/D1 closure: absorb-retry mode demonstrated | Temp probe on tree `0248798e` → `retried:{"24":true}`, `probeMs 1202/late null`, PASS | yes |
| A1/B1/D1 closure: double-absorb loud failure verified | Temp probe on tree `0248798e` → FAILED loudly with `dropped["24"]=false`, `retried false` | yes |
| A1/B1/D1 closure: late-finite mode verified | Temp probe on tree `0248798e` → `late=875ms` counted dropped without retry, PASS | yes |
| Temp probe spec deleted after demonstration | `git status --porcelain web/tests/e2e/` shows no probe file; scratch probe removed | yes |
| Local main in sync with origin/main | `git status -sb` → `## main...origin/main` (no ahead/behind; in sync through `0248798e`; authored 2026-10-27 when ahead by 4 via `git rev-list --count origin/main..main` → 4, push deferred) | yes |
| Comment-only edit in scroll-follow.spec.ts | `git diff web/tests/e2e/scroll-follow.spec.ts` shows +12 lines comment only | yes |
| Epsilon DEFER card annotated | `grep "2026-10-26 recurrence" .local/coordinator/tasks/archive/defer-scroll-epsilon-threshold-disagreement.json` confirms recurrence verdict, commit `0248798e`, and closure notes | yes |

---

## 5. Findings

- **GO-2026-6809 Remediation**: source=commit `c3069586` and `govulncheck ./...`, confidence=high, type=fact
- **Docker Toolchain Verification (FD1)**: source=Docker builds on tree `0248798e`, confidence=high, type=fact
- **Epsilon Flake Mechanism & Video Pixel-Diff**: source=CI run 40333545109 failure video frames f_008→f_010, confidence=high, type=fact
- **Epsilon Retry Path Demonstration (A1/B1/D1)**: source=temp-probe execution at tree `0248798e`, confidence=high, type=fact
- **Unpushed Commits Status**: source=git log `origin/main..main`, confidence=high, type=fact
- **Working Tree State**: source=working tree `web/tests/e2e/scroll-follow.spec.ts`, confidence=high, type=fact
- **Archived DEFER Card Retention**: source=`.local/coordinator/tasks/archive/defer-scroll-epsilon-threshold-disagreement.json`, confidence=high, type=fact

---

## 6. Contradictions

None detected. Both fixes (`c3069586` and `0248798e`) are verified, reviewer DEFERs FD1, A1, B1, and D1 are receipted, and the epsilon DEFER card is annotated while preserving its original history and threshold conclusions.
