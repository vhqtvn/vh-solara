# 2026-11-16 — Weekly govulncheck Remediation (GO-2026-6859)

Date: 2026-11-16
Scope: Durable record of the remediation and verification for the weekly
scheduled govulncheck CI red (cron Mon 06:00 UTC run of
`.github/workflows/govulncheck.yml`, non-blocking: schedule +
workflow_dispatch only). Mirrors the 2026-10-27 GO-2026-6809 remediation
shape (commit `c3069586`).

---

## 1. The Finding

- `govulncheck ./...` (workflow pin `govulncheck@v1.6.0`, vuln DB
  vuln.go.dev updated 2026-11-11) against the tree at HEAD `3619211`
  (`go 1.26.10`):
  - **GO-2026-6859** — "HTTP/1 server crash due to MaxBytesReader header
    race in net/http". **Standard library**, not a module dependency.
  - Found in `net/http@go1.26.10`, fixed in `net/http@go1.26.11`.
  - **Symbol-level reachable**: govulncheck reported 64 example call traces
    into `net/http` from our server/client code (e.g.
    `server.Daemon.Start` → `http.ListenAndServe`,
    `opencode.Client.SubscribeEvents` → `http.Client.Do`,
    `web.flushWriter.Write` → http2 flush paths). This is what made the
    scheduled run exit red (govulncheck exit 3 = "your code is affected").
- Informational, NOT part of the red (import-level, symbols uncalled —
  govulncheck exit 0 with them present):
  - **GO-2026-6866** — "Check all ancestor namespace transitions when
    rendering raw text in html", `golang.org/x/net@v0.60.0` (indirect
    dep), fixed in v0.62.0.
  - **GO-2026-6860** — "Avoid quadratic complexity when coalescing text
    nodes in html", `golang.org/x/net@v0.60.0` (indirect dep), fixed in
    v0.62.0.
  - Decision: NOT bumped in this slice. The mission is the minimal bump
    that clears the red; uncalled import-level findings do not fail the
    workflow (verified: post-bump scan exits 0 with them still present).
    Recorded here so the next deliberate `x/net` refresh has the IDs.

## 2. The Minimal Fix

Stdlib-level finding → toolchain bump, not a dependency bump (no
`go get -u`, no module versions changed, `go.sum` untouched).

- `go.mod`: `go 1.26.10` → `go 1.26.11` (1 line).
- `Dockerfile` + `Dockerfile.e2e`: `FROM golang:1.26.10-alpine` →
  `golang:1.26.11-alpine` (+ the two invariant-comment references each).
  Required, not optional: both gobuild stages set `GOTOOLCHAIN=local`
  (hermetic builds) and document the invariant that the image's Go MUST be
  >= the go.mod `go` directive or the stage hard-fails — leaving the pins
  at 1.26.10 would break `make docker` builds against go.mod 1.26.11.
  Same shape as the GO-2026-6809 precedent (`c3069586`: go.mod + both
  Dockerfile pins together).
- Scanner pin `govulncheck@v1.6.0` in the workflow: untouched (deliberate
  pin; the vuln DB it reads updates continuously).
- No workflow file changes; no frontend/web changes.

Why the scanner needed a local rebuild (environment note, not repo
change): the pre-existing `$HOME/go/bin/govulncheck` was built with
go1.25 and could not load the go1.26 module graph ("package requires
newer Go version go1.26 (application built with go1.25)"). Rebuilt from
the same workflow pin (`go install golang.org/x/vuln/cmd/govulncheck@v1.6.0`)
before scanning.

## 3. Verification (all bound to the final tree: HEAD `3619211` + the
3-file working diff; docker tag check against digest below)

| Claim | Verifying command/output | Verified |
|---|---|---|
| Finding reproduced pre-fix (GO-2026-6859, symbol-level, stdlib) | `govulncheck ./...` (v1.6.0, DB 2026-11-11) → "Your code is affected by 1 vulnerability from the Go standard library", exit 3 | yes |
| Minimal diff (go.mod 1 line; 2 Dockerfiles pin+comments; go.sum untouched) | `git diff --stat` → `Dockerfile 6, Dockerfile.e2e 6, go.mod 2 (1+/1-)`; `git status --porcelain` → those 3 tracked files plus this new untracked checkpoint (captured at pre-checkpoint tree `3619211`) | yes |
| Build green on go1.26.11 | `go build ./...` → BUILD_OK | yes |
| Go co-located unit lane green | `go test ./pkg/... ./cmd/` → all 23 packages `ok` (incl. pkg/web 134.8s, cmd 47.6s) | yes |
| Integration + in-process e2e green (stdlib patch is runtime-relevant: it replaces the compiled net/http) | `go test ./tests/integration/ ./tests/e2e/` → `ok 41.682s` / `ok 184.038s` | yes |
| Crux: govulncheck clean on final tree | `govulncheck ./...` → "No vulnerabilities found." / "Your code is affected by 0 vulnerabilities.", exit 0 | yes |
| Docker pin valid: `golang:1.26.11-alpine` exists and carries go1.26.11 | `docker run --rm golang:1.26.11-alpine go version` → `go version go1.26.11 linux/amd64` (digest `sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab`) — GOTOOLCHAIN=local invariant holds (image 1.26.11 == go.mod 1.26.11) | yes |

Not exercised in this slice (optional follow-up, unchanged from the
FD1-discharged precedent): full `docker build` of both Dockerfiles. The
FROM pin is proven valid and the module compiles under 1.26.11 locally;
the stages' logic is otherwise untouched.

```behavioral-closure
verdict: proven
path: weekly govulncheck module-graph scan (.github/workflows/govulncheck.yml → `govulncheck ./...` over the repo module graph)
verifier: govulncheck@v1.6.0 (workflow pin; rebuilt locally with a go1.26 toolchain because the stale pre-installed binary was go1.25-built) against the default vuln DB (vuln.go.dev, updated 2026-11-11)
command: vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin && govulncheck ./...'
result: proven
# Receipt: run on the final tree (HEAD 36192115830c1c40068fe8322369c9dc4ceb4efa + the go.mod/Dockerfile/Dockerfile.e2e working diff, identical content to the committed slice). Output: "=== Symbol Results === No vulnerabilities found. / Your code is affected by 0 vulnerabilities." with no error trailer (exit 0), observed 2026-11-16. Pre-fix the same command reported GO-2026-6859 (symbol-level, net/http@go1.26.10, 64 call traces) and exited 3.
```

## 4. Findings

- **GO-2026-6859 stdlib finding**: source=`govulncheck ./...` pre-fix run (v1.6.0, DB 2026-11-11), confidence=high, type=fact
- **GO-2026-6859 cleared by the 1.26.11 directive bump**: source=clean post-bump `govulncheck ./...` on the final tree, confidence=high, type=fact
- **GO-2026-6866 / GO-2026-6860 uncalled in x/net@v0.60.0**: source=`govulncheck -show verbose ./...` (Package Results section, "your code doesn't appear to call these"), confidence=high, type=fact
- **Docker pin invariant requires the FROM bump**: source=Dockerfile/Dockerfile.e2e GOTOOLCHAIN=local comments + `docker run --rm golang:1.26.11-alpine go version`, confidence=high, type=fact
- **Stale local govulncheck binary was go1.25-built**: source=pre-rebuild scan error "application built with go1.25", confidence=high, type=fact

## 5. Contradictions

None detected. The stdlib fix version (go1.26.11) is available on every
toolchain surface this repo uses: local dev auto-downloads it
(GOTOOLCHAIN=auto), CI installs it via `go-version-file: go.mod`
(actions/setup-go), and the Docker gobuild stages get it from the pinned
`golang:1.26.11-alpine` image (GOTOOLCHAIN=local, image-supplied — no
auto-download there by design; digest verified above), so the go.mod bump
does not outrun any surface.
