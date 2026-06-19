// Package skill generates the agent-facing "how to drive vh-solara" skill
// (SKILL.md) from the LIVE surface — the MCP tool definitions and the gate{}
// struct — so it is version-synced to the binary and can't drift from a
// hand-authored copy. vh-solara owns this surface doc; a consuming repo installs
// it (provisioned) rather than maintaining a copy.
package skill

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/mcp"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// DefaultInstallDir is the suggested location inside a consuming repo.
const DefaultInstallDir = ".opencode/skills/vh-solara"

// gateSemantics is the curated one-line meaning per gate{} field. Field NAMES are
// taken from the struct via reflection (so a new field can't silently go
// undocumented); this only supplies prose.
var gateSemantics = map[string]string{
	"activity":                 "idle | busy | retry | error.",
	"hydrated":                 "message state loaded (live or history). The message-derived fields below are authoritative only when true; on a cold/never-opened session after a restart they read \"not yet known\", NOT \"in-flight\".",
	"last_assistant_completed": "the latest assistant turn has time.completed.",
	"finish_reason":            "raw opencode `finish` (stop|length|tool-calls). The completion REASON, not a content signal — present on every completed turn, so it can't tell empty from non-empty content.",
	"last_assistant_empty":     "the latest assistant turn produced no text AND no tool/file content (envelope only, e.g. an empty stop). A tool-only turn is NON-empty (the agent is working).",
	"subtree_busy":             "any session in this subtree (incl. self) is busy/retry.",
	"pending_question":         "a question awaits a TYPED reply — a plain message will NOT satisfy it.",
	"pending_permission":       "a permission awaits a typed reply (once|always|reject).",
	"tokens":                   "raw token-usage object of the latest assistant turn.",
}

// Generate renders the full SKILL.md for the given binary version.
func Generate(version string) string {
	var b strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	p("---\n")
	p("name: vh-solara\n")
	p("description: Drive vh-solara — read session state via the gate{} facts and act via the typed verbs (send/spawn/abort/answer-question/reply-permission), locally or across machines. Generated for vh-solara %s.\n", version)
	p("---\n\n")

	p("# Driving vh-solara (coordination client) — %s\n\n", version)
	p("vh-solara surfaces raw opencode facts and read/write/subscribe verbs; it carries NO\n")
	p("coordination policy. This skill is GENERATED from the running binary's surface and\n")
	p("version-stamped, so it can't drift — re-provision (`vh-solara skill install`) on upgrade.\n\n")

	p("**Worker prerequisite:** the API lives on vh-solara's own web server, served only when a\n")
	p("worker runs `--web vh` (`local-server`, or `client-daemon --web vh`).\n\n")

	// --- gate{} facts (field names reflected from state.GateFacts) ---
	p("## gate{} — per-session facts (on every /vh/snapshot and the stream snapshot)\n\n")
	p("Keyed by sessionID. Compose the send/act gate from these — one snapshot, no N+1.\n\n")
	t := reflect.TypeOf(state.GateFacts{})
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		sem := gateSemantics[name]
		if sem == "" {
			sem = "(see vh-solara docs)"
		}
		p("- `%s` — %s\n", name, sem)
	}
	p("\nSendable gate: `activity == idle && !subtree_busy && last_assistant_completed && " +
		"!pending_question && !pending_permission`.\n\n")

	// --- verbs (generated from MCP tool defs) ---
	p("## Verbs (MCP tools — same shapes as the HTTP /vh/* and /api/workers/{id}/* surface)\n\n")
	for _, tool := range mcp.ToolDefs() {
		name, _ := tool["name"].(string)
		desc, _ := tool["description"].(string)
		p("### `%s`\n%s\n", name, desc)
		schema, _ := tool["inputSchema"].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		req := map[string]bool{}
		if rs, ok := schema["required"].([]string); ok {
			for _, r := range rs {
				req[r] = true
			}
		}
		names := make([]string, 0, len(props))
		for k := range props {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			pd, _ := props[k].(map[string]any)
			d, _ := pd["description"].(string)
			marker := ""
			if req[k] {
				marker = " (required)"
			}
			p("- `%s`%s — %s\n", k, marker, d)
		}
		p("\n")
	}

	// --- contract (curated, stable) ---
	p("## Acting safely (the contract)\n\n")
	p("- **Send only when sendable** (gate above). Optional `If-Idle-Seq: <snapshot seq>` header on\n")
	p("  send is a compare-and-swap: the send is accepted only if the session is still sendable and\n")
	p("  its activity hasn't changed since that seq, else `409`. Use it to avoid double-driving.\n")
	p("- **Questions/permissions are separate gates** — a plain message does NOT satisfy them; use\n")
	p("  answer_question / reply_permission.\n")
	p("- **Status buckets** (write verbs): `409`/`410` (and upstream `404`) = request already cleared,\n")
	p("  re-read gate; `400` = malformed call, fix it (don't loop); `5xx`/transport = route-around.\n")
	p("- **abort is async** — the resulting idle arrives on the stream later; don't send-after-abort\n")
	p("  synchronously (CAS or wait for the idle transition).\n")
	p("- **Idempotency**: pass `idempotency_key` on writes so a retry can't double-execute (10-min,\n")
	p("  per worker lifetime; resets on epoch change).\n\n")

	p("## Streaming & cursors\n\n")
	p("- `seq` is a single monotonic counter per worker store; cursor = `(worker, epoch, seq)`.\n")
	p("- A named `snapshot` SSE event is the baseline (first connect) OR the gap signal (ring\n")
	p("  overflow / invalid cursor) → reconcile from it, then resume.\n")
	p("- `epoch` (in the snapshot and the `X-VH-Epoch` header) identifies the store lifetime; seq\n")
	p("  resets on daemon restart — on epoch change, re-snapshot. Never compare seqs across epochs.\n\n")

	p("## Transport\n\n")
	p("- Local (agent on the worker machine): hit the worker's `/vh/*` directly, or run\n")
	p("  `vh-solara mcp --local`. Over a Unix socket (container / no host networking): start the\n")
	p("  worker with `--vh-sock /path/vh.sock` and reach it via `mcp --sock /path/vh.sock`, or any\n")
	p("  UDS HTTP client (e.g. httpx with a UDS transport). Set `X-VH-CSRF: 1` on writes.\n")
	p("- Cross-machine: the controller's `/api/workers/{id}/*` (bearer token), proxied to the\n")
	p("  worker — same verbs, path-addressed; responses carry `X-VH-Epoch`/`X-VH-Seq`.\n")

	return b.String()
}
