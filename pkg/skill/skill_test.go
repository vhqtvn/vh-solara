package skill

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/mcp"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

func TestGenerateIsVersionStampedAndFromLiveSurface(t *testing.T) {
	out := Generate("v9.9.9-test")

	// Version-stamped (header + frontmatter).
	if strings.Count(out, "v9.9.9-test") < 2 {
		t.Fatalf("skill must be version-stamped, got:\n%s", out)
	}

	// Every MCP tool (the verb source of truth) is documented — drift-proof.
	for _, tool := range mcp.ToolDefs() {
		name := tool["name"].(string)
		if !strings.Contains(out, "`"+name+"`") {
			t.Fatalf("generated skill missing verb %q", name)
		}
	}

	// Every gate{} field (reflected) is documented — a new field can't go missing.
	tp := reflect.TypeOf(state.GateFacts{})
	for i := 0; i < tp.NumField(); i++ {
		name := strings.Split(tp.Field(i).Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		if !strings.Contains(out, "`"+name+"`") {
			t.Fatalf("generated skill missing gate field %q", name)
		}
	}

	// Key contract points present.
	for _, must := range []string{"last_assistant_empty", "If-Idle-Seq", "--vh-sock", "X-VH-Epoch", "X-VH-CSRF"} {
		if !strings.Contains(out, must) {
			t.Fatalf("generated skill missing contract point %q", must)
		}
	}

	// Server-managed state docs section (labels/pins/queue): the three subsection
	// headers + key per-surface contract anchors must all render. Mirrors the
	// existing drift-proof style — a dropped p() line fails loudly.
	for _, must := range []string{
		"## Server-managed state docs",
		"### Labels (root-session groups + tags)",
		"### Pins (pinned session order)",
		"### Queue (per-session work distribution)",
		"/vh/labels",
		"/vh/pins",
		"/vh/session/{sessionId}/queue",
		"labels.snapshot",
		"labels.updated",
		"pins.snapshot",
		"pins.updated",
		"baseRevision",
		"tagIdsByRootSessionId",
		"orderedSessionIds",
		"unknown_session",
		"unknownIds",
		"unknown_root",
		"initializeOnly",
	} {
		if !strings.Contains(out, must) {
			t.Fatalf("generated skill missing server-managed-state anchor %q", must)
		}
	}
}

// gateAction is the decision the env-driven deny-list gate makes after reading
// GITHUB_ACTIONS, VH_CI_TRUSTED, and VH_SKILL_BANNED_TOKENS. It is extracted as a
// PURE function so the decision table (TestDecideGateAction) can prove every
// branch — including gateFatal, whose env combo (GITHUB_ACTIONS=true +
// VH_CI_TRUSTED=true) never exists in a local `go test` and is therefore
// otherwise unreachable in-process. TestGenerateHasNoBannedTokens routes its
// skip/fatal/scan switching through this helper, so the table test and the
// subprocess reentry tests exercise the identical branching (one source of
// truth). Routing through it is behavior-preserving vs the prior inline
// if/skip/fatal.
type gateAction int

const (
	// gateSkip: deny-list unset AND not a trusted-CI context → preserve the
	// local/fork-PR convenience skip.
	gateSkip gateAction = iota
	// gateFatal: deny-list unset AND trusted-CI → fail loud so an unconfigured CI
	// cannot pass as if it had scanned (forces the operator to wire the
	// VH_SKILL_BANNED_TOKENS repo secret).
	gateFatal
	// gateScan: deny-list SET → always scan the generated doc for every listed
	// token, regardless of CI flags.
	gateScan
)

// decideGateAction is the pure, env-free form of the deny-list gate predicate.
// denyListSet means VH_SKILL_BANNED_TOKENS is non-empty. githubActions and
// vhCITrusted mirror os.Getenv(...)=="true" for the two CI-trust signals.
func decideGateAction(githubActions, vhCITrusted, denyListSet bool) gateAction {
	switch {
	case denyListSet:
		return gateScan
	case githubActions && vhCITrusted:
		return gateFatal
	default:
		return gateSkip
	}
}

// TestGenerateHasNoBannedTokens guards the anonymization invariant: the
// generated skill doc must never reference any adopter/customer. The guard has
// two halves. (1) A sentinel self-check runs UNCONDITIONALLY — it injects a
// known sentinel into a copy of the output and verifies the scanner catches it,
// so the scanner logic itself is machine-enforced on every run (never vacuous).
// (2) The real customer-token deny-list is env/secret-sourced via
// VH_SKILL_BANNED_TOKENS (comma-separated) so that no real customer token is
// ever committed as a test fixture. LOCALLY the deny-list is skipped when that
// var is unset (local-dev convenience). In CI (GitHub Actions) it FAILS LOUD
// via t.Fatal ONLY in trusted contexts (push events / same-repo PRs, signalled
// by VH_CI_TRUSTED=true) — fork PRs skip, because GitHub intentionally
// withholds repository secrets from pull_request events originating from
// forks, and failing there would make every external fork PR permanently red
// regardless of secret creation. CI enforcement of the deny-list begins once
// the operator creates the VH_SKILL_BANNED_TOKENS repo secret (the secret VALUE
// is out-of-band, never committed); until then CI is red on trusted events,
// which is the intended forcing function, not a bug. Net: the scanner is
// machine-enforced by default; the customer-token deny-list is
// operator/CI-enforced once the secret exists (trusted CI contexts only).
//
// Coverage of the env-predicate branches: the decision logic is proved for all
// four branches by TestDecideGateAction (in-process table over every input
// combo, including the trusted-Fatal branch that is unreachable in a local
// run). The trusted-Fatal t.Fatal and the deny-list-hit t.Fatalf are then
// exercised END-TO-END (non-zero exit + expected message) by the
// TestGenerateHasNoBannedTokensTrustedCIFatal and
// TestGenerateHasNoBannedTokensDenyListHit subprocess reentry tests, since
// their env combos never exist under a plain `go test`.
func TestGenerateHasNoBannedTokens(t *testing.T) {
	out := Generate("v-test")

	// scanBanned reports the first banned token (or variant) found in haystack.
	// Matching is case-insensitive and tries common variants of each entry — the
	// raw token, its fully-concatenated form (spaces/hyphens removed), and its
	// hyphenated form (spaces → hyphens) — so a token leaked in any of those
	// spellings is caught. It is the shared scanner used by both the env-driven
	// deny-list and the sentinel self-check.
	scanBanned := func(haystack string, banned []string) (string, bool) {
		hay := strings.ToLower(haystack)
		for _, raw := range banned {
			tok := strings.ToLower(strings.TrimSpace(raw))
			if tok == "" {
				continue
			}
			concat := strings.ReplaceAll(strings.ReplaceAll(tok, "-", ""), " ", "")
			hyphen := strings.ReplaceAll(tok, " ", "-")
			seen := map[string]bool{}
			for _, v := range []string{tok, concat, hyphen} {
				if v == "" || seen[v] {
					continue
				}
				seen[v] = true
				if strings.Contains(hay, v) {
					return v, true
				}
			}
		}
		return "", false
	}

	// Positive self-check: prove the scanner detects a leaked token by injecting
	// a known sentinel into a COPY of the output and scanning with a deny-list
	// containing just that sentinel. This holds the scanner honest whether or
	// not the env var is set; no real customer token is committed anywhere.
	const sentinel = "__banned_sentinel__"
	injected := out + "\n" + sentinel
	if hit, found := scanBanned(injected, []string{sentinel}); !found {
		t.Fatalf("scanner self-check failed: injected sentinel %q was not detected", sentinel)
	} else if hit != sentinel {
		t.Fatalf("scanner self-check detected wrong token: got %q want %q", hit, sentinel)
	}

	// Env-driven deny-list. Operators set VH_SKILL_BANNED_TOKENS (comma-separated)
	// locally / in CI to enforce the customer-token deny-list. The env-var NAME
	// carries no customer token; the VALUES are never committed in source.
	//
	// The skip/fatal/scan decision is routed through the pure decideGateAction so
	// TestDecideGateAction and the subprocess reentry tests exercise the same
	// logic — including the trusted-Fatal branch that is unreachable in a local
	// run (its GITHUB_ACTIONS=true + VH_CI_TRUSTED=true combo never exists here).
	banned := os.Getenv("VH_SKILL_BANNED_TOKENS")
	switch decideGateAction(
		os.Getenv("GITHUB_ACTIONS") == "true",
		os.Getenv("VH_CI_TRUSTED") == "true",
		banned != "",
	) {
	case gateFatal:
		t.Fatal("VH_SKILL_BANNED_TOKENS unset in a trusted CI context (push / same-repo PR) — create the repo secret so the customer-token deny-list runs on every build; no token is committed in source")
	case gateSkip:
		t.Skip("VH_SKILL_BANNED_TOKENS unset — set it locally to enforce the customer-token deny-list, or this is an untrusted/fork CI context where the secret is intentionally withheld (no token is committed in source)")
	case gateScan:
		if hit, found := scanBanned(out, strings.Split(banned, ",")); found {
			t.Fatalf("generated skill contains banned token %q — the doc must stay customer-agnostic", hit)
		}
	default:
		// Defensive: decideGateAction is exhaustive over the gateAction enum today,
		// but a future constant added without updating this switch would otherwise
		// silently fall through. Fail loud so the switch stays in sync with the enum.
		t.Fatalf("unexpected gateAction %d from decideGateAction (switch out of sync with gateAction enum)", decideGateAction(
			os.Getenv("GITHUB_ACTIONS") == "true",
			os.Getenv("VH_CI_TRUSTED") == "true",
			banned != "",
		))
	}
}

// TestDecideGateAction is the in-process, exhaustive decision-table proof
// (option a) for the deny-list gate predicate. It covers all 8 input
// combinations, including gateFatal (trusted-CI + unset deny-list) whose env
// combo never exists in a local `go test` — so without this table the fatal
// branch is only reachable via the subprocess reentry below. Catches
// regressions like fatal-on-fork-PR or skip-on-trusted-CI.
func TestDecideGateAction(t *testing.T) {
	tests := []struct {
		name          string
		githubActions bool
		vhCITrusted   bool
		denyListSet   bool
		want          gateAction
	}{
		{name: "local-skip", githubActions: false, vhCITrusted: false, denyListSet: false, want: gateSkip},
		{name: "fork-PR-skip", githubActions: true, vhCITrusted: false, denyListSet: false, want: gateSkip},
		{name: "trusted-only-skip", githubActions: false, vhCITrusted: true, denyListSet: false, want: gateSkip},
		{name: "trusted-CI-fatal", githubActions: true, vhCITrusted: true, denyListSet: false, want: gateFatal},
		{name: "deny-set-local", githubActions: false, vhCITrusted: false, denyListSet: true, want: gateScan},
		{name: "deny-set-fork-PR", githubActions: true, vhCITrusted: false, denyListSet: true, want: gateScan},
		{name: "deny-set-trusted-only", githubActions: false, vhCITrusted: true, denyListSet: true, want: gateScan},
		{name: "deny-set-trusted-CI", githubActions: true, vhCITrusted: true, denyListSet: true, want: gateScan},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decideGateAction(tt.githubActions, tt.vhCITrusted, tt.denyListSet); got != tt.want {
				t.Fatalf("decideGateAction(githubActions=%v, vhCITrusted=%v, denyListSet=%v) = %v; want %v",
					tt.githubActions, tt.vhCITrusted, tt.denyListSet, got, tt.want)
			}
		})
	}
}

// TestGenerateHasNoBannedTokensTrustedCIFatal is the end-to-end subprocess proof
// (option b, the crux) that the trusted-CI t.Fatal branch of
// TestGenerateHasNoBannedTokens actually fires: non-zero exit + the expected
// message. It re-runs the test binary as a subprocess under the
// GITHUB_ACTIONS=true + VH_CI_TRUSTED=true combo with an UNSET deny-list — an
// env combo that never exists in a local `go test`, so without this reentry the
// Fatal branch is only "covered" by a real trusted-CI run going red. This is
// the test that satisfies the card's ready_criteria[3] (fatal path exercised
// end-to-end, not just manually).
func TestGenerateHasNoBannedTokensTrustedCIFatal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0],
		"-test.run=^TestGenerateHasNoBannedTokens$", "-test.v")
	// Controlled env: trusted-CI combo + deny-list UNSET. Inherit a clean
	// baseline (PATH/HOME/etc.) with the three gate-relevant vars stripped so the
	// parent's environment can never leak in (e.g. if run inside a real CI).
	cmd.Env = append(envWithout("VH_SKILL_BANNED_TOKENS", "GITHUB_ACTIONS", "VH_CI_TRUSTED"),
		"GITHUB_ACTIONS=true",
		"VH_CI_TRUSTED=true",
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("trusted-CI subprocess exited zero; want non-zero (the t.Fatal branch should have fired)\ncombined output:\n%s", out)
	}
	const wantMsg = "VH_SKILL_BANNED_TOKENS unset in a trusted CI context"
	if !bytes.Contains(out, []byte(wantMsg)) {
		t.Fatalf("trusted-CI subprocess output missing expected fatal message %q\ncombined output:\n%s", wantMsg, out)
	}
	// Guard against a regression where the branch accidentally skips instead of
	// fatals: a skip is exit-zero with a PASS banner for the matched test.
	if bytes.Contains(out, []byte("--- PASS: TestGenerateHasNoBannedTokens")) {
		t.Fatalf("trusted-CI subprocess PASSED the gate test; want FAIL (fatal)\ncombined output:\n%s", out)
	}
}

// TestGenerateHasNoBannedTokensDenyListHit is the end-to-end subprocess proof of
// the sad-path: when the deny-list is SET and a banned token is present in the
// generated skill, the t.Fatalf scan-hit branch fires (non-zero exit + expected
// message). It re-runs the test binary with VH_SKILL_BANNED_TOKENS set to a
// SYNTHETIC token that is verifiably present in Generate's output — honoring the
// anonymization constraint (never a real customer token). CI-trust flags are
// left unset so the gate routes to the scan branch purely via the deny-list.
func TestGenerateHasNoBannedTokensDenyListHit(t *testing.T) {
	// Synthetic stand-in for a real customer token. "vh-solara" is (a) obviously
	// not a real secret and (b) guaranteed present in Generate's output (the
	// product name is stamped throughout), so the scanner reliably catches it.
	// Verify presence up front so a future Generate change fails THIS test
	// clearly instead of the subprocess exiting zero silently.
	const syntheticBanned = "vh-solara"
	if !strings.Contains(strings.ToLower(Generate("v-test")), syntheticBanned) {
		t.Fatalf("synthetic stand-in token %q is no longer present in Generate output; pick another stable substring", syntheticBanned)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0],
		"-test.run=^TestGenerateHasNoBannedTokens$", "-test.v")
	cmd.Env = append(envWithout("VH_SKILL_BANNED_TOKENS", "GITHUB_ACTIONS", "VH_CI_TRUSTED"),
		"VH_SKILL_BANNED_TOKENS="+syntheticBanned,
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("deny-list sad-path subprocess exited zero; want non-zero (the scan-hit t.Fatalf should have fired)\ncombined output:\n%s", out)
	}
	const wantSub = "generated skill contains banned token"
	if !bytes.Contains(out, []byte(wantSub)) {
		t.Fatalf("deny-list sad-path subprocess output missing expected fatalf message %q\ncombined output:\n%s", wantSub, out)
	}
	if !bytes.Contains(out, []byte(syntheticBanned)) {
		t.Fatalf("deny-list sad-path subprocess output missing the matched token %q in the failure message\ncombined output:\n%s", syntheticBanned, out)
	}
}

// envWithout returns os.Environ() filtered to remove the named keys, so a
// subprocess reentry starts from a clean baseline for the gate-relevant env
// vars (no leakage of the parent's VH_SKILL_BANNED_TOKENS / CI-trust flags into
// the child). The child still inherits PATH/HOME/etc. needed to run.
func envWithout(names ...string) []string {
	drop := make(map[string]struct{}, len(names))
	for _, n := range names {
		drop[n] = struct{}{}
	}
	cleaned := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if _, ok := drop[key]; ok {
			continue
		}
		cleaned = append(cleaned, kv)
	}
	return cleaned
}
