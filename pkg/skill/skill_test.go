package skill

import (
	"os"
	"reflect"
	"strings"
	"testing"

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
// (2) The real customer-token deny-list is env-sourced via
// VH_SKILL_BANNED_TOKENS (comma-separated; set locally or in CI) so that no
// real customer token is ever committed as a test fixture; it runs ONLY when
// that env var is set and t.Skip's otherwise. Net: the scanner is
// machine-enforced by default; the actual customer-token deny-list is
// operator/CI-enforced (not default-CI-enforced).
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
	banned := os.Getenv("VH_SKILL_BANNED_TOKENS")
	if banned == "" {
		t.Skip("VH_SKILL_BANNED_TOKENS unset — operators set it locally / in CI to enforce the customer-token deny-list (no token is committed in source)")
	}
	if hit, found := scanBanned(out, strings.Split(banned, ",")); found {
		t.Fatalf("generated skill contains banned token %q — the doc must stay customer-agnostic", hit)
	}
}
