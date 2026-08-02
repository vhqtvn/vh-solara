package skill

import (
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
		"### Pins (pinned root-session order)",
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
		// Anonymization guard: the state-docs prose must stay customer-agnostic.
	} {
		if !strings.Contains(out, must) {
			t.Fatalf("generated skill missing server-managed-state anchor %q", must)
		}
	}
}
