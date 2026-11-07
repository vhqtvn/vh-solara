package web

// Dockerfile mirror drift guard (F2). web/scripts/materialize.sh needs bash,
// which golang:<tag>-alpine does not ship, so its clean-then-copy contract is
// duplicated as a `RUN find` mirror in exactly two places — Dockerfile and
// Dockerfile.e2e (the gobuild stages) — each carrying a "keep in sync"
// comment. Comments do not force a diff, and NO CI job builds either
// Dockerfile (the e2e-docker lane is not in ci.yml), so without this guard a
// semantic change to the script (or to either mirror) drifts silently:
//
//   - D1: the script's default VH_MATERIALIZE_PRESERVE set grows; the mirrors
//     keep the old names and docker builds DELETE the new tracked fallback.
//   - D2: the clean semantics change shape on one side only (e.g. a weakened
//     find re-opens the ghost-assets defect 316697a fixed, silently, in images,
//     or clause ORDER drifts — an exec hoisted before or mid preserve-set
//     voids the preserve set, D-F1).
//   - D3: a mirror is deleted or duplicated outright — no signal anywhere.
//   - D4: a future edit reorders the clean after the consuming COPY, so the
//     find deletes the freshly copied host shell.
//
// This guard pins each mirror's TEXTUAL find form — clause set, clause
// ORDER, and per-clause shape — against the script's DECLARED default
// preserve set. It does not re-execute the script: the
// script's own behavioral contract is already pinned by materialize_test.go
// (ghost/subdir/preserve/clean-mode), which runs in the same `go test ./...`
// PR job. Pure file parsing — deterministic, milliseconds, no exec, no sleeps.
//
// Anchors (verified unique per file at the time this guard landed):
//   - the clean instruction `RUN find ./pkg/web/host-dist ` (dest adjacent to
//     `find`; the prose comments mention pkg/web/host-dist but never a RUN
//     find, so the RUN prefix keeps comments from matching);
//   - the consuming copy `COPY --from=hostbuild ` … `./pkg/web/host-dist`
//     (the host build stage is named `hostbuild` in both files).

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// destDirArg / findPrefix / copyPrefix are the three textual anchors.
const (
	mirrorDestDir   = "./pkg/web/host-dist"
	mirrorFindLine  = "RUN find " + mirrorDestDir + " "
	mirrorCopyStage = "COPY --from=hostbuild "
)

// materializePreserveRe extracts the canonical default preserve set from the
// `preserve="${VH_MATERIALIZE_PRESERVE-…}"` assignment in
// web/scripts/materialize.sh. Tolerant of surrounding whitespace, but tied to
// the semantic content: any change to the assignment shape (default value,
// variable name, quoting) fails loudly below, forcing this guard to be
// updated in the same slice — exactly the sync decision it exists to force.
var materializePreserveRe = regexp.MustCompile(`(?m)^\s*preserve="\$\{VH_MATERIALIZE_PRESERVE-([^"]*)\}"\s*$`)

// canonicalMaterializePreserve returns the script's default preserve set as a
// name slice (space-separated, like the script itself splits it).
func canonicalMaterializePreserve(t *testing.T) []string {
	t.Helper()
	m := materializePreserveRe.FindStringSubmatch(readRepoFile(t, "web", "scripts", "materialize.sh"))
	if m == nil {
		t.Fatalf(`web/scripts/materialize.sh: preserve="${VH_MATERIALIZE_PRESERVE-…}" default assignment not found — the canonical moved; update this guard in the same slice`)
	}
	return strings.Fields(m[1])
}

// readRepoFile reads a repo file relative to the repo root, using the same
// ../.. idiom as materialize_test.go (tests run with CWD = pkg/web).
func readRepoFile(t *testing.T, path ...string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"..", ".."}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// dockerfileLogicalLines joins backslash line continuations (the find clean
// spans two physical lines in both real Dockerfiles) and collapses whitespace
// runs, so one-line vs two-line formatting and indent churn cannot false-red;
// only semantic token changes can.
func dockerfileLogicalLines(content string) []string {
	raw := strings.Split(content, "\n")
	var logical []string
	for i := 0; i < len(raw); i++ {
		line := strings.TrimRight(raw[i], " \t\r")
		for strings.HasSuffix(line, "\\") && i+1 < len(raw) {
			i++
			line = strings.TrimSuffix(line, "\\") + " " + strings.TrimRight(raw[i], " \t\r")
		}
		logical = append(logical, strings.Join(strings.Fields(line), " "))
	}
	return logical
}

// dockerfileMirrorProblems checks one Dockerfile's host-dist clean mirror
// against the canonical script's default preserve set. Returns human-readable
// problems; empty means the mirror is in sync. Shared by the real-file guard
// and the negative-fixture guard, so both exercise the exact same assertions.
func dockerfileMirrorProblems(file, content string, canonicalPreserve []string) []string {
	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(file+": "+format, args...))
	}
	lines := dockerfileLogicalLines(content)

	// D3: exactly one clean instruction — deletion AND duplication are defects.
	var findIdxs []int
	for i, ln := range lines {
		if strings.HasPrefix(ln, mirrorFindLine) {
			findIdxs = append(findIdxs, i)
		}
	}
	if len(findIdxs) == 0 {
		fail("no %q instruction found (mirror clean deleted?)", mirrorFindLine)
		return problems
	}
	if len(findIdxs) > 1 {
		fail("want exactly one %q instruction, found %d (duplicated clean block?)", mirrorFindLine, len(findIdxs))
		return problems
	}
	findIdx := findIdxs[0]

	// D2/D-F1: pin the clean's find form. Two composed passes over the same
	// token stream — the phase walk pins the canonical clause ORDER, the
	// per-occurrence walk further down pins each clause's FORM.
	tokens := strings.Fields(lines[findIdx])
	seqAt := func(i int, seq ...string) bool {
		if i+len(seq) > len(tokens) {
			return false
		}
		for j, wantTok := range seq {
			if tokens[i+j] != wantTok {
				return false
			}
		}
		return true
	}
	at := func(i int, tok string) bool { return i < len(tokens) && tokens[i] == tok }
	anchorLen := len(strings.Fields(mirrorFindLine)) // "RUN", "find", <dest>

	// Phase walk (D-F1): find evaluates its expression left-to-right with
	// implicit AND, so clause ORDER is semantic — yet the per-occurrence
	// walk alone stays green through an order drift that voids the preserve
	// set (exec hoisted before the ! -name filters, or splitting the set).
	// The mirror's charter is "same find form as materialize.sh", so pin the
	// EXACT canonical sequence that script emits:
	//
	//   1. `-mindepth 1 -maxdepth 1` — first, in that fixed internal order;
	//   2. zero or more `! -name <preserve>` pairs — internal order free
	//      (independent ANDed tests commute; membership is pinned by the
	//      set-equality check below);
	//   3. `-exec rm -rf {} +` — the final clauses, exactly once.
	//
	// Depth-flag placement and internal order are semantically inert (find
	// applies the options globally regardless of position) — those pins are
	// exact-form charter fidelity, not destructive-change catches, and the
	// messages say so. Exec placement is NOT inert: hoisted, it fires for
	// every depth-1 entry; mid-set, it strips protection from the names
	// after it.
	depthMustLead := func(detail string) {
		fail("mirror clean clauses out of canonical order: %q must lead the mirror clean %s — depth-flag placement is semantically inert (find applies the options globally), pinned as exact-form charter fidelity, not a destructive-change catch",
			"-mindepth 1 -maxdepth 1", detail)
	}
	execBeforePreserves := func() {
		fail("mirror clean clauses out of canonical order: %q before the ! -name preserve filters — destructive: with no ! -name test ahead of it the exec fires for every depth-1 entry (the preserved fallback included); trailing filters gate nothing",
			"-exec rm -rf {} +")
	}
	i := anchorLen
	if seqAt(i, "-mindepth", "1", "-maxdepth", "1") {
		i += 4
		preservesBefore := 0
		for i+2 < len(tokens) && tokens[i] == "!" && tokens[i+1] == "-name" {
			preservesBefore++
			i += 3
		}
		switch {
		case i == len(tokens):
			fail("mirror clean clauses out of canonical order: %q must terminate the clean — no exec payload found (the clean deletes nothing)",
				"-exec rm -rf {} +")
		case seqAt(i, "-exec", "rm", "-rf", "{}", "+"):
			i += 5
			switch {
			case i == len(tokens):
				// Exact canonical sequence — nothing may follow, nothing does.
			case i+2 < len(tokens) && tokens[i] == "!" && tokens[i+1] == "-name":
				if preservesBefore == 0 {
					execBeforePreserves()
				} else {
					fail("mirror clean clauses out of canonical order: %q splits the ! -name preserve set — destructive: names before it stay protected (find's implicit AND short-circuits), names after it lose protection and are deleted",
						"-exec rm -rf {} +")
				}
			case at(i, "-mindepth"), at(i, "-maxdepth"):
				depthMustLead("— depth flags found after the terminal exec")
			case seqAt(i, "-exec", "rm", "-rf", "{}", "+"):
				fail("mirror clean clauses out of canonical order: %q must appear exactly once, as the final clauses",
					"-exec rm -rf {} +")
			}
		case at(i, "-mindepth"), at(i, "-maxdepth"):
			depthMustLead("before any ! -name filter")
		}
		// Any other clause head here is alien or malformed — the
		// per-occurrence walk below flags it.
	} else {
		switch {
		case seqAt(i, "-maxdepth", "1", "-mindepth", "1"):
			fail("mirror clean clauses out of canonical order: depth pair swapped — canonical is %q; the swap is semantically inert (find applies -mindepth/-maxdepth globally regardless of order), pinned as exact-form charter fidelity, not a destructive-change catch",
				"-mindepth 1 -maxdepth 1")
		case at(i, "-mindepth"), at(i, "-maxdepth"):
			fail("mirror clean clauses out of canonical order: %q must lead the mirror clean in that exact form and order (canonical form of the shared script's find)",
				"-mindepth 1 -maxdepth 1")
		case i+2 < len(tokens) && tokens[i] == "!" && tokens[i+1] == "-name":
			depthMustLead("before any ! -name filter")
		case seqAt(i, "-exec", "rm", "-rf", "{}", "+"):
			execBeforePreserves()
		}
		// Alien head — the per-occurrence walk below flags it.
	}

	// D1/D2: the mirror's `! -name` preserve set must equal the script's
	// declared default preserve set (order-insensitive — the script emits one
	// clause per name in whitespace order, find semantics are set-wise).
	want := map[string]bool{}
	for _, name := range canonicalPreserve {
		want[name] = true
	}
	got := map[string]bool{}
	for i := 0; i+2 < len(tokens); i++ {
		if tokens[i] == "!" && tokens[i+1] == "-name" {
			got[strings.Trim(tokens[i+2], "'")] = true
		}
	}
	var missing, extra []string
	for name := range want {
		if !got[name] {
			missing = append(missing, name)
		}
	}
	for name := range got {
		if !want[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 {
		fail("preserve mismatch vs script default %v: missing from mirror %v (script default grew, mirror stale?)", canonicalPreserve, missing)
	}
	if len(extra) > 0 {
		fail("preserve mismatch vs script default %v: extra in mirror %v", canonicalPreserve, extra)
	}

	// Per-occurrence form walk: the phase walk above pins the canonical
	// ORDER and the preserve checks above pin the SET, but an ADDED
	// narrowing predicate (-type f, -name '*.js', -size, -newer, a bare
	// -name, extra operators, …) can still ride inside a phase slot in
	// well-formed disguise. Walk the find argument stream and permit ONLY
	// the pinned grammar — validated PER OCCURRENCE, because order/set
	// checks cannot see a decoy clause riding alongside the real one (e.g.
	// a `-exec false x {} +` before the real rm: find's implicit AND makes
	// the rm a silent no-op — exactly the D2 weakening this rejects).
	for i := anchorLen; i < len(tokens); {
		switch {
		case seqAt(i, "-mindepth", "1"), seqAt(i, "-maxdepth", "1"):
			i += 2 // flag + pinned value, validated at this occurrence
		case i+2 < len(tokens) && tokens[i] == "!" && tokens[i+1] == "-name":
			i += 3 // `! -name <preserve>` pair (membership pinned by set equality above)
		case seqAt(i, "-exec", "rm", "-rf", "{}", "+"):
			i += 5 // the exact pinned payload, validated at this occurrence
		default:
			fail("unexpected predicate in mirror clean: %q — only -mindepth 1, -maxdepth 1, ! -name <preserve> pairs, and -exec rm -rf {} + are permitted (exact per-occurrence form); an added or altered predicate silently weakens the clean (D2)", tokens[i])
			i++
		}
	}

	// D4: the clean must precede the hostbuild COPY that fills the cleaned
	// dir — a clean placed after it deletes the freshly copied host shell.
	var copyIdxs []int
	for i, ln := range lines {
		if strings.HasPrefix(ln, mirrorCopyStage) && strings.Contains(ln, mirrorDestDir) {
			copyIdxs = append(copyIdxs, i)
		}
	}
	if len(copyIdxs) != 1 {
		fail(`want exactly one consuming %q…%s COPY, found %d`, mirrorCopyStage, mirrorDestDir, len(copyIdxs))
	} else if copyIdxs[0] < findIdx {
		fail("clean (line %d) must precede the consuming COPY --from=hostbuild (line %d) — a clean after the COPY deletes the fresh host shell", findIdx, copyIdxs[0])
	}
	return problems
}

// TestDockerfileMirrorMatchesSharedMaterializeScript guards both Dockerfile
// mirrors against drift from web/scripts/materialize.sh (see the file comment
// for the D1–D4 drift modes). CI never builds these images, so this lane-1
// test is the only automated coverage of the mirrors.
func TestDockerfileMirrorMatchesSharedMaterializeScript(t *testing.T) {
	canonical := canonicalMaterializePreserve(t)
	for _, name := range []string{"Dockerfile", "Dockerfile.e2e"} {
		t.Run(name, func(t *testing.T) {
			for _, p := range dockerfileMirrorProblems(name, readRepoFile(t, name), canonical) {
				t.Error(p)
			}
		})
	}
}

// TestDockerfileMirrorGuardRejectsDrift is the red-first evidence for the
// guard above: table-driven in-test fixture strings (no file mutations, no
// git state touched) — each fixture is a drift a silent comment sync would
// let through, and each must FAIL the same assertion path the real files
// pass. The baseline row proves the checker is not vacuously red.
func TestDockerfileMirrorGuardRejectsDrift(t *testing.T) {
	canonical := canonicalMaterializePreserve(t)

	// Baseline: the pinned mirror form itself must pass.
	const baseline = `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`
	if probs := dockerfileMirrorProblems("baseline", baseline, canonical); len(probs) != 0 {
		t.Fatalf("baseline fixture must pass the guard, got problems: %v", probs)
	}

	cases := []struct {
		name          string
		content       string
		canonicalOver []string // nil → the real parsed canonical default
		wantProblem   string   // substring that must appear in some problem
	}{
		{
			name: "extra preserve name in mirror",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' ! -name 'host-placeholder.html' -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "extra in mirror",
		},
		{
			name:          "script preserve grew, mirror stale (D1)",
			content:       baseline,
			canonicalOver: []string{"placeholder.html", "extra.html"},
			wantProblem:   "missing from mirror",
		},
		{
			name: "missing -maxdepth 1",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: `-maxdepth 1`,
		},
		{
			name: "narrowing predicate added to the clean (-type f)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 -type f \
    ! -name 'placeholder.html' -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "unexpected predicate in mirror clean",
		},
		{
			name: "decoy -exec before the real rm silently weakens the clean",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec false x {} + -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "unexpected predicate in mirror clean",
		},
		{
			name: "duplicated clean block (D3)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} +
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "exactly one",
		},
		{
			name: "clean runs after the consuming COPY (D4)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} +
`,
			wantProblem: "must precede",
		},
		{
			name: "clean block deleted (D3)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "mirror clean deleted",
		},
		{
			// D-F1 R1: the exec hoisted before all preserve filters — the
			// per-clause checks all pass (every clause is well-formed and the
			// preserve set matches); only the ORDER pin catches it.
			name: "exec hoisted before the preserve filters (D-F1: voids the preserve set)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    -exec rm -rf {} + ! -name 'placeholder.html'
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "fires for every depth-1 entry",
		},
		{
			// D-F1 R2: exec mid-preserve-set. canonicalOver makes the set
			// check pass (both names present), so the ORDER assertion is the
			// one that must fire — names after the exec lose protection.
			name: "exec splits the preserve set (D-F1: names after it lose protection)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist -mindepth 1 -maxdepth 1 \
    ! -name 'placeholder.html' -exec rm -rf {} + ! -name 'host-placeholder.html'
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			canonicalOver: []string{"placeholder.html", "host-placeholder.html"},
			wantProblem:   "names after it lose protection",
		},
		{
			// D-F1 R3: depth flags after the preserve filters — semantically
			// inert (find applies them globally), rejected as non-canonical
			// form; the message must say canonical-order, not destructive.
			name: "depth flags after the preserve filters (D-F1: non-canonical order)",
			content: `FROM golang:1.26.10-alpine AS gobuild
WORKDIR /src
COPY . .
RUN find ./pkg/web/host-dist \
    ! -name 'placeholder.html' -mindepth 1 -maxdepth 1 -exec rm -rf {} +
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
`,
			wantProblem: "must lead the mirror clean",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			canonicalUsed := canonical
			if tc.canonicalOver != nil {
				canonicalUsed = tc.canonicalOver
			}
			probs := dockerfileMirrorProblems(tc.name, tc.content, canonicalUsed)
			if len(probs) == 0 {
				t.Fatalf("drift fixture passed the guard; want a problem containing %q", tc.wantProblem)
			}
			if !strings.Contains(strings.Join(probs, "\n"), tc.wantProblem) {
				t.Fatalf("guard went red, but not on the expected assertion; want a problem containing %q, got:\n%s",
					tc.wantProblem, strings.Join(probs, "\n"))
			}
		})
	}
}
