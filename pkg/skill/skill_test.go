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

// TestGenerateHasNoBannedTokens guards the anonymization invariant: the
// generated skill doc must never reference any adopter/customer. The guard has
// two halves. (1) A sentinel self-check runs UNCONDITIONALLY — it injects a
// known sentinel into a copy of the output and verifies the scanner catches it,
// so the scanner logic itself is machine-enforced on every run (never vacuous).
// (2) The real customer-token deny-list is env/secret-sourced via
// VH_SKILL_BANNED_TOKENS (comma-separated) so that no real customer token is
// ever committed as a test fixture.
//
// POSTURE (B1, advisory/opt-in): the gate is opt-in. When
// VH_SKILL_BANNED_TOKENS is unset the test ALWAYS skips — regardless of CI
// context (it never fails loud). Operators set the var locally or in a
// release-prep run to enforce the customer-token deny-list scan. The repo is
// public and the secret is not wired in CI, so a fail-loud-in-trusted-CI branch
// was unreachable without committing a real customer token; B1 downgraded the
// gate to an opt-in regression net. The scanner is still machine-enforced by
// the unconditional sentinel self-check; the customer-token deny-list is
// operator-enforced on demand. TestGenerateHasNoBannedTokensDenyListHit proves
// end-to-end that a set deny-list catches a banned token — the one regression
// net that remains and IS the opt-in value.
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

	// Env-driven deny-list (opt-in/advisory). Operators set
	// VH_SKILL_BANNED_TOKENS (comma-separated) locally or in a release-prep run
	// to enforce the customer-token deny-list. The env-var NAME carries no
	// customer token; the VALUES are never committed in source. When unset the
	// test skips unconditionally — never fail-loud in CI (B1).
	banned := os.Getenv("VH_SKILL_BANNED_TOKENS")
	if banned == "" {
		t.Skip("VH_SKILL_BANNED_TOKENS unset — advisory opt-in: set it locally or in a release-prep run to enforce the customer-token deny-list (never fail-loud in CI)")
	}
	if hit, found := scanBanned(out, strings.Split(banned, ",")); found {
		t.Fatalf("generated skill contains banned token %q — the doc must stay customer-agnostic", hit)
	}
}

// TestGenerateHasNoBannedTokensDenyListHit is the end-to-end subprocess proof of
// the sad-path: when the deny-list is SET and a banned token is present in the
// generated skill, the t.Fatalf scan-hit branch fires (non-zero exit + expected
// message). It re-runs the test binary with VH_SKILL_BANNED_TOKENS set to a
// SYNTHETIC token that is verifiably present in Generate's output — honoring the
// anonymization constraint (never a real customer token). After B1 the gate is
// purely deny-list-set ? scan : skip, so the subprocess strips all three
// gate-relevant env vars (VH_SKILL_BANNED_TOKENS / GITHUB_ACTIONS /
// VH_CI_TRUSTED) and sets only the deny-list — CI-trust flags are no longer
// read by the gate but are still stripped for subprocess hygiene.
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
