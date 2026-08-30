// Package fixtures provides a production-shaped fake OpenCode server for the
// frontend harness: deterministic sessions/messages/diffs plus a /event stream
// that simulates a live streaming assistant response when a prompt is posted.
// It lets the real aggregator + web server + render pipeline run end-to-end
// without a real `opencode` binary (mirrors trueai-dev's gated fixture mode).
package fixtures

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// demoDir is the single consolidated project directory under which ALL real
// fixture sessions live. The e2e suite loads this dir explicitly (via ?dir=)
// so no test relies on the synthetic default-project/cwd path. The /session
// handler returns the full real session set for this dir; any other non-empty
// dir still gets the synthetic per-directory placeholder so the project
// switcher remains demoable for dirs with no real sessions.
//
// It is a VAR (not const) so the fixtureserver can repoint it to a real
// writable on-disk directory (SetDemoDir) — required by tests that write into
// the project tree (e.g. attachment upload, which creates
// <demoDir>/.vh-solara/sessions/<sid>/attachments). The default "/work/demo"
// stays for Go unit tests that never touch the filesystem.
var demoDir = "/work/demo"

// SetDemoDir repoints the consolidated demo project directory (and the
// directory all seeded sessions report). Must be called before New(). Used by
// the fixtureserver to point demoDir at a real writable path it created on
// disk; Go unit tests leave the default (no FS writes needed).
func SetDemoDir(d string) {
	if d != "" {
		demoDir = d
	}
}

// DemoDir returns the current consolidated demo directory (the fixtureserver
// exposes it to e2e via env so the TS test harness and the Go fixture agree).
func DemoDir() string {
	return demoDir
}

// FakeOpenCode implements the subset of OpenCode's HTTP API the daemon uses.
type FakeOpenCode struct {
	mu          sync.Mutex
	sessions    []map[string]any
	messages    map[string][]messageWithParts // sessionID -> ordered messages
	subs        map[int]chan string
	nextSub     int
	counter     int
	pendingQ    map[string]string             // questionID -> sessionID
	pendingQReq map[string]map[string]any     // questionID -> full question request
	pendingP    map[string]map[string]any     // permissionID -> full permission request
	archived    map[string]bool               // sessionID -> archived (native time.archived)
	busy        map[string]string             // sessionID -> status type (busy/retry); mirrors /session/status
	baseline    map[string][]messageWithParts // sessionID -> seeded message list snapshot for /fixture/reset
	// resetGen is a per-session generation counter bumped by handleFixtureReset.
	// simulatePrompt captures the generation active at turn-start and gates its
	// DEFERRED session.idle emit on it being unchanged. A [[stall]] goroutine
	// leaked across serial e2e tests (tests 4/9 sleep 5s server-side and do not
	// wait) would otherwise emit a stale session.idle AFTER a later test's
	// beforeEach reset + that test's own send — racing the new turn's
	// session.status busy and clearing working() mid-turn (the :693 flake:
	// .working-text never appears because the leaked idle cancels the busy).
	// Bumping the generation on reset makes the leaked defer a no-op; the reset
	// emits its own session.idle, so no event is lost. Sibling of the 2f6e697
	// message-accumulation fix — same "aggregator-store-clear must reach the
	// event feed" rationale, on the busy/idle axis instead of the message axis.
	resetGen        map[string]uint64 // sessionID -> generation, bumped on /fixture/reset
	promptAsyncMode PromptAsyncMode   // test-only; default PromptAsyncNormal (see PromptAsyncMode doc)

	// --- test-only exact-GET seam for the reconcile in-flight-guard e2e test ---
	//
	// Off by default: reconcileGetBlock == nil means the exact message-GET
	// (GET /session/:sid/message/:mid) behaves exactly as before. ArmReconcileGetBlock
	// installs a sentinel channel; while armed, every exact message-GET BLOCKS on
	// <-reconcileGetBlock until ReleaseReconcileGetBlock closes it — letting a test
	// hold a reconcile pass's lookup mid-flight so concurrent passes can be shown to
	// be single-flighted by the Server's queueReconcileInFlight guard. The GET blocks
	// OUTSIDE reconcileGetHookMu so the fake never deadlocks (Arm/Release only ever
	// read/swap the channel ref under the lock).
	//
	// reconcileGetCount is an always-on atomic counter of exact message-GETs. It is
	// harmless to existing fixtures/tests (none read it) and gives the in-flight-guard
	// test a race-free observable for "how many reconcile passes reached the lookup".
	reconcileGetHookMu sync.Mutex
	reconcileGetBlock  chan struct{}
	reconcileGetCount  int64 // atomic; counts every exact message-GET

	// promptArrivals counts POST /session/:id/prompt_async arrivals — the route
	// /vh/send forwards through agg.Client().Prompt (pkg/opencode/client.go).
	// TEST-ONLY observability for the P7 Slice 3 e2e (tests/e2e): a CAS-bearing
	// /vh/send that is AWAITING the abort-settle gate has NOT yet reached
	// prompt_async (it is blocked in Store.WaitAbortSettling before calling
	// Prompt), so its arrival stays uncounted until the gate opens and the fresh
	// CAS forwards — giving the test a race-free "zero prompts during the await,
	// exactly one on release" observable. Guarded by f.mu; never read by the
	// shipped binary or by existing fixtures/tests.
	promptArrivals map[string]int

	// messagesBeforeCount is an always-on atomic counter of backward-cursor
	// message-list GETs (GET /session/:sid/message?before=...). Harmless to
	// existing fixtures/tests (none read it); gives the OF1 oversized-floor
	// boundary-demand e2e a race-free observable for "did the D-trigger's
	// EnsureOlderMessages actually reach opencode" and for the anti-misfire
	// assert (zero backward fetches before the walk reaches the resident
	// floor).
	messagesBeforeCount int64 // atomic

	// --- test-only agent-evidence hold latch (composer-hydration e2e) ---
	//
	// The agenthold session's message-LIST GET (GET /session/agenthold/message)
	// blocks on <-agentHoldBlock while armed. See handleFixtureAgentHoldArm —
	// the /fixture/agent-hold/{arm,release,reset} control surface. The GET
	// blocks OUTSIDE f.mu (same discipline as the slow-sleep and the
	// reconcileGetBlock seam above) so the held fetch can never stall the
	// /session list, the SSE emit fan-out, or sibling sessions' cold-seed.
	agentHoldMu    sync.Mutex
	agentHoldBlock chan struct{}
}

// agentHoldSessionID is the dedicated agent-evidence-hold session (lane-6
// composer-hydration e2e). It is NOT seeded by New(): it exists only between
// a /fixture/agent-hold/arm and the matching /fixture/agent-hold/reset, so
// sibling specs in the serial suite never observe it.
const agentHoldSessionID = "agenthold"

type messageWithParts struct {
	Info  map[string]any   `json:"info"`
	Parts []map[string]any `json:"parts"`
}

// PromptAsyncMode selects how the fake's /session/{id}/prompt_async handler
// responds. It models the ambiguous-receipt window the queue recovery contract
// (FIX-QUEUE-STUCK-1) targets: production prompt_async persists the user message
// BEFORE returning 204, so a response loss leaves the queue item stuck in
// `dispatching` with no way to resolve. Test-only: production never switches
// mode (the default PromptAsyncNormal is the faithful path).
type PromptAsyncMode int

const (
	// PromptAsyncNormal is the faithful path: fork the turn, persist the user
	// message via simulatePrompt, and return 204 immediately. The assistant
	// reply arrives over the event stream.
	PromptAsyncNormal PromptAsyncMode = iota
	// PromptAsyncCommitThenDropResponse persists the user message, then DROPS the
	// HTTP response (hijacks + closes the connection without writing a 204). The
	// worker's reverse proxy sees a backend error (not 204), so the browser/queue
	// can never resolve the item. Used by the in-process e2e queue-recovery test
	// (tests/e2e) to prove FIX-QUEUE-STUCK-1's recovery contract end-to-end:
	// after the stale threshold the queue item recovers to terminal `unknown` on
	// the next List(), with NO redispatch (exactly one committed user message).
	PromptAsyncCommitThenDropResponse
	// PromptAsyncRejectBeforeCommit returns an error WITHOUT persisting the user
	// message — the clean-rejection path (OpenCode never received the prompt).
	// Defined for completeness/future tests; not exercised by the recovery slice.
	PromptAsyncRejectBeforeCommit
)

// New returns a FakeOpenCode seeded with a small, deterministic dataset: two
// root sessions, one subsession, and a session with a rendered-markdown text
// part plus a completed tool part.
func New() *FakeOpenCode {
	f := &FakeOpenCode{
		messages:       map[string][]messageWithParts{},
		subs:           map[int]chan string{},
		pendingQ:       map[string]string{},
		pendingQReq:    map[string]map[string]any{},
		pendingP:       map[string]map[string]any{},
		archived:       map[string]bool{},
		busy:           map[string]string{},
		resetGen:       map[string]uint64{},
		promptArrivals: map[string]int{},
	}
	now := float64(time.Now().UnixMilli())
	f.sessions = []map[string]any{
		{"id": "demo", "projectID": "proj", "title": "Demo session", "directory": demoDir,
			// Real OpenCode names the session model `id` (not `modelID`).
			"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
			"time":  map[string]any{"created": now - 5000, "updated": now}},
		{"id": "sub", "projectID": "proj", "parentID": "demo", "title": "Subagent: search", "directory": demoDir, "time": map[string]any{"created": now - 3000, "updated": now - 2000}},
		{"id": "other", "projectID": "proj", "title": "Another root", "directory": demoDir, "time": map[string]any{"created": now - 9000, "updated": now - 9000}},
		// Slow-hydration session: a normal root session whose full-message GET is
		// held for a bounded window (see handleSession) so the .chat-content reveal
		// gate's opacity:0 → opacity:1 transition is observable end-to-end by
		// Playwright (web/tests/e2e/reveal-gate.spec.ts). A root (no parentID) so it
		// doesn't perturb demo's hidden-idle-children footer count (smoke.spec.ts).
		{"id": "slow", "projectID": "proj", "title": "Slow hydration", "directory": demoDir,
			"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
			"time":  map[string]any{"created": now - 4000, "updated": now - 4000}},
	}
	f.messages["demo"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "m1", "sessionID": "demo", "role": "user", "time": map[string]any{"created": now - 4800, "completed": now - 4800}},
			Parts: []map[string]any{textPart("m1", "demo", "p1", "Refactor the parser and explain the change.", now-4800)},
		},
		{
			Info: map[string]any{"id": "m2", "sessionID": "demo", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 4600, "completed": now - 4000},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think", "variant": "high"}},
			Parts: []map[string]any{
				textPart("m2", "demo", "p2", "Here's the plan:\n\n1. Extract the tokenizer\n2. Add tests\n\n```go\nfunc Parse(s string) (*AST, error) {\n\treturn parse(s)\n}\n```\n\nComplexity is $O(n \\log n)$; over the input:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\nEdited src/parser.go:2 accordingly.", now-4600),
				// Reasoning + a few tools so the Activity timeline (grouping, the
				// Thinking row, and the "+N more" collapse) is exercisable.
				{"id": "p2r", "sessionID": "demo", "messageID": "m2", "type": "reasoning",
					"text": "Let me read the tokenizer and the parser entrypoint before editing, then run the existing tests.",
					"time": map[string]any{"start": now - 4580, "end": now - 4560}},
				{"id": "p2a", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0a", "tool": "grep",
					"state": map[string]any{"status": "completed", "title": "search the codebase",
						"input": map[string]any{"pattern": "func parse"}, "output": "src/parser.go:2\nsrc/tokenizer.go:14",
						"time": map[string]any{"start": now - 4555, "end": now - 4540}}},
				{"id": "p2b", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0b", "tool": "read",
					"state": map[string]any{"status": "completed", "title": "read parser.go",
						"input": map[string]any{"filePath": "src/parser.go"}, "output": "package main\n\nfunc parse(s string) {}",
						"time": map[string]any{"start": now - 4535, "end": now - 4520}}},
				{"id": "p2c", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0c", "tool": "read",
					"state": map[string]any{"status": "completed", "title": "read tokenizer.go",
						"input": map[string]any{"filePath": "src/tokenizer.go"}, "output": "package main\n// tokenizer",
						"time": map[string]any{"start": now - 4515, "end": now - 4505}}},
				{
					"id": "p3", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c1", "tool": "edit",
					"state": map[string]any{"status": "completed", "title": "edit parser.go",
						// oldString/newString make ToolPart's edit-contents preview
						// (editDiffLines) render for the e2e lane — web/tests/e2e/
						// tooledit-preview.spec.ts expands this NON-tail row. The new
						// string matches what the earlier p2b read shows for the file.
						"input":  map[string]any{"filePath": "parser.go", "oldString": "func parse() {}", "newString": "func parse(s string) {}"},
						"output": "Applied 1 edit to parser.go",
						// LSP diagnostics OpenCode attaches after an edit (keyed by file).
						"metadata": map[string]any{"diagnostics": map[string]any{
							"parser.go": []map[string]any{
								{"severity": 1, "message": "undefined: parse", "range": map[string]any{"start": map[string]any{"line": 1, "character": 8}}},
							},
						}},
						"time": map[string]any{"start": now - 4500, "end": now - 4400}},
				},
				{
					"id": "p4", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c2", "tool": "task",
					"state": map[string]any{"status": "completed", "title": "search the codebase",
						"metadata": map[string]any{"sessionId": "sub", "parentSessionId": "demo"},
						"input":    map[string]any{"description": "search the codebase", "subagent_type": "general"},
						"output":   "found 3 matches", "time": map[string]any{"start": now - 4300, "end": now - 2100}},
				},
			},
		},
		// A second turn so there are TWO activity groups — the earlier one renders
		// collapsed, only this (last) one expanded by default.
		{
			Info:  map[string]any{"id": "m3", "sessionID": "demo", "role": "user", "time": map[string]any{"created": now - 1800, "completed": now - 1800}},
			Parts: []map[string]any{textPart("m3", "demo", "p5", "Now run the tests.", now-1800)},
		},
		{
			Info: map[string]any{"id": "m4", "sessionID": "demo", "role": "assistant", "agent": "plan", "time": map[string]any{"created": now - 1700, "completed": now - 1200},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think", "variant": "high"}},
			Parts: []map[string]any{
				{"id": "p6", "sessionID": "demo", "messageID": "m4", "type": "tool", "callID": "c3", "tool": "bash",
					"state": map[string]any{"status": "completed", "title": "go test ./...",
						"input": map[string]any{"command": "go test ./..."}, "output": "ok parser 0.2s; ok tokenizer 0.1s",
						"time": map[string]any{"start": now - 1690, "end": now - 1250}}},
				{"id": "p7", "sessionID": "demo", "messageID": "m4", "type": "tool", "callID": "c4", "tool": "read",
					"state": map[string]any{"status": "completed", "title": "read go.mod",
						"input": map[string]any{"filePath": "go.mod"}, "output": "module demo",
						"time": map[string]any{"start": now - 1245, "end": now - 1240}}},
				textPart("m4", "demo", "p8", "Tests pass.", now-1230),
			},
		},
		// An in-flight turn (no time.completed): a completed reasoning then a
		// RUNNING bash — exercises the running-tool shimmer, the tail item opening
		// by default, and the live streaming caret.
		{
			Info:  map[string]any{"id": "m5", "sessionID": "demo", "role": "user", "time": map[string]any{"created": now - 200, "completed": now - 200}},
			Parts: []map[string]any{textPart("m5", "demo", "p9", "Add a benchmark and run it.", now-200)},
		},
		{
			Info: map[string]any{"id": "m6", "sessionID": "demo", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 180},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think", "variant": "high"}},
			Parts: []map[string]any{
				{"id": "p10", "sessionID": "demo", "messageID": "m6", "type": "reasoning",
					"text": strings.Repeat("I'll add a table-driven benchmark next to the parser tests, then run it. "+
						"First I need to check the existing harness, the input fixtures, and the timer setup so the "+
						"numbers are comparable across runs. ", 14),
					"time": map[string]any{"start": now - 175, "end": now - 150}},
				{"id": "p11", "sessionID": "demo", "messageID": "m6", "type": "tool", "callID": "c5", "tool": "bash",
					"state": map[string]any{"status": "running", "title": "go test -bench .",
						"input":  map[string]any{"command": "go test -bench=. -run=^$ ./..."},
						"output": "goos: linux\ngoarch: amd64\nBenchmarkParse-8 \t  ", "time": map[string]any{"start": now - 140}}},
			},
		},
	}
	f.messages["sub"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "sm1", "sessionID": "sub", "role": "assistant", "agent": "general", "time": map[string]any{"created": now - 2900, "completed": now - 2100}},
			Parts: []map[string]any{textPart("sm1", "sub", "sp1", "Searched 12 files, found 3 matches.", now-2900)},
		},
	}
	// Slow-hydration session messages: a few turns so the partial→loaded window is
	// meaningful (the aggregator streams a partial snapshot then fills via deltas).
	// Otherwise a normal transcript — see handleSession for the bounded GET delay.
	f.messages["slow"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "sl1", "sessionID": "slow", "role": "user", "time": map[string]any{"created": now - 3900, "completed": now - 3900}},
			Parts: []map[string]any{textPart("sl1", "slow", "slp1", "Summarize the rollout plan.", now-3900)},
		},
		{
			Info:  map[string]any{"id": "sl2", "sessionID": "slow", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 3850, "completed": now - 3700}},
			Parts: []map[string]any{textPart("sl2", "slow", "slp2", "Here's the rollout plan in three phases: canary, ramp, full. Each gates on the error budget.", now-3850)},
		},
		{
			Info:  map[string]any{"id": "sl3", "sessionID": "slow", "role": "user", "time": map[string]any{"created": now - 3600, "completed": now - 3600}},
			Parts: []map[string]any{textPart("sl3", "slow", "slp3", "What's the rollback path?", now-3600)},
		},
		{
			Info:  map[string]any{"id": "sl4", "sessionID": "slow", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 3550, "completed": now - 3400}},
			Parts: []map[string]any{textPart("sl4", "slow", "slp4", "Rollback is automatic: the canary watches the SLO and reverts to the previous image within 60s.", now-3550)},
		},
	}
	// Markdown-hardening session: a self-contained transcript exercising the
	// HTML-escape-as-text policy (feature 2) and the image-proxy rewrite
	// (feature 1). Loaded ONLY by web/tests/e2e/markdown-harden.spec.ts; it is a
	// separate root session so it does not perturb the demo session tree shape
	// other specs assert against.
	f.sessions = append(f.sessions, map[string]any{
		"id": "mdhard", "projectID": "proj", "title": "Markdown hardening", "directory": demoDir,
		"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
		"time":  map[string]any{"created": now - 6000, "updated": now - 6000},
	})
	f.messages["mdhard"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "mh1", "sessionID": "mdhard", "role": "user", "time": map[string]any{"created": now - 6000, "completed": now - 6000}},
			Parts: []map[string]any{textPart("mh1", "mdhard", "mhp1", "Show me the report tags and an external image.", now-6000)},
		},
		{
			Info: map[string]any{"id": "mh2", "sessionID": "mdhard", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 5900, "completed": now - 5800},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy", "variant": "default"}},
			Parts: []map[string]any{
				textPart("mh2", "mdhard", "mhp2",
					"Here is a custom report block and an external diagram:\n\n"+
						"<report>\nstatus: ok\n</report>\n\n"+
						"The tag <vh-solara> is also unsupported HTML.\n\n"+
						"![architecture diagram](https://example.com/diagram.png)\n\n"+
						"And some normal **bold** text with `inline code`.",
					now-5900),
			},
		},
	}
	// Mermaid session: a self-contained transcript exercising the inline diagram
	// + full-viewport overlay (MermaidViewer). Loaded ONLY by
	// web/tests/e2e/mermaid.spec.ts; separate root session so it does not perturb
	// the demo session tree shape other specs assert against.
	f.sessions = append(f.sessions, map[string]any{
		"id": "mermaid", "projectID": "proj", "title": "Mermaid diagrams", "directory": demoDir,
		"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
		"time":  map[string]any{"created": now - 6100, "updated": now - 6100},
	})
	f.messages["mermaid"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "mm1", "sessionID": "mermaid", "role": "user", "time": map[string]any{"created": now - 6100, "completed": now - 6100}},
			Parts: []map[string]any{textPart("mm1", "mermaid", "mmp1", "Show me the deploy flow as a diagram.", now-6100)},
		},
		{
			Info: map[string]any{"id": "mm2", "sessionID": "mermaid", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 6000, "completed": now - 5900},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy", "variant": "default"}},
			Parts: []map[string]any{
				textPart("mm2", "mermaid", "mmp2",
					"Here is the deploy flow:\n\n"+
						"```mermaid\ngraph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Run]\n    B -->|No| D[Skip]\n    C --> E[End]\n    D --> E\n```\n\n"+
						"That is the deploy flow.",
					now-6000),
			},
		},
	}
	// Edit-preview session: a self-contained transcript exercising the edit
	// contents preview's replaceAll meta header (ToolPart editDiffLines).
	// Loaded ONLY by web/tests/e2e/tooledit-preview.spec.ts; separate root
	// session so it does not perturb the demo session tree shape other specs
	// assert against (same isolation pattern as mdhard/mermaid above).
	f.sessions = append(f.sessions, map[string]any{
		"id": "editpvw", "projectID": "proj", "title": "Edit previews", "directory": demoDir,
		"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
		"time":  map[string]any{"created": now - 6200, "updated": now - 6200},
	})
	f.messages["editpvw"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "ep1", "sessionID": "editpvw", "role": "user", "time": map[string]any{"created": now - 6200, "completed": now - 6200}},
			Parts: []map[string]any{textPart("ep1", "editpvw", "epp1", "Rename the pool helper everywhere.", now-6200)},
		},
		{
			Info: map[string]any{"id": "ep2", "sessionID": "editpvw", "role": "assistant", "agent": "build", "time": map[string]any{"created": now - 6150, "completed": now - 6100},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy", "variant": "default"}},
			Parts: []map[string]any{
				// A many-match replace: replaceAll drives the "replaces every
				// match" meta line, and multi-line old/new exercise the per-line
				// class mapping (4 del + 4 add rows).
				{
					"id": "epp2", "sessionID": "editpvw", "messageID": "ep2", "type": "tool", "callID": "ec1", "tool": "edit",
					"state": map[string]any{"status": "completed", "title": "edit pool.go",
						"input": map[string]any{"filePath": "src/db/pool.go", "replaceAll": true,
							"oldString": "c, err := acquire()\nif err != nil {\n\treturn err\n}",
							"newString": "c, err := get()\nif err != nil {\n\treturn err\n}"},
						"output": "Replaced 4 matches in src/db/pool.go",
						"time":   map[string]any{"start": now - 6140, "end": now - 6110}},
				},
			},
		},
	}
	// Opt-in heavy session for benchmarking: VH_BENCH_MESSAGES=N seeds a "bench"
	// session with N complex messages (markdown + code + tool calls + diffs).
	if n, _ := strconv.Atoi(os.Getenv("VH_BENCH_MESSAGES")); n > 0 {
		f.sessions = append(f.sessions, map[string]any{
			"id": "bench", "title": "Benchmark (" + strconv.Itoa(n) + " msgs)",
			"directory": demoDir, "time": map[string]any{"created": now - 8000, "updated": now},
		})
		f.messages["bench"] = buildBenchMessages(n, now)
	}
	// Snapshot the seeded messages so /fixture/reset can restore the baseline
	// transcript between serial e2e tests (stall/prompt turns otherwise accumulate
	// across iterations and skew the follow-to-tail geometry the suite asserts).
	f.baseline = map[string][]messageWithParts{}
	for sid, msgs := range f.messages {
		f.baseline[sid] = append([]messageWithParts(nil), msgs...)
	}
	return f
}

// buildBenchMessages creates n alternating user/assistant messages; assistants
// carry markdown + a fenced code block, a completed tool call, and a unified
// diff — the realistic mix that stresses server-render + the message list.
func buildBenchMessages(n int, now float64) []messageWithParts {
	out := make([]messageWithParts, 0, n)
	for i := 0; i < n; i++ {
		t := now - float64((n-i)*1000)
		if i%2 == 0 {
			id := fmt.Sprintf("bu%d", i)
			out = append(out, messageWithParts{
				Info:  map[string]any{"id": id, "sessionID": "bench", "role": "user", "time": map[string]any{"created": t, "completed": t}},
				Parts: []map[string]any{textPart(id, "bench", "bup"+strconv.Itoa(i), fmt.Sprintf("Message %d: optimize the tokenizer and add a test for `Parse`.", i), t)},
			})
			continue
		}
		id := fmt.Sprintf("ba%d", i)
		agent := "build"
		if i%6 == 1 {
			agent = "plan"
		} else if i%6 == 3 {
			agent = "general"
		}
		code := fmt.Sprintf("```go\nfunc tokenize%d(s string) []Token {\n\tvar out []Token\n\tfor _, r := range s {\n\t\tout = append(out, Token{R: r})\n\t}\n\treturn out // pass %d\n}\n```", i, i)
		out = append(out, messageWithParts{
			Info: map[string]any{"id": id, "sessionID": "bench", "role": "assistant", "agent": agent,
				"time": map[string]any{"created": t, "completed": t + 400}, "cost": 0.0021,
				"tokens": map[string]any{"input": 1800 + i, "output": 240, "cache": map[string]any{"read": 900, "write": 0}}},
			Parts: []map[string]any{
				textPart(id, "bench", "bap"+strconv.Itoa(i), fmt.Sprintf("Step %d — here's the change:\n\n- extract `tokenize`\n- cover edge cases\n\n%s\n\nEdited src/parser.go:%d accordingly.", i, code, i), t),
				{
					"id": "bt" + strconv.Itoa(i), "sessionID": "bench", "messageID": id, "type": "tool", "callID": "bc" + strconv.Itoa(i), "tool": "edit",
					"state": map[string]any{"status": "completed", "title": fmt.Sprintf("edit parser.go (#%d)", i),
						"input":  map[string]any{"file": "parser.go"},
						"output": fmt.Sprintf("@@ -%d,3 +%d,4 @@\n func Parse(s string) (*AST, error) {\n-\treturn parse(s)\n+\ttok := tokenize%d(s)\n+\treturn parse(tok)\n }", i, i, i),
						"time":   map[string]any{"start": t + 100, "end": t + 200}},
				},
				{
					"id": "bsh" + strconv.Itoa(i), "sessionID": "bench", "messageID": id, "type": "tool", "callID": "bsc" + strconv.Itoa(i), "tool": "bash",
					"state": map[string]any{"status": "completed", "title": "go test ./...",
						"input":  map[string]any{"command": "go test ./..."},
						"output": "ok  \tparser\t0.01" + strconv.Itoa(i%9) + "s", "time": map[string]any{"start": t + 250, "end": t + 350}},
				},
			},
		})
	}
	return out
}

func textPart(msgID, sessionID, partID, text string, t float64) map[string]any {
	return map[string]any{
		"id": partID, "sessionID": sessionID, "messageID": msgID, "type": "text",
		"text": text, "time": map[string]any{"start": t, "end": t},
	}
}

// SeedFlatSessions is a MEASUREMENT-ONLY helper (used by tests/e2e tunnel-gate
// probe) that appends n flat root sessions under demoDir so the daemon's cold
// detail snapshot scales with session count — reproducing the large-dir payload
// shape (N session rows + N computed gate entries, 0 messages) without a real
// opencode DB. Each row carries the fields a real session row serializes
// (id/projectID/title/directory/model/time) so the per-row byte cost is
// realistic. It does NOT seed messages (the detail snapshot bottleneck is the
// session+gate volume, not message parts — see tmp/agent-runs/delivery-proof/
// subtree-open-hang.md). New sessions are picked up by the aggregator's
// tree-reconcile poll and/or the live /event session.created fan-out below.
func (f *FakeOpenCode) SeedFlatSessions(n int) {
	if n <= 0 {
		return
	}
	f.mu.Lock()
	now := float64(time.Now().UnixMilli())
	for i := 0; i < n; i++ {
		f.counter++
		s := map[string]any{
			"id": fmt.Sprintf("ses_scale_%d", f.counter), "projectID": "proj",
			"title":     "Scale session " + fmt.Sprintf("%d", f.counter),
			"directory": demoDir,
			"model":     map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
			"time":      map[string]any{"created": now - float64(f.counter), "updated": now},
		}
		f.sessions = append(f.sessions, s)
	}
	f.mu.Unlock()
	// No live emit: the per-dir aggregator hydrates from GET /session at creation,
	// which returns f.sessions authoritatively. Bulk emits would overflow the
	// default aggregator's buffered /event subscriber channel (close-on-full) and
	// are unnecessary for the measurement shape (sessions + computed gate).
}

// SeedDeepTreeSessions appends a DEEP session tree (1 root + nChildren direct
// children + nGrandchildren buried under the first child) under demoDir. Unlike
// SeedFlatSessions (all roots → frontier == full dir), a deep tree has a STRICT
// frontier subset: with no session loaded, the frontier = roots = {root} only;
// the direct children and grandchildren are buried (collapsed) and omitted from
// the partial detail frame. This lets the through-tunnel partial-frame test
// demonstrate the frontier reduction engaging end-to-end (scope_len << full-dir,
// frame ≤300 KB), which the flat all-roots fixture cannot. Measurement helper
// only: append, no live emit (same close-on-full rationale as SeedFlatSessions).
func (f *FakeOpenCode) SeedDeepTreeSessions(nChildren, nGrandchildren int) {
	if nChildren <= 0 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := float64(time.Now().UnixMilli())
	mk := func(parent, title string) map[string]any {
		f.counter++
		s := map[string]any{
			"id": fmt.Sprintf("ses_deep_%d", f.counter), "projectID": "proj",
			"title": title, "directory": demoDir,
			"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
			"time":  map[string]any{"created": now - float64(f.counter), "updated": now},
		}
		if parent != "" {
			s["parentID"] = parent
		}
		return s
	}
	root := mk("", "Deep root")
	f.sessions = append(f.sessions, root)
	rootID := root["id"].(string)
	var firstChildID string
	for i := 0; i < nChildren; i++ {
		c := mk(rootID, "Deep child "+fmt.Sprintf("%d", i))
		f.sessions = append(f.sessions, c)
		if i == 0 {
			firstChildID = c["id"].(string)
		}
	}
	for i := 0; i < nGrandchildren; i++ {
		f.sessions = append(f.sessions, mk(firstChildID, "Deep grandchild "+fmt.Sprintf("%d", i)))
	}
}

// SetPromptAsyncMode overrides the prompt_async response mode. TEST-ONLY: the
// shared fixture defaults to PromptAsyncNormal (the faithful path). The e2e
// queue-recovery test (tests/e2e) switches to CommitThenDropResponse to model
// the ambiguous-receipt window. The fixture is concurrent, so the mode is
// mutex-guarded.
func (f *FakeOpenCode) SetPromptAsyncMode(mode PromptAsyncMode) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.promptAsyncMode = mode
}

// PromptAsyncMode returns the current prompt_async response mode.
func (f *FakeOpenCode) PromptAsyncModeNow() PromptAsyncMode {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.promptAsyncMode
}

// ArmReconcileGetBlock arms the test-only exact-GET blocker: while armed, every
// GET /session/:sid/message/:mid blocks until ReleaseReconcileGetBlock is called.
// TEST-ONLY and OFF BY DEFAULT — existing fixtures/tests never arm it, so their
// behavior is unchanged. Idempotent: arming when already armed is a no-op (the
// existing sentinel stays). Used by the e2e reconcile in-flight-guard test to
// hold the first reconcile pass's GET mid-flight so concurrent passes can be
// shown to be single-flighted by the Server's queueReconcileInFlight guard.
func (f *FakeOpenCode) ArmReconcileGetBlock() {
	f.reconcileGetHookMu.Lock()
	defer f.reconcileGetHookMu.Unlock()
	if f.reconcileGetBlock == nil {
		f.reconcileGetBlock = make(chan struct{})
	}
}

// ReleaseReconcileGetBlock unblocks every exact-GET held by a prior
// ArmReconcileGetBlock and disarms the blocker (subsequent GETs do not block
// until Arm is called again). Idempotent (no-op when not armed). Closing (not
// nil-then-race) is what unblocks all receivers at once.
func (f *FakeOpenCode) ReleaseReconcileGetBlock() {
	f.reconcileGetHookMu.Lock()
	ch := f.reconcileGetBlock
	f.reconcileGetBlock = nil
	f.reconcileGetHookMu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// ReconcileGetCount returns the number of exact message-GETs
// (GET /session/:sid/message/:mid) observed since the fake was created.
// Race-free (atomic). Used by the e2e in-flight-guard test (delta-based, since
// the shared cluster fake accumulates GETs across the package) to assert exactly
// one GET occurred under concurrent reconcile passes.
func (f *FakeOpenCode) ReconcileGetCount() int64 {
	return atomic.LoadInt64(&f.reconcileGetCount)
}

// MessagesBeforeCount returns the number of backward-cursor message-list GETs
// (GET /session/:sid/message?before=...) observed since the fake was created.
// Race-free (atomic). Used by the OF1 oversized-floor boundary-demand e2e to
// assert the D-trigger's remote fetch actually fired (count advanced by
// exactly one) and the anti-misfire invariant (count frozen while the walk
// still has resident-local older messages). Delta-based: the shared cluster
// fake accumulates GETs across the serial package.
func (f *FakeOpenCode) MessagesBeforeCount() int64 {
	return atomic.LoadInt64(&f.messagesBeforeCount)
}

// UserMessageCount returns the number of committed user messages for a session.
// It reads the fake's in-memory message store (the same store simulatePrompt
// and commitUserMessage append to), so it reflects what OpenCode has durably
// recorded regardless of whether any HTTP response reached the caller. Used by
// the e2e queue-recovery test to prove NO redispatch occurred (recovery must
// never re-issue the prompt, so exactly one user message is committed).
func (f *FakeOpenCode) UserMessageCount(sessionID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.messages[sessionID] {
		if role, _ := m.Info["role"].(string); role == "user" {
			n++
		}
	}
	return n
}

// ActiveEventSubs returns the number of currently-active /event SSE subscribers
// (one per aggregator that has opened its always-on event tail to this fake).
// It is a read-only test-only observability seam: f.subs is managed solely by
// handleEvent's subscribe/unsub, so this reads existing state with NO behavior
// change — it lets a regression test deterministically confirm a per-directory
// aggregator's /event connection was accepted by the fake (the exact antecedent
// for the teardown-SSE-hang bound, pkg/web/server.go aggFor→RunManaged). Mirrors
// the f.mu-guarded read pattern of UserMessageCount above.
func (f *FakeOpenCode) ActiveEventSubs() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

// PromptArrivals returns the number of POST /session/:id/prompt_async calls
// observed for sessionID (the route /vh/send forwards through
// agg.Client().Prompt). TEST-ONLY observability for the P7 Slice 3 e2e: a
// CAS-bearing /vh/send blocked in Store.WaitAbortSettling has not reached
// prompt_async, so this stays at its pre-await value until the gate opens and
// the fresh CAS forwards — the race-free "zero during the await, exactly one on
// release" signal. Reads existing state under f.mu; no behavior change. Mirrors
// the UserMessageCount read pattern.
func (f *FakeOpenCode) PromptArrivals(sessionID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.promptArrivals[sessionID]
}

// EmitSessionBusy emits a LIVE session.status busy for sessionID through the
// fake's real /event stream (the authoritative new-turn path the reducer's
// NormSessionStatus arm consumes → markTurnRunningLocked → TurnRunning).
// TEST-ONLY deterministic control seam for the P7 Slice 3 e2e: unlike [[stall]]
// (which sleeps 5s then auto-idles via the deferred session.idle) or
// [[perm]]/[[ask]] (which arm a pending question/permission blocker that
// independently makes the session non-sendable), this produces a STABLE busy
// window with no competing terminal and no side effects — so the abort-settle
// gate stays closed until EmitSessionTerminal releases it, with no race against
// a 5s stall timer or a pending-blocker CAS failure. It is test-infra only: it
// calls the existing unexported emit (no change to emit itself) and is never
// reached by the shipped binary.
func (f *FakeOpenCode) EmitSessionBusy(sessionID string) {
	f.emit("session.status", map[string]any{
		"sessionID": sessionID, "status": map[string]any{"type": "busy"},
	})
}

// EmitSessionTerminal emits a turn-TERMINAL event (session.idle or
// session.error) for sessionID through the fake's real /event stream. It is the
// deterministic P7 Slice 3 release seam: the event propagates fixture /event →
// worker aggregator → Store.Apply, where session.idle / session.error route to
// settleTerminalLocked (open the fail-closed abort gate + wake any /vh/send
// consumer awaiting it). session.idle also clears activity to idle (the fresh
// CAS passes → forward); session.error clears activity to error (the fresh CAS
// fails → 409). Using this instead of sleeping for the ~5s settle timer keeps
// the e2e deterministic and the consumer's event-driven WaitAbortSettling the
// proof. eventName MUST be "session.idle" or "session.error". TEST-ONLY: calls
// the existing unexported emit; no behavior change; never reached by the binary.
func (f *FakeOpenCode) EmitSessionTerminal(sessionID, eventName string) {
	f.emit(eventName, map[string]any{"sessionID": sessionID})
}

// commitUserMessage persists a single user message for a session and returns
// the allocated counter. It is the "commit" half of the
// CommitThenDropResponse mode: the user turn is durably recorded (exactly what
// real OpenCode does before returning 204), but the caller never sees a
// response. Single lock acquisition makes the commit atomic with the counter
// allocation. Does NOT emit events or start an assistant turn — the dispatch is
// considered lost, so no assistant reply streams.
//
// messageID mirrors real OpenCode's caller-id-wins prompt_async contract
// (input.messageID ?? MessageID.ascending()): when the caller supplies a
// non-empty, msg_-prefixed id (vh-solara's queue correlation id, Slice 5), the
// user message is persisted with that EXACT id so a later
// GET /session/:sid/message/:mid finds it. Empty → the fake mints its own u%n
// (the pre-Slice-5 path).
func (f *FakeOpenCode) commitUserMessage(sessionID, text, messageID string) int {
	now := float64(time.Now().UnixMilli())
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counter++
	n := f.counter
	userID := messageID
	if userID == "" {
		userID = fmt.Sprintf("u%d", n)
	}
	upID := fmt.Sprintf("up%d", n)
	userInfo := map[string]any{"id": userID, "sessionID": sessionID, "role": "user",
		"time": map[string]any{"created": now, "completed": now}}
	userPart := textPart(userID, sessionID, upID, text, now)
	f.messages[sessionID] = append(f.messages[sessionID],
		messageWithParts{Info: userInfo, Parts: []map[string]any{userPart}})
	return n
}

// dropResponse simulates a lost HTTP response by hijacking and immediately
// closing the underlying connection WITHOUT writing a valid status line. The
// worker's reverse proxy then observes a backend error (not 204), modeling the
// network-drop / browser-crash / timeout scenario the queue recovery contract
// targets. If the response writer is not hijackable, it falls back to a 502 so
// the caller still observes an error outcome (never 204).
func (f *FakeOpenCode) dropResponse(w http.ResponseWriter) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "fixture: response dropped (no hijack)", http.StatusBadGateway)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		http.Error(w, "fixture: hijack failed", http.StatusInternalServerError)
		return
	}
	// Closing without writing a status line forces the proxy's read to error.
	_ = conn.Close()
}

// Handler returns the HTTP handler for the fake OpenCode API.
func (f *FakeOpenCode) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", f.handleSessionRoot)
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		out := map[string]any{}
		for sid, t := range f.busy {
			out[sid] = map[string]any{"type": t}
		}
		f.mu.Unlock()
		writeJSON(w, out)
	})
	mux.HandleFunc("/session/", f.handleSession)
	mux.HandleFunc("/event", f.handleEvent)
	mux.HandleFunc("/provider", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"all": []map[string]any{{
				"id": "fake", "name": "Fake LLM", "source": "config", "env": []string{}, "options": map[string]any{},
				"models": map[string]any{
					"dummy": map[string]any{"id": "dummy", "name": "Dummy Model", "status": "active",
						"capabilities": map[string]any{"reasoning": false, "attachment": false},
						"cost":         map[string]any{"input": 0, "output": 0},
						"limit":        map[string]any{"context": 128000}},
					"dummy-think": map[string]any{"id": "dummy-think", "name": "Dummy Thinking", "status": "beta",
						"capabilities": map[string]any{"reasoning": true, "attachment": true},
						"cost":         map[string]any{"input": 3, "output": 15},
						"limit":        map[string]any{"context": 200000},
						"variants":     map[string]any{"low": map[string]any{}, "high": map[string]any{}}},
				},
			}},
			"default":   map[string]any{"fake": "dummy"},
			"connected": []string{"fake"},
		})
	})
	mux.HandleFunc("/agent", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"name": "build", "mode": "primary", "description": "Default coding agent"},
			// `plan` carries a configured model+variant: selecting it should switch
			// the composer's model to match.
			{"name": "plan", "mode": "primary", "description": "Read-only planning agent",
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think"}, "variant": "high"},
			{"name": "general", "mode": "subagent", "description": "General subagent"},
			// hidden + subagent must never reach the composer picker.
			{"name": "summarize", "mode": "primary", "hidden": true, "description": "Internal"},
		})
	})
	// Slash-command catalog (composer autocomplete).
	mux.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"name": "init", "description": "guided AGENTS.md setup", "source": "command"},
			{"name": "compact", "description": "summarize the conversation", "source": "command"},
		})
	})
	// File finder (composer @file autocomplete) — fuzzy path match.
	mux.HandleFunc("/find/file", func(w http.ResponseWriter, r *http.Request) {
		q := strings.ToLower(r.URL.Query().Get("query"))
		all := []string{"src/parser.go", "src/parser_test.go", "README.md", "cmd/main.go"}
		out := []string{}
		for _, p := range all {
			if q == "" || strings.Contains(strings.ToLower(p), q) {
				out = append(out, p)
			}
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("/project", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"id": "p1", "worktree": "/work/alpha", "name": "alpha", "time": map[string]any{"created": 1, "updated": 200}},
			{"id": "p2", "worktree": "/work/beta", "name": "beta", "time": map[string]any{"created": 1, "updated": 100}},
			// Same worktree as p1 under a different id (OpenCode does this on re-init);
			// the recents list must dedupe by directory so alpha shows once.
			{"id": "p1b", "worktree": "/work/alpha", "name": "alpha", "time": map[string]any{"created": 1, "updated": 50}},
		})
	})
	// On-demand session-name generation (the "Regenerate name" action). Mirrors
	// OpenCode's POST /experimental/project/:projectID/copy/generate-name, which
	// runs the small model and returns a short slug from the supplied context.
	mux.HandleFunc("/experimental/project/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/copy/generate-name") {
			body := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			writeJSON(w, map[string]any{"name": "fixture-generated-name"})
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/lsp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{{"id": "gopls", "state": "running", "extensions": []string{".go"}}})
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"context7": map[string]any{"status": "connected", "type": "remote"},
			"local-fs": map[string]any{"status": "connected", "type": "local"},
		})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"plugin":        []string{"opencode-notify", "github:acme/opencode-plugin-very-long-name@v1.2.3"},
			"mcp":           map[string]any{"context7": map[string]any{"type": "remote"}},
			"lsp":           map[string]any{"go": map[string]any{"command": []string{"gopls"}}},
			"default_agent": "plan",
		})
	})
	mux.HandleFunc("/file/content", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		writeJSON(w, map[string]any{
			"type":    "text",
			"content": "// " + p + " (fixture)\npackage demo\n\nfunc Parse(s string) (*AST, error) {\n\treturn parse(s)\n}\n",
		})
	})
	mux.HandleFunc("/vcs", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"branch": "main", "default_branch": "main"})
	})
	mux.HandleFunc("/vcs/diff", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"file": "parser.go", "status": "modified", "additions": 2, "deletions": 1,
				"patch": "@@ -1,3 +1,4 @@\n func Parse(s string) (*AST, error) {\n-\treturn parse(s)\n+\ttok := tokenize(s)\n+\treturn parse(tok)\n }"},
		})
	})
	mux.HandleFunc("/fixture/reset", f.handleFixtureReset)
	mux.HandleFunc("/fixture/busy", f.handleFixtureBusy)
	mux.HandleFunc("/fixture/compaction-burst", f.handleFixtureCompactionBurst)
	mux.HandleFunc("/fixture/orphan", f.handleFixtureOrphan)
	mux.HandleFunc("/fixture/delete", f.handleFixtureDelete)
	mux.HandleFunc("/fixture/agent-hold/arm", f.handleFixtureAgentHoldArm)
	mux.HandleFunc("/fixture/agent-hold/release", f.handleFixtureAgentHoldRelease)
	mux.HandleFunc("/fixture/agent-hold/reset", f.handleFixtureAgentHoldReset)
	mux.HandleFunc("/question/", f.handleQuestion)
	mux.HandleFunc("/question", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		out := make([]map[string]any, 0, len(f.pendingQReq))
		for _, req := range f.pendingQReq {
			out = append(out, req)
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("/permission", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		out := make([]map[string]any, 0, len(f.pendingP))
		for _, req := range f.pendingP {
			out = append(out, req)
		}
		writeJSON(w, out)
	})
	// Canonical reply route: POST /permission/:requestID/reply {reply}.
	mux.HandleFunc("/permission/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["permission", id, "reply"]
		if len(parts) < 3 || parts[2] != "reply" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		id := parts[1]
		f.mu.Lock()
		req := f.pendingP[id]
		delete(f.pendingP, id)
		f.mu.Unlock()
		sid := ""
		if req != nil {
			sid, _ = req["sessionID"].(string)
		}
		f.emit("permission.replied", map[string]any{"sessionID": sid, "requestID": id})
		writeJSON(w, true)
	})
	return mux
}

// handleQuestion answers a pending question: POST /question/:id/reply.
func (f *FakeOpenCode) handleQuestion(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["question", id, "reply"]
	if len(parts) < 3 || parts[2] != "reply" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	var body struct {
		Answers [][]string `json:"answers"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	sid := f.pendingQ[id]
	delete(f.pendingQ, id)
	delete(f.pendingQReq, id)
	f.mu.Unlock()
	if sid != "" {
		f.emit("question.replied", map[string]any{
			"sessionID": sid, "requestID": id, "answers": body.Answers,
		})
		// Continue the turn: the assistant acts on the answer and streams a reply,
		// so the user sees a visible result after replying.
		chosen := "your choice"
		if len(body.Answers) > 0 && len(body.Answers[0]) > 0 {
			chosen = body.Answers[0][0]
		}
		f.mu.Lock()
		f.counter++
		n := f.counter
		f.mu.Unlock()
		go f.streamAssistant(sid, fmt.Sprintf("aq%d", n), fmt.Sprintf("apq%d", n),
			[]string{"Got it — going with **" + chosen + "**.", "\n\nProceeding now."})
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (f *FakeOpenCode) handleSessionRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		// Create a new session (powers the sidebar "New session" button).
		f.mu.Lock()
		f.counter++
		now := float64(time.Now().UnixMilli())
		s := map[string]any{
			"id": fmt.Sprintf("ses_new%d", f.counter), "projectID": "proj", "title": "New session",
			"directory": demoDir, "time": map[string]any{"created": now, "updated": now},
		}
		f.sessions = append(f.sessions, s)
		f.mu.Unlock()
		f.emit("session.created", map[string]any{"info": s})
		writeJSON(w, s)
		return
	}
	// Multi-project: scope by the x-opencode-directory header. All real fixture
	// sessions live under the consolidated demoDir, so a request for that dir
	// falls through to the full real set below (reproducing the everything-visible
	// behavior the e2e suite relies on, now via an explicit project dir instead
	// of the synthetic default-project/cwd). Any OTHER non-empty directory returns
	// a synthetic per-directory session so the project switcher remains
	// demoable/testable for dirs with no real sessions (e.g. /work/alpha).
	if dir := r.Header.Get("x-opencode-directory"); dir != "" && dir != demoDir {
		base := dir
		if i := strings.LastIndex(strings.TrimRight(dir, "/"), "/"); i >= 0 {
			base = strings.TrimRight(dir, "/")[i+1:]
		}
		now := float64(time.Now().UnixMilli())
		writeJSON(w, []map[string]any{
			{"id": "proj_" + base, "title": "Project: " + base, "directory": dir,
				"time": map[string]any{"created": now - 1000, "updated": now}},
		})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	wantArchived := r.URL.Query().Get("archived") == "true"
	out := make([]map[string]any, 0, len(f.sessions))
	for _, s := range f.sessions {
		id, _ := s["id"].(string)
		if f.archived[id] == wantArchived {
			out = append(out, f.withArchivedTime(s))
		}
	}
	writeJSON(w, out)
}

// withArchivedTime returns a copy of the session with time.archived set when the
// session is archived (mirrors OpenCode's native archive field).
func (f *FakeOpenCode) withArchivedTime(s map[string]any) map[string]any {
	id, _ := s["id"].(string)
	if !f.archived[id] {
		return s
	}
	cp := map[string]any{}
	for k, v := range s {
		cp[k] = v
	}
	t := map[string]any{}
	if orig, ok := s["time"].(map[string]any); ok {
		for k, v := range orig {
			t[k] = v
		}
	}
	t["archived"] = float64(time.Now().UnixMilli())
	cp["time"] = t
	return cp
}

func (f *FakeOpenCode) handleSession(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["session", id, action?, ...]
	id := ""
	action := ""
	if len(parts) >= 2 {
		id = parts[1]
	}
	if len(parts) >= 3 {
		action = parts[2]
	}

	switch {
	case action == "" && r.Method == http.MethodPatch:
		// Update a session: archive (time.archived) and/or title.
		//
		// FAITHFUL to OpenCode 1.17.x UpdatePayload
		// (Schema.optional(Schema.Finite)): a PRESENT JSON null for
		// time.archived is REJECTED with 400 — the schema does not accept
		// null. Only a finite number value is accepted, and it always SETS
		// archived (PATCH can never CLEAR it). This is exactly why vh-solara
		// unarchives via a direct SQLite write instead of PATCH; see
		// docs/architecture/opencode-sqlite-unarchive.md. The previous fixture
		// modeled null-as-clear, which hid the real 400 for months.
		//
		// `archived` is decoded as json.RawMessage so a present null can be
		// told apart from an absent key (both would otherwise be a nil
		// *float64).
		var body struct {
			Title *string `json:"title"`
			Time  *struct {
				Archived json.RawMessage `json:"archived"`
			} `json:"time"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Time != nil && len(body.Time.Archived) > 0 {
			// time.archived key is PRESENT.
			if strings.TrimSpace(string(body.Time.Archived)) == "null" {
				http.Error(w, "time.archived must be a finite timestamp; null is not accepted (OpenCode 1.17.x rejects clearing via PATCH)", http.StatusBadRequest)
				return
			}
			var ts float64
			if err := json.Unmarshal(body.Time.Archived, &ts); err != nil {
				http.Error(w, "time.archived must be a number", http.StatusBadRequest)
				return
			}
			f.mu.Lock()
			f.archived[id] = true // a finite value always SETS archived; PATCH never clears.
			f.mu.Unlock()
		}
		var updated map[string]any
		if body.Title != nil {
			f.mu.Lock()
			for _, s := range f.sessions {
				if s["id"] == id {
					s["title"] = *body.Title
					updated = s
					break
				}
			}
			f.mu.Unlock()
		}
		if updated != nil {
			f.emit("session.updated", map[string]any{"info": updated})
		}
		writeJSON(w, map[string]any{"id": id})
		return
	case action == "permissions" && r.Method == http.MethodPost:
		permID := parts[len(parts)-1]
		f.mu.Lock()
		delete(f.pendingP, permID)
		f.mu.Unlock()
		f.emit("permission.replied", map[string]any{"sessionID": id, "requestID": permID})
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "shell" && r.Method == http.MethodPost:
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cmd, _ := body["command"].(string)
		go f.simulateShell(id, cmd)
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "fork" && r.Method == http.MethodPost:
		f.mu.Lock()
		f.counter++
		now := float64(time.Now().UnixMilli())
		s := map[string]any{"id": fmt.Sprintf("ses_fork%d", f.counter), "parentID": id,
			"title": "Fork", "directory": demoDir, "time": map[string]any{"created": now, "updated": now}}
		f.sessions = append(f.sessions, s)
		f.mu.Unlock()
		f.emit("session.created", map[string]any{"info": s})
		writeJSON(w, s)
		return
	case (action == "revert" || action == "unrevert") && r.Method == http.MethodPost:
		writeJSON(w, map[string]any{"ok": true}) // fixture: acknowledge
		return
	case action == "abort" && r.Method == http.MethodPost:
		// Like real OpenCode, abort does NOT emit an idle event — the client must
		// clear its own working state optimistically.
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "message" && r.Method == http.MethodGet && len(parts) >= 4:
		// Exact-GET: GET /session/:sid/message/:mid — the authoritative
		// single-message lookup the queue reconciler (Slice 6) uses to decide
		// whether a dispatched item became a real persisted user message under
		// the queue's minted correlation id. Mirrors real OpenCode:
		//   - non-msg_-prefixed id → 400 (caller bug; same as real server)
		//   - composite (sid, mid) matches a persisted USER message → 200
		//     {"info":{...},"parts":[...]}
		//   - no match (wrong session / wrong id / assistant message) → 404
		// The composite key is enforced by f.messages being keyed by sessionID
		// (a mid is unique within its session; a foreign session's store is a
		// different slice), so session isolation is structural. The reconciler
		// additionally requires info.role==="user" && info.id===minted, so an
		// assistant message with a colliding id (never happens — ids are
		// globally unique) still fails the caller's exact-match check.
		//
		// Test-only exact-GET seam (off by default): count every lookup, then —
		// only when ArmReconcileGetBlock has installed a sentinel — block until
		// ReleaseReconcileGetBlock closes it. Used by the reconcile in-flight-guard
		// e2e test (tests/e2e) to hold the first reconcile pass's GET mid-flight.
		atomic.AddInt64(&f.reconcileGetCount, 1)
		f.reconcileGetHookMu.Lock()
		block := f.reconcileGetBlock
		f.reconcileGetHookMu.Unlock()
		if block != nil {
			<-block
		}
		mid := parts[3]
		if !strings.HasPrefix(mid, "msg_") {
			http.Error(w, "fixture: message id must be msg_-prefixed", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		var found *messageWithParts
		for i := range f.messages[id] {
			m := &f.messages[id][i]
			if role, _ := m.Info["role"].(string); role == "user" {
				if mid2, _ := m.Info["id"].(string); mid2 == mid {
					found = m
					break
				}
			}
		}
		f.mu.Unlock()
		if found == nil {
			http.Error(w, "fixture: message not found", http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{"info": found.Info, "parts": found.Parts})
		return
	case action == "message" && r.Method == http.MethodPost:
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		go f.simulatePrompt(id, promptText(body), promptMessageID(body))
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "prompt_async" && r.Method == http.MethodPost:
		// Mirror real OpenCode: persist the user message and return 204
		// immediately; the reply arrives over the event stream. The response
		// MODE is test-controllable (SetPromptAsyncMode) so the e2e
		// queue-recovery test can model the ambiguous-receipt window
		// (commit-then-drop) that FIX-QUEUE-STUCK-1's recovery targets.
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		text := promptText(body)
		// messageID is vh-solara's queue correlation id (Slice 5), threaded in
		// by the dispatch path. Real OpenCode persists the user message with
		// this EXACT id (caller-id-wins); the fake honors it identically so a
		// later GET /session/:sid/message/:mid can reconcile the item.
		messageID := promptMessageID(body)
		f.mu.Lock()
		f.promptArrivals[id]++ // test-only observability (see promptArrivals doc)
		mode := f.promptAsyncMode
		f.mu.Unlock()
		switch mode {
		case PromptAsyncCommitThenDropResponse:
			// Commit the user message FIRST (real OpenCode persists before
			// responding), THEN drop the response. The queue item is now stuck
			// in `dispatching`: OpenCode recorded the turn but the caller never
			// got the 204, so it can never resolve to sent/failed. No assistant
			// turn is started — the dispatch is considered lost.
			f.commitUserMessage(id, text, messageID)
			f.dropResponse(w)
			return
		case PromptAsyncRejectBeforeCommit:
			// Clean rejection: NO user message persisted (OpenCode never
			// received the prompt). Not exercised by the recovery slice.
			http.Error(w, "fixture: rejected before commit", http.StatusBadGateway)
			return
		default:
			// PromptAsyncNormal: the faithful path.
			go f.simulatePrompt(id, text, messageID)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}

	// Slow-hydration fixture mode (e2e reveal-gate coverage): hold the "slow"
	// session's full-message GET for a bounded window so the Slice-C async-hydration
	// partial→loaded state is observable by Playwright. The production fixture
	// returns messages instantly, so without this the partial-hydration window —
	// and thus the .chat-content opacity:0 reveal gate (web/src/styles.css,
	// ChatView.tsx `revealed()`) — can't be exercised end-to-end. The aggregator
	// streams a partial snapshot (messagesLoaded=false) while this GET is in flight,
	// then message.* deltas + messages.loaded once it returns (see
	// pkg/web/integration_test.go::TestStreamAsyncHydration for the exact shape).
	//
	// Sleep OUTSIDE f.mu — mirrors pkg/web/integration_test.go's msgHold pattern —
	// so the held fetch can't block the /session list endpoint, the /event SSE
	// stream's emit(), or the cold-seed fan-out for other sessions during the
	// serial e2e suite. Bounded well under 1.5s so a hung/leaked run can't wedge
	// the serial suite while still reliably exposing both the hidden + revealed
	// states. (Cold-seed's MessagesTail GET also hits this and sleeps once in the
	// background; harmless — it only postpones slow's lastAgent chip, not session
	// availability, and does NOT mark MessagesLoaded so the client-open fetch
	// still fires and produces the partial window.)
	//
	// Keyed off the session ID (NOT prompt text like [[stall]]/[[perm]]/[[ask]] in
	// simulatePrompt) because the partial snapshot is produced by the aggregator
	// stream on session open, not by a prompt — there is no prompt text to match.
	if id == "slow" && r.Method == http.MethodGet {
		time.Sleep(900 * time.Millisecond)
	}

	// Agent-evidence hold (web/tests/e2e/agent-hydration-send.spec.ts): while
	// armed, the agenthold session's message-LIST GET is held INDEFINITELY
	// (until /fixture/agent-hold/release), not for a bounded sleep — the
	// composer's "Resolving agent…" pending window must be observable for as
	// long as the spec needs, with release as the ONLY clock (no timing-only
	// sleeps in the acceptance contract). Like the slow-sleep above, the block
	// happens OUTSIDE f.mu: a held GET holds no locks, so the /session list,
	// the SSE emit fan-out, and sibling cold-seed fetches keep flowing. Only
	// the message-LIST GET reaches here — the exact-GET (/message/:mid) and
	// every mutating action return inside the switch above, so the reconciler
	// and prompt flow are unaffected by the hold.
	if id == agentHoldSessionID && r.Method == http.MethodGet {
		f.agentHoldMu.Lock()
		ch := f.agentHoldBlock
		f.agentHoldMu.Unlock()
		if ch != nil {
			<-ch
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	// Honor the backward cursor API (sst/opencode MessageV2.page) like real
	// OpenCode: ?before=<cursor-token>&limit=N returns the N strictly-older
	// messages (chronological), with X-Next-Cursor set to the oldest of the slice
	// when more older history remains. Cursor token = base64url(JSON{id,time})
	// (matches pkg/opencode EncodeMessageCursor). ?limit=N alone = newest-N tail.
	msgs := f.messages[id]
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if before := r.URL.Query().Get("before"); before != "" {
		// OF1 e2e observable: count every backward-cursor list GET (the
		// D-trigger's EnsureOlderMessages is the only caller shaped like
		// this). The atomic ops keep the counter race-free; that this
		// critical section holds f.mu is incidental — readers observe the
		// count via atomic.LoadInt64, never via the mutex.
		atomic.AddInt64(&f.messagesBeforeCount, 1)
		cid, ctime, ok := decodeMessageCursor(before)
		if !ok {
			http.Error(w, "invalid before cursor", http.StatusBadRequest)
			return
		}
		// Strictly-older by (time_created, id) — chronological order preserved.
		var older []messageWithParts
		for _, m := range msgs {
			mt, _ := messageCreatedTime(m)
			mid, _ := m.Info["id"].(string)
			if mt < ctime || (mt == ctime && mid < cid) {
				older = append(older, m)
			}
		}
		if limit <= 0 {
			limit = len(older)
		}
		if len(older) > limit {
			// Newest `limit` of the strictly-older set; X-Next-Cursor = its oldest.
			older = older[len(older)-limit:]
			oldest := older[0]
			oid, _ := oldest.Info["id"].(string)
			otime, _ := messageCreatedTime(oldest)
			w.Header().Set("X-Next-Cursor", encodeMessageCursor(oid, otime))
		}
		writeJSON(w, older)
		return
	}
	// Tail (no cursor): newest N messages, chronological within the window.
	// Mirror real OpenCode's MessageV2.page (message-v2.ts:457-465 + the
	// httpapi handler session.ts:130-144, pinned by upstream
	// httpapi-session.test.ts:955-973): when more history remains beyond the
	// window (len(msgs) > limit), set X-Next-Cursor to the OLDEST tuple of the
	// returned slice; when the tail IS the whole transcript, emit NO header.
	// The aggregator's cold load reads this as the authoritative exhaustion
	// verdict (has-older truthfulness), so the fixture must be faithful here.
	if limit > 0 && len(msgs) > limit {
		msgs = msgs[len(msgs)-limit:]
		oldest := msgs[0]
		oid, _ := oldest.Info["id"].(string)
		otime, _ := messageCreatedTime(oldest)
		if oid != "" {
			w.Header().Set("X-Next-Cursor", encodeMessageCursor(oid, otime))
		}
	}
	writeJSON(w, msgs)
}

// encodeMessageCursor builds the ?before=<token> value: base64url(JSON{id,time})
// (unpadded; keys id then time). Mirrors pkg/opencode.EncodeMessageCursor.
func encodeMessageCursor(id string, timeMs float64) string {
	b, _ := json.Marshal(struct {
		ID   string  `json:"id"`
		Time float64 `json:"time"`
	}{id, timeMs})
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeMessageCursor parses a ?before token. Returns ok=false on malformed.
func decodeMessageCursor(token string) (id string, timeMs float64, ok bool) {
	b, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return "", 0, false
	}
	var c struct {
		ID   string  `json:"id"`
		Time float64 `json:"time"`
	}
	if json.Unmarshal(b, &c) != nil || c.ID == "" {
		return "", 0, false
	}
	return c.ID, c.Time, true
}

// messageCreatedTime extracts info.time.created (unix-ms) from a fixture message.
func messageCreatedTime(m messageWithParts) (float64, bool) {
	t, _ := m.Info["time"].(map[string]any)
	if t == nil {
		return 0, false
	}
	c, _ := t["created"].(float64)
	return c, c != 0
}

// SeedChronologicalMessages seeds <sid> with n COMPLETED assistant turns in
// chronological order (oldest-first), each with info.time.created set (ascending
// unix-ms) so the backward-cursor paging is exercisable. Measurement/test
// helper only: appends to f.messages; no live emit. Used by the Part-B
// boundary-demand e2e.
func (f *FakeOpenCode) SeedChronologicalMessages(sid string, n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	base := float64(time.Now().UnixMilli())
	out := make([]messageWithParts, 0, n)
	for i := 0; i < n; i++ {
		t := base - float64(n-i)*1000 // ascending: m1 oldest
		id := fmt.Sprintf("cm%d", i+1)
		out = append(out, messageWithParts{
			Info: map[string]any{
				"id": id, "sessionID": sid, "role": "assistant", "agent": "build",
				"time": map[string]any{"created": t, "completed": t + 500},
			},
			Parts: []map[string]any{
				{"id": "cp" + strconv.Itoa(i+1), "sessionID": sid, "messageID": id, "type": "text", "text": "older turn " + strconv.Itoa(i+1)},
			},
		})
	}
	f.messages[sid] = out
	// Register the session in the session list so the aggregator's hydrate
	// (GET /session) admits it into the project store. Without this the
	// project-isolation guard (pkg/web projectScopedFilter: HasSession) drops it
	// and EnsureMessages never runs, so the cold-load never populates resident.
	already := false
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id == sid {
			already = true
			break
		}
	}
	if !already {
		f.sessions = append(f.sessions, map[string]any{
			"id": sid, "title": "Chronological " + strconv.Itoa(n),
			"directory": demoDir,
			"time":      map[string]any{"created": base - float64(n)*1000, "updated": base},
		})
	}
}

// SeedOversizedFloorMessages seeds cm1..cmN chronological (same shape as
// SeedChronologicalMessages) EXCEPT the message at 1-based index oversizedIdx,
// which carries TWO ~600 KiB text parts (~1.2 MiB total — over the 1 MiB
// WindowMaxBytes byte budget, while each part stays under the 1 MiB per-PART
// capPartJSON cap so the cold-load ingest stores it verbatim). This is the OF1
// shape: cold tail = newest WindowMaxCount messages INCLUDING the oversized
// one at the tail's oldest edge (the resident-floor boundary) when
// oversizedIdx == n-WindowMaxCount+1; the WINDOW projection excludes it
// (bytesLimited) but the resident store keeps it, so the load-older walk meets
// an oversized anchor AT the resident floor with remote older history (cm1..)
// upstream. Measurement/test helper only: appends to f.messages; no live emit.
func (f *FakeOpenCode) SeedOversizedFloorMessages(sid string, n, oversizedIdx int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	base := float64(time.Now().UnixMilli())
	out := make([]messageWithParts, 0, n)
	for i := 0; i < n; i++ {
		t := base - float64(n-i)*1000 // ascending: cm1 oldest
		id := fmt.Sprintf("cm%d", i+1)
		parts := []map[string]any{
			{"id": "cp" + strconv.Itoa(i+1), "sessionID": sid, "messageID": id, "type": "text", "text": "older turn " + strconv.Itoa(i+1)},
		}
		if i+1 == oversizedIdx {
			// Two ~600 KiB parts: total ~1.2 MiB > 1 MiB WindowMaxBytes
			// (oversized), each part < 1 MiB (survives capPartJSON verbatim).
			big := strings.Repeat("x", 600_000)
			parts = []map[string]any{
				{"id": "cpA" + strconv.Itoa(i+1), "sessionID": sid, "messageID": id, "type": "text", "text": big},
				{"id": "cpB" + strconv.Itoa(i+1), "sessionID": sid, "messageID": id, "type": "text", "text": big},
			}
		}
		out = append(out, messageWithParts{
			Info: map[string]any{
				"id": id, "sessionID": sid, "role": "assistant", "agent": "build",
				"time": map[string]any{"created": t, "completed": t + 500},
			},
			Parts: parts,
		})
	}
	f.messages[sid] = out
	already := false
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id == sid {
			already = true
			break
		}
	}
	if !already {
		f.sessions = append(f.sessions, map[string]any{
			"id": sid, "title": "OversizedFloor " + strconv.Itoa(n),
			"directory": demoDir,
			"time":      map[string]any{"created": base - float64(n)*1000, "updated": base},
		})
	}
}

// simulateShell emits a user message containing the command and an assistant
// message with canned shell output.
func (f *FakeOpenCode) simulateShell(sessionID, command string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	f.mu.Lock()
	f.counter++
	n := f.counter
	f.mu.Unlock()
	uid := fmt.Sprintf("sh-u%d", n)
	aid := fmt.Sprintf("sh-a%d", n)
	f.emit("session.status", map[string]any{"sessionID": sessionID, "status": map[string]any{"type": "busy"}})
	userInfo := map[string]any{"id": uid, "sessionID": sessionID, "role": "user", "time": map[string]any{"created": now(), "completed": now()}}
	f.emit("message.updated", map[string]any{"info": userInfo})
	f.emit("message.part.updated", map[string]any{"part": textPart(uid, sessionID, "shp"+strconv.Itoa(n), "$ "+command, now())})
	asst := map[string]any{"id": aid, "sessionID": sessionID, "role": "assistant", "time": map[string]any{"created": now(), "completed": now()}}
	f.emit("message.updated", map[string]any{"info": asst})
	f.emit("message.part.updated", map[string]any{"part": map[string]any{
		"id": "shtool" + strconv.Itoa(n), "sessionID": sessionID, "messageID": aid, "type": "tool", "tool": "bash",
		"state": map[string]any{"status": "completed", "title": command, "output": "fixture shell output for: " + command,
			"input": map[string]any{"command": command},
			"time":  map[string]any{"start": now(), "end": now()}}}})
	f.emit("session.idle", map[string]any{"sessionID": sessionID})
}

func promptText(body map[string]any) string {
	parts, _ := body["parts"].([]any)
	for _, p := range parts {
		if m, ok := p.(map[string]any); ok {
			if t, _ := m["text"].(string); t != "" {
				return t
			}
		}
	}
	return "(empty prompt)"
}

// promptMessageID extracts the caller-supplied OpenCode message id
// (prompt_async's optional `messageID` body field) — vh-solara's queue
// correlation id (Slice 5). Empty when absent (the pre-Slice-5 path; the fake
// then mints its own u%n). Real OpenCode persists the user message with this
// EXACT id (caller-id-wins on v1.17.18); the fake honors it identically.
func promptMessageID(body map[string]any) string {
	mid, _ := body["messageID"].(string)
	return mid
}

// --- event stream + streaming simulation ---

func (f *FakeOpenCode) handleEvent(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flush", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	ch, unsub := f.subscribe()
	defer unsub()

	fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
	fl.Flush()

	// Seed an agent todo list (OpenCode TodoWrite) for the demo session so the
	// "Tasks N active · M left" indicator is exercisable in the fixture lane.
	fmt.Fprint(w, `data: {"type":"todo.updated","properties":{"sessionID":"demo","todos":[`+
		`{"id":"t1","content":"Extract the tokenizer","status":"completed"},`+
		`{"id":"t2","content":"Add parser tests","status":"in_progress"},`+
		`{"id":"t3","content":"Wire error recovery","status":"pending"},`+
		`{"id":"t4","content":"Update docs","status":"pending"}]}}`+"\n\n")
	fl.Flush()
	// Subagent todos too, so the parent's Tasks indicator rolls them up.
	fmt.Fprint(w, `data: {"type":"todo.updated","properties":{"sessionID":"sub","todos":[`+
		`{"id":"s1","content":"Grep the codebase for parse()","status":"completed"},`+
		`{"id":"s2","content":"Summarize the matches","status":"in_progress"}]}}`+"\n\n")
	fl.Flush()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case payload := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", payload)
			fl.Flush()
		case <-ticker.C:
			fmt.Fprint(w, "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n")
			fl.Flush()
		}
	}
}

func (f *FakeOpenCode) subscribe() (<-chan string, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.nextSub
	f.nextSub++
	ch := make(chan string, 64)
	f.subs[id] = ch
	return ch, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if c, ok := f.subs[id]; ok {
			close(c)
			delete(f.subs, id)
		}
	}
}

func (f *FakeOpenCode) emit(eventType string, props any) {
	payload, _ := json.Marshal(map[string]any{"type": eventType, "properties": props})
	f.mu.Lock()
	defer f.mu.Unlock()
	// Mirror live status into the busy map so GET /session/status is faithful
	// (a reconnect/reload re-reads it, like real OpenCode).
	if m, ok := props.(map[string]any); ok {
		sid, _ := m["sessionID"].(string)
		if sid != "" {
			switch eventType {
			case "session.status":
				t := ""
				if st, ok := m["status"].(map[string]any); ok {
					t, _ = st["type"].(string)
				}
				if t == "idle" || t == "" {
					delete(f.busy, sid)
				} else {
					f.busy[sid] = t
				}
			case "session.idle", "session.error":
				delete(f.busy, sid)
			}
		}
	}
	for id, ch := range f.subs {
		select {
		case ch <- string(payload):
		default:
			close(ch)
			delete(f.subs, id)
		}
	}
}

// simulatePrompt mimics a live turn: append the user message, then stream an
// assistant text part in chunks, then mark it complete. Also persists to the
// message store so a reload reflects the turn.
//
// messageID mirrors real OpenCode's caller-id-wins prompt_async contract: when
// non-empty, the user message is persisted with that EXACT id (vh-solara's
// queue correlation id, Slice 5) so a later GET /session/:sid/message/:mid
// finds it. Empty → the fake mints its own u%n.
func (f *FakeOpenCode) simulatePrompt(sessionID, text, messageID string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	f.mu.Lock()
	f.counter++
	n := f.counter
	// Capture the turn-start reset generation. The deferred session.idle below
	// is gated on this so a [[stall]] goroutine leaked past a /fixture/reset
	// cannot emit a stale idle that cancels a later test's busy turn (the :693
	// flake). See resetGen doc.
	gen := f.resetGen[sessionID]
	f.mu.Unlock()

	userID := messageID
	if userID == "" {
		userID = fmt.Sprintf("u%d", n)
	}
	asstID := fmt.Sprintf("a%d", n)
	upID := fmt.Sprintf("up%d", n)
	apID := fmt.Sprintf("ap%d", n)

	// Mark the session busy for the duration of the turn (drives the sidebar dot).
	f.emit("session.status", map[string]any{"sessionID": sessionID, "status": map[string]any{"type": "busy"}})
	// The trailing session.idle is gated on the turn-start reset generation. A
	// /fixture/reset between this busy emit and the defer bumps resetGen, which
	// suppresses this idle — the reset emits its own idle, and (critically) the
	// stale idle cannot land on a LATER turn's busy window and cancel it. Only
	// the deferred idle is gated; streamAssistant's own trailing idle (normal
	// ~720ms completion, never leaks across tests) is unaffected.
	defer func() {
		f.mu.Lock()
		cur := f.resetGen[sessionID]
		f.mu.Unlock()
		if cur != gen {
			return
		}
		f.emit("session.idle", map[string]any{"sessionID": sessionID})
	}()

	userInfo := map[string]any{"id": userID, "sessionID": sessionID, "role": "user", "time": map[string]any{"created": now(), "completed": now()}}
	userPart := textPart(userID, sessionID, upID, text, now())
	f.appendMessage(sessionID, messageWithParts{Info: userInfo, Parts: []map[string]any{userPart}})
	f.emit("message.updated", map[string]any{"info": userInfo})
	f.emit("message.part.updated", map[string]any{"part": userPart})

	// A prompt containing [[perm]] raises a permission request and pauses there,
	// so the UI's permission card can be exercised.
	if strings.Contains(text, "[[perm]]") {
		pid := fmt.Sprintf("perm%d", n)
		// Mirror real OpenCode's Request shape: a permission category + patterns +
		// metadata (NO type/title), so the card renders detail from these.
		req := map[string]any{
			"id": pid, "sessionID": sessionID,
			"permission": "bash",
			"patterns":   []any{"rm -rf /tmp/scratch"},
			"metadata":   map[string]any{"command": "rm -rf /tmp/scratch"},
			"time":       map[string]any{"created": now()},
		}
		f.mu.Lock()
		f.pendingP[pid] = req
		f.mu.Unlock()
		f.emit("permission.asked", req) // real OpenCode event name
		return
	}
	if strings.Contains(text, "[[ask]]") {
		qid := fmt.Sprintf("que%d", n)
		req := map[string]any{
			"id": qid, "sessionID": sessionID,
			"questions": []map[string]any{{
				// custom omitted on purpose: opencode defaults free-text to enabled
				// (shown unless custom:false), so the card must still offer it.
				"header": "Direction", "question": "Which approach should I take?",
				"multiple": false,
				"options": []map[string]any{
					{"label": "Refactor", "description": "Restructure the existing parser"},
					{"label": "Rewrite", "description": "Start the parser fresh"},
				},
			}},
		}
		f.mu.Lock()
		f.pendingQ[qid] = sessionID
		f.pendingQReq[qid] = req
		f.mu.Unlock()
		f.emit("question.asked", req)
		return
	}

	// A prompt containing [[stall]] stays busy (no assistant message) for a few
	// seconds, so the UI's Stop/abort can be exercised against a hung turn.
	if strings.Contains(text, "[[stall]]") {
		time.Sleep(5 * time.Second)
		return
	}

	f.streamAssistant(sessionID, asstID, apID,
		[]string{"Working on it…", "\n\nDone. Updated ", "`parser.go` ", "and added a test."})
}

// streamAssistant emits an assistant message that streams in chunks, persists
// the final message, then marks the session idle. Shared by a fresh prompt and
// the continuation that follows a question reply.
func (f *FakeOpenCode) streamAssistant(sessionID, asstID, apID string, chunks []string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	asstInfo := map[string]any{"id": asstID, "sessionID": sessionID, "role": "assistant", "time": map[string]any{"created": now()}}
	f.emit("message.updated", map[string]any{"info": asstInfo})

	// Create the (empty) text part, then stream tokens via message.part.delta —
	// matching real OpenCode (the full message.part.updated only bookends).
	f.emit("message.part.updated", map[string]any{"part": map[string]any{
		"id": apID, "sessionID": sessionID, "messageID": asstID, "type": "text", "text": "",
		"time": map[string]any{"start": now()}}})
	acc := ""
	for _, c := range chunks {
		time.Sleep(180 * time.Millisecond)
		acc += c
		f.emit("message.part.delta", map[string]any{
			"sessionID": sessionID, "messageID": asstID, "partID": apID, "field": "text", "delta": c,
		})
	}

	finalPart := map[string]any{"id": apID, "sessionID": sessionID, "messageID": asstID, "type": "text", "text": acc, "time": map[string]any{"start": now(), "end": now()}}
	asstInfo["time"] = map[string]any{"created": asstInfo["time"].(map[string]any)["created"], "completed": now()}
	// A representative token/cost footprint so the inspector + context meter have data.
	asstInfo["cost"] = 0.0123
	asstInfo["tokens"] = map[string]any{"input": 4200, "output": 380, "cache": map[string]any{"read": 1800, "write": 0}}
	f.appendMessage(sessionID, messageWithParts{Info: asstInfo, Parts: []map[string]any{finalPart}})
	f.emit("message.part.updated", map[string]any{"part": finalPart})
	f.emit("message.updated", map[string]any{"info": asstInfo})
	f.emit("session.idle", map[string]any{"sessionID": sessionID})
}

// handleFixtureReset restores a session's message list to its seeded baseline,
// clears any mirrored busy status, and emits session.idle. It lets a serial
// Playwright suite absorb leaked [[stall]] busy goroutines and transcript
// accumulation from prior tests so each iteration starts from a clean baseline.
// Test-only infrastructure — never exercised by the shipped binary.
func (f *FakeOpenCode) handleFixtureReset(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	if session == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	// Collect accumulated message IDs (present in the current transcript but
	// NOT in the seeded baseline) BEFORE the restore below overwrites
	// f.messages. These are messages prior tests appended via simulatePrompt
	// (user turns + streamed assistant replies from the prompt-sending tests)
	// that the fixture-side restore clears from f.messages but the AGGREGATOR
	// store (pkg/state — the SPA's snapshot source) still holds. The store's
	// reconcile is upsert-only ("absence never deletes", reconcileMessagesLocked
	// Option A) and EnsureMessages short-circuits on IsMessagesLoaded=true, so a
	// page.goto never re-fetches and the accumulated transcript persists across
	// serial --repeat-each iterations. Emitting message.removed for each (after
	// the unlock, below) is what clears the aggregator store — same
	// aggregator-store-clear rationale as the clearedQ/clearedP emits further
	// down for leaked blocker state.
	baseIDs := map[string]bool{}
	if base, ok := f.baseline[session]; ok {
		for _, m := range base {
			if id, _ := m.Info["id"].(string); id != "" {
				baseIDs[id] = true
			}
		}
	}
	var removedMsgs []string
	for _, m := range f.messages[session] {
		if id, _ := m.Info["id"].(string); id != "" && !baseIDs[id] {
			removedMsgs = append(removedMsgs, id)
		}
	}
	if base, ok := f.baseline[session]; ok {
		f.messages[session] = append([]messageWithParts(nil), base...)
	} else {
		delete(f.messages, session)
	}
	delete(f.busy, session)
	// Invalidate any in-flight [[stall]] turn's deferred session.idle. A leaked
	// stall goroutine (tests 4/9 sleep 5s and do not wait) would otherwise emit
	// a stale idle AFTER this reset — racing a later test's session.status busy
	// and clearing working() mid-turn (the :693 flake: .working-text never
	// appears). The bump makes the stall's defer a no-op; this reset emits its
	// own session.idle below, so no event is lost. (Sibling of the message-
	// accumulation emit above — same aggregator-store-clear rationale, busy
	// axis. resetGen doc in the struct.)
	f.resetGen[session]++
	// Also clear any leaked pending question/permission blocker state for this
	// session. A prior test may have armed an unanswered [[ask]]/[[perm]] that
	// would otherwise mount a PendingInput/permission pill on the next open,
	// polluting session-agnostic assertions (e.g. scroll-follow button.jump
	// counts). These maps are keyed by question/permission ID with sessionID
	// inside the value, so clearing by session requires a value scan. Collect the
	// cleared IDs here (emit cannot run under f.mu — it takes the lock itself).
	var clearedQ, clearedP []string
	for qid, sid := range f.pendingQ {
		if sid == session {
			delete(f.pendingQ, qid)
			delete(f.pendingQReq, qid)
			clearedQ = append(clearedQ, qid)
		}
	}
	for pid, req := range f.pendingP {
		if s, _ := req["sessionID"].(string); s == session {
			delete(f.pendingP, pid)
			clearedP = append(clearedP, pid)
		}
	}
	f.mu.Unlock()
	// Emit the resolve events so the AGGREGATOR store (pkg/state/store.go — the
	// SPA's snapshot source) drops the leaked blocker too. Clearing only the
	// fixture maps above is NOT sufficient: the aggregator holds the
	// question/permission in its store until a resolve event or a re-hydrate
	// (cold start / reconnect / POST /vh/reload), and the serial e2e suite never
	// re-hydrates between spec files. Without these emits, a leaked
	// [[ask]]/[[perm]] from an earlier spec file (e.g. interactive.spec.ts,
	// which sorts before scroll-follow.spec.ts) arms blockerActive() on every
	// subsequent demo open → the PendingInput blocker card mounts at the stream
	// tail (a second button.jump via PendingInput.tsx:64 once the card scrolls
	// out of view), polluting button.jump count assertions during content
	// reshuffles (scroll-follow tests 7 / :864). question.replied/
	// permission.replied map to KindQuestionClear/KindPermissionClear in the
	// store (store.go:754,721), which clear the store AND forward a
	// question.delete/permission.delete to any connected SPA. (P1-WEB-032/033.)
	for _, qid := range clearedQ {
		f.emit("question.replied", map[string]any{"sessionID": session, "requestID": qid})
	}
	for _, pid := range clearedP {
		f.emit("permission.replied", map[string]any{"sessionID": session, "requestID": pid})
	}
	// Emit message.removed for each accumulated message so the aggregator store
	// (pkg/state) drops it too — same aggregator-store-clear rationale as the
	// question.replied/permission.replied emits above. Clearing only f.messages
	// is NOT sufficient: the aggregator holds the accumulated transcript in its
	// store (EnsureMessages short-circuits on IsMessagesLoaded=true so page.goto
	// never re-fetches, and the store's reconcile is upsert-only so a re-hydrate
	// via POST /vh/reload won't remove them either — "absence never deletes").
	// message.removed maps to KindMessageDelete in the store (translate.go →
	// deleteMessageLocked), which removes the message + its parts and forwards a
	// message.delete to any connected SPA. Without these emits, prompt-sending
	// tests (scroll-follow 4/9/10b/11/12) accumulate user+assistant turns across
	// serial --repeat-each iterations, growing scrollHeight so the
	// scroll-follow geometry (captured bottomClamp) drifts stale by repeat 4+.
	// (Cross-repeat transcript-accumulation flake — sibling of the terminal PTY
	// contamination fix 54703e61; both are serial-suite shared-backend state that
	// the per-test fixture reset must explicitly clear from the aggregator.)
	for _, mid := range removedMsgs {
		f.emit("message.removed", map[string]any{"sessionID": session, "messageID": mid})
	}
	// Notify any connected client the session is idle; a fresh page.goto re-reads
	// the cleared status regardless, so this is belt-and-suspenders.
	f.emit("session.idle", map[string]any{"sessionID": session})
	writeJSON(w, map[string]any{"reset": session})
}

// handleFixtureBusy marks a session busy and emits session.status so the
// aggregator store (pkg/state) counts it as a running root — surfacing as a
// running badge in the project switcher's activity data (GET /vh/running-sessions).
// Pairs with /fixture/reset (which clears busy). Deterministic and sticky: the
// session stays running until reset, so an e2e can switch away, reopen the
// switcher, and still observe the badge. Test-only infrastructure — never
// exercised by the shipped binary.
func (f *FakeOpenCode) handleFixtureBusy(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	if session == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	// emit takes the lock itself (and mirrors the status into f.busy), so do NOT
	// hold f.mu here. The aggregator for the session's dir is long-lived in the
	// worker's s.aggs and stays subscribed to /event, so the status reaches it
	// even after the SPA has switched to another workspace.
	f.emit("session.status", map[string]any{
		"sessionID": session,
		"status":    map[string]any{"type": "busy"},
	})
	writeJSON(w, map[string]any{"busy": session})
}

// handleFixtureCompactionBurst scripts the incident-shaped end-of-turn
// compaction burst (2026-08-19 stale-rows incident; FE fix 281a2f2+bcc578c,
// server egress filter 9401881) onto a session through the fake's REAL /event
// stream — the same authoritative ingress path production events take. It is
// the fixture-side scripting seam for web/tests/e2e/compaction-burst.spec.ts:
//
//	POST /fixture/compaction-burst?session=<sid>&tag=<unique>&parents=<n>&promote=<k>
//
// Emitted sequence (deterministic order, all via f.emit):
//  1. session.status busy — a live turn starts.
//  2. The REAL live tail: a user message + text part, then an assistant
//     message whose final text part and completed message.updated land last.
//     This assistant message is the session's real newest message.
//  3. THE BURST: `parents` message ids (tag-m0..m{n-1}) that NEVER receive a
//     message.updated during the burst receive part-ONLY
//     message.part.updated frames — COMPLETED tool parts with old time
//     windows, the fork-like re-publication shape (every 3rd parent gets a
//     second part so multi-part shadows are exercised). Because the store
//     holds part-first messages as keyless placeholders appended at order END
//     (pkg/state reducers.go upsertPartLocked → hydration.go
//     insertMessageIDOrdered: keyless sorts +∞), each parent is the NEWEST
//     and therefore INSIDE the egress window (message_window.go: newest is
//     always in-window) — the real Stream-2 sendable filter DELIVERS these
//     frames by design (the "keyless newest message on the live tail" class).
//     The FE must hold them as keyless shadows: never rendered, never ordered.
//  4. PROMOTION: the first `promote` parents receive message.updated with OLD
//     ascending time.created (minutes ago, older than the live tail). The FE
//     promotion path re-slots these ex-shadows into their chronological
//     positions BEFORE the live tail — rendered, but never as tail rows.
//  5. session.idle — the turn ends; the transcript must settle clean.
//
// The handler also PERSISTS the scripted messages into f.messages (keyed info
// for live tail + promoted parents; stub info for unpromoted parents) so the
// established /fixture/reset hygiene removes them: reset diffs f.messages
// against the seeded baseline and emits message.removed for every scripted
// id, clearing both the fixture store and the aggregator store for later
// serial-suite specs. Test-only infrastructure — never exercised by the
// shipped binary.
func (f *FakeOpenCode) handleFixtureCompactionBurst(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	tag := r.URL.Query().Get("tag")
	parents, _ := strconv.Atoi(r.URL.Query().Get("parents"))
	promote, _ := strconv.Atoi(r.URL.Query().Get("promote"))
	if session == "" || tag == "" || parents <= 0 || promote < 0 || promote > parents {
		http.Error(w, "need session, tag, parents>0, 0<=promote<=parents", http.StatusBadRequest)
		return
	}
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	f.mu.Lock()
	f.counter++
	n := f.counter
	f.mu.Unlock()

	// Phase 1 — busy.
	f.emit("session.status", map[string]any{"sessionID": session, "status": map[string]any{"type": "busy"}})

	// Phase 2 — the real live tail (user + completed assistant).
	userID := tag + "-lu"
	asstID := tag + "-la"
	t0 := now()
	userInfo := map[string]any{"id": userID, "sessionID": session, "role": "user", "time": map[string]any{"created": t0, "completed": t0}}
	userPart := textPart(userID, session, tag+"-lup", "Run the end-of-turn migration.", t0)
	f.emit("message.updated", map[string]any{"info": userInfo})
	f.emit("message.part.updated", map[string]any{"part": userPart})
	time.Sleep(40 * time.Millisecond)
	asstInfo := map[string]any{"id": asstID, "sessionID": session, "role": "assistant", "agent": "build",
		"time": map[string]any{"created": now()}}
	f.emit("message.updated", map[string]any{"info": asstInfo})
	asstText := "Migration applied. Compaction sweep finished; the transcript tail stays clean."
	asstPart := textPart(asstID, session, tag+"-lap", asstText, now())
	f.emit("message.part.updated", map[string]any{"part": asstPart})
	// Mirror streamAssistant's real bookend: the final message.part.updated is
	// followed by message.updated carrying time.completed (the settle signal
	// the FE's settled() presentation reads) before the turn ends.
	asstInfo["time"] = map[string]any{"created": asstInfo["time"].(map[string]any)["created"], "completed": now()}
	f.emit("message.updated", map[string]any{"info": asstInfo})
	time.Sleep(40 * time.Millisecond)

	// Phase 3 — THE BURST: part-ONLY re-publications for non-resident parents.
	// No message.updated is emitted for these ids until Phase 4 (and never for
	// the unpromoted remainder). Tool outputs are a few hundred bytes each —
	// incident-shaped completed tool bodies, kept small so the whole burst sits
	// far inside the egress window's 1 MiB byte bound.
	toolBody := func(i int) string {
		return strings.Repeat(fmt.Sprintf("src/pkg%02d/file.go:%d: match line with context\n", i%7, 10+i), 8)
	}
	type scripted struct {
		info    map[string]any   // nil for unpromoted (stub written at persist time)
		parts   []map[string]any // keyed by the parent's own part ids
		created float64
	}
	burst := make([]scripted, parents)
	for i := 0; i < parents; i++ {
		mid := fmt.Sprintf("%s-m%d", tag, i)
		pid := fmt.Sprintf("%s-pt%d", tag, i)
		old := now() - float64((parents-i)*60_000) // old, ascending per i
		part := map[string]any{
			"id": pid, "sessionID": session, "messageID": mid, "type": "tool",
			"callID": fmt.Sprintf("%s-c%d", tag, i), "tool": "grep",
			"state": map[string]any{
				"status": "completed", "title": fmt.Sprintf("search history slice %d", i),
				"input":  map[string]any{"pattern": fmt.Sprintf("token%d", i)},
				"output": toolBody(i),
				"time":   map[string]any{"start": old, "end": old + 800},
			},
		}
		f.emit("message.part.updated", map[string]any{"part": part})
		p := []map[string]any{part}
		if i%3 == 0 {
			// A second part for every 3rd parent: multi-part shadows.
			pid2 := fmt.Sprintf("%s-pt%db", tag, i)
			part2 := map[string]any{
				"id": pid2, "sessionID": session, "messageID": mid, "type": "tool",
				"callID": fmt.Sprintf("%s-c%db", tag, i), "tool": "read",
				"state": map[string]any{
					"status": "completed", "title": fmt.Sprintf("read file slice %d", i),
					"input":  map[string]any{"filePath": fmt.Sprintf("src/pkg%02d/file.go", i%7)},
					"output": "package demo\n\n// re-published historical file body\n",
					"time":   map[string]any{"start": old + 100, "end": old + 600},
				},
			}
			f.emit("message.part.updated", map[string]any{"part": part2})
			p = append(p, part2)
		}
		burst[i] = scripted{parts: p, created: old}
	}

	// Phase 4 — promotion: keyed message.updated for the FIRST `promote`
	// parents, with time.created older than the live tail and ascending with
	// i (m0 oldest), so each promoted ex-shadow must slot chronologically
	// BEFORE the live tail, in ascending-created order.
	time.Sleep(40 * time.Millisecond)
	for i := 0; i < promote; i++ {
		mid := fmt.Sprintf("%s-m%d", tag, i)
		created := now() - float64((parents-i)*60_000)
		info := map[string]any{"id": mid, "sessionID": session, "role": "assistant", "agent": "build",
			"time": map[string]any{"created": created, "completed": created + 900}}
		f.emit("message.updated", map[string]any{"info": info})
		burst[i].info = info
		burst[i].created = created
	}

	// Phase 5 — idle.
	f.emit("session.idle", map[string]any{"sessionID": session})

	// Persist the scripted transcript so /fixture/reset removes it (diff vs
	// seeded baseline emits message.removed per id, clearing the aggregator
	// store too). Unpromoted parents get stub info — their identity exists only
	// for the reset diff; nothing fetches them before the reset.
	f.mu.Lock()
	f.messages[session] = append(f.messages[session],
		messageWithParts{Info: userInfo, Parts: []map[string]any{userPart}},
		messageWithParts{Info: asstInfo, Parts: []map[string]any{asstPart}},
	)
	for i := range burst {
		info := burst[i].info
		if info == nil {
			mid := fmt.Sprintf("%s-m%d", tag, i)
			info = map[string]any{"id": mid, "sessionID": session, "role": "assistant"}
		}
		f.messages[session] = append(f.messages[session], messageWithParts{Info: info, Parts: burst[i].parts})
	}
	f.mu.Unlock()

	writeJSON(w, map[string]any{
		"session": session, "tag": tag, "parents": parents, "promote": promote,
		"user": userID, "assistant": asstID, "turn": n,
		"promoted": func() []string {
			out := []string{}
			for i := 0; i < promote; i++ {
				out = append(out, fmt.Sprintf("%s-m%d", tag, i))
			}
			return out
		}(),
		"unpromoted": func() []string {
			out := []string{}
			for i := promote; i < parents; i++ {
				out = append(out, fmt.Sprintf("%s-m%d", tag, i))
			}
			return out
		}(),
	})
}

// handleFixtureOrphan scripts the "instance died mid-generation" orphaned-tail
// state (2026-08-20 dead-instance incident; FE fix 7b0c31d + 4faad3f,
// unit-proven only until the session-completion e2e specs) onto a session
// through the fake's REAL /event stream — the same authoritative ingress path
// production events take. It is the fixture-side scripting seam for the
// orphan-tail tests in web/tests/e2e/session-completion.spec.ts:
//
//	POST /fixture/orphan?session=<sid>&later=<0|1>
//
// The orphan shape (what a mid-generation death leaves behind — the generating
// opencode process is GONE, so no terminal event will ever come):
//   - a session whose activity transitions busy → idle and then falls SILENT
//     (the session.idle below is the last event the "instance" ever emits);
//   - a user message that completed normally;
//   - an assistant message with NO time.completed whose parts carry time.start
//     but NO time.end — a reasoning part and a text part both cut mid-word.
//     This is the orphaned incomplete tail the SPA must render SETTLED (no
//     streaming engine, no caret, no ticking/fabricated reasoning duration).
//
// later=1 appends a SECOND, fully-completed turn AFTER the death (the operator
// resumed the session later and got a fresh finished turn) — making the
// incomplete assistant MID-HISTORY: the transcript's newest message is a
// different, completed one, so the orphan's settlement must come from the
// POSITIONAL disjunct (MessageParts settled() clause 3), not from any stamp.
//
// Re-arm + /fixture/reset hygiene: scripted ids use the fixed "orph" prefix.
// Re-arming first strips any prior orphan scripting from f.messages and emits
// message.removed for each stripped id (clearing the aggregator store — same
// rationale as handleFixtureReset's fan-out), so the handler is
// idempotent/re-armable; /fixture/reset removes the scripting the same way
// (scratch sessions like `other` have no seeded baseline, so EVERY resident id
// is non-baseline and gets the fan-out). Test-only infrastructure — never
// exercised by the shipped binary.
func (f *FakeOpenCode) handleFixtureOrphan(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	later := r.URL.Query().Get("later") == "1"
	if session == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	now := func() float64 { return float64(time.Now().UnixMilli()) }

	// Re-arm hygiene: strip prior orphan-scripted messages (fixture store) and
	// collect their ids so the post-unlock emits clear the aggregator store.
	f.mu.Lock()
	var removedMsgs []string
	kept := f.messages[session][:0]
	for _, m := range f.messages[session] {
		if id, _ := m.Info["id"].(string); strings.HasPrefix(id, "orph") {
			removedMsgs = append(removedMsgs, id)
			continue
		}
		kept = append(kept, m)
	}
	f.messages[session] = kept
	f.mu.Unlock()
	for _, mid := range removedMsgs {
		f.emit("message.removed", map[string]any{"sessionID": session, "messageID": mid})
	}

	// Phase 1 — busy (the turn starts; drives the sidebar dot + activity map).
	f.emit("session.status", map[string]any{"sessionID": session, "status": map[string]any{"type": "busy"}})

	// Phase 2 — the user turn (completes normally).
	t0 := now()
	orphUserInfo := map[string]any{"id": "orph-u", "sessionID": session, "role": "user", "time": map[string]any{"created": t0, "completed": t0}}
	orphUserPart := textPart("orph-u", session, "orph-up", "orphan probe: refactor the wobble engine and explain", t0)
	f.emit("message.updated", map[string]any{"info": orphUserInfo})
	f.emit("message.part.updated", map[string]any{"part": orphUserPart})

	// Phase 3 — the assistant turn that NEVER finishes: message.info has NO
	// time.completed and both trailing parts have time.start with NO time.end
	// (reasoning first, then a text part cut mid-word). This is the orphaned
	// incomplete tail.
	time.Sleep(40 * time.Millisecond)
	orphAsstInfo := map[string]any{"id": "orph-a", "sessionID": session, "role": "assistant", "agent": "build",
		"time": map[string]any{"created": now()}}
	f.emit("message.updated", map[string]any{"info": orphAsstInfo})
	orphReasonPart := map[string]any{"id": "orph-ar", "sessionID": session, "messageID": "orph-a", "type": "reasoning",
		"text": "the wobble engine has three moving parts; first I inspect the flywheel asse", // cut mid-word
		"time": map[string]any{"start": now()}}
	f.emit("message.part.updated", map[string]any{"part": orphReasonPart})
	time.Sleep(40 * time.Millisecond)
	orphTextPart := map[string]any{"id": "orph-at", "sessionID": session, "messageID": "orph-a", "type": "text",
		"text": "I started refactoring the wobble engine. The flywheel is detached from the conne", // cut mid-word
		"time": map[string]any{"start": now()}}
	f.emit("message.part.updated", map[string]any{"part": orphTextPart})

	// Phase 4 — the DEATH: session.idle is the last event the instance ever
	// emits for this turn. Busy clears; no completion bookend will EVER arrive
	// for the assistant above. Silence follows.
	f.emit("session.idle", map[string]any{"sessionID": session})

	// Optional Phase 5 — later=1: a fully-completed RESUMED turn AFTER the
	// death, making the orphan mid-history.
	var lateUserInfo, lateAsstInfo map[string]any
	var lateUserPart, lateAsstPart map[string]any
	if later {
		time.Sleep(40 * time.Millisecond)
		f.emit("session.status", map[string]any{"sessionID": session, "status": map[string]any{"type": "busy"}})
		t1 := now()
		lateUserInfo = map[string]any{"id": "orph-lu", "sessionID": session, "role": "user", "time": map[string]any{"created": t1, "completed": t1}}
		lateUserPart = textPart("orph-lu", session, "orph-lup", "orphan probe: resume and finish the refactor", t1)
		f.emit("message.updated", map[string]any{"info": lateUserInfo})
		f.emit("message.part.updated", map[string]any{"part": lateUserPart})
		time.Sleep(40 * time.Millisecond)
		lateAsstInfo = map[string]any{"id": "orph-la", "sessionID": session, "role": "assistant", "agent": "build",
			"time": map[string]any{"created": now()}}
		f.emit("message.updated", map[string]any{"info": lateAsstInfo})
		lateAsstPart = textPart("orph-la", session, "orph-lt",
			"Resumed cleanly. The wobble engine refactor is complete and the flywheel is reattached.", now())
		f.emit("message.part.updated", map[string]any{"part": lateAsstPart})
		// Normal completion bookend (the contrast with the orphan above): the
		// message gains time.completed AFTER the final part — the settle signal
		// the FE's settled() presentation reads. Then the turn ends idle.
		lateAsstInfo["time"] = map[string]any{"created": lateAsstInfo["time"].(map[string]any)["created"], "completed": now()}
		f.emit("message.updated", map[string]any{"info": lateAsstInfo})
		f.emit("session.idle", map[string]any{"sessionID": session})
	}

	// Persist the scripted transcript so /fixture/reset removes it (diff vs
	// seeded baseline → message.removed per id, clearing the aggregator store
	// too) and any EnsureMessages re-fetch returns the same shape.
	f.mu.Lock()
	f.messages[session] = append(f.messages[session],
		messageWithParts{Info: orphUserInfo, Parts: []map[string]any{orphUserPart}},
		messageWithParts{Info: orphAsstInfo, Parts: []map[string]any{orphReasonPart, orphTextPart}},
	)
	if later {
		f.messages[session] = append(f.messages[session],
			messageWithParts{Info: lateUserInfo, Parts: []map[string]any{lateUserPart}},
			messageWithParts{Info: lateAsstInfo, Parts: []map[string]any{lateAsstPart}},
		)
	}
	f.mu.Unlock()

	writeJSON(w, map[string]any{
		"session": session, "later": later, "user": "orph-u", "orphan": "orph-a",
		"reasoning": "orph-ar", "partial": "orph-at",
		"resumeUser": "orph-lu", "resumeAssistant": "orph-la",
		"stripped": len(removedMsgs),
	})
}

// handleFixtureDelete removes a session entirely from the fake's in-memory
// dataset: deletes it from f.sessions, f.archived, f.busy, and f.messages. This
// simulates a mid-stream DB delete (session gone from /session) so the
// server-side tree reconcile tick (§6.2) can be exercised end-to-end. After the
// delete, GET /session no longer returns the id, and the aggregator's reconcile
// tick will emit a corrective node.remove. Test-only infrastructure.
func (f *FakeOpenCode) handleFixtureDelete(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	if session == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	filtered := f.sessions[:0]
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id != session {
			filtered = append(filtered, s)
		}
	}
	f.sessions = filtered
	delete(f.archived, session)
	delete(f.busy, session)
	delete(f.messages, session)
	f.mu.Unlock()
	// Emit a session.deleted event so the aggregator's event subscriber drops it
	// immediately too (not just on the next reconcile tick). Real OpenCode emits
	// this when a session is hard-deleted.
	//
	// Shape note: {"info":{"id":...}} — TranslatorV1's session.deleted arm
	// (pkg/state/translate.go:148) parses an info envelope; the bare
	// {"sessionID":...} this handler used to emit is silently IGNORED
	// (NormIgnored), so the live purge never fired and only the 5s tree-reconcile
	// tick cleaned the store (found while pinning the agent-hold arm/reset
	// determinism — same trap).
	f.emit("session.deleted", map[string]any{"info": map[string]any{"id": session}})
	writeJSON(w, map[string]any{"deleted": session})
}

// agentHoldSessionRow builds the agenthold session row. A ROOT (no parentID)
// with a real model so the composer's model side resolves, timestamps old
// enough to sit among the seeded roots. Fresh `now` per arm so a re-arm after
// a release reads as a genuinely new row for time-sorted UI.
func agentHoldSessionRow(now float64) map[string]any {
	return map[string]any{
		"id": agentHoldSessionID, "projectID": "proj", "title": "Agent evidence hold", "directory": demoDir,
		"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
		"time":  map[string]any{"created": now - 6000, "updated": now - 6000},
	}
}

// agentHoldTranscript builds the scripted release-time transcript: one user
// message WITHOUT an agent stamp and one assistant message stamped with the
// `plan` agent (a real primary agent in the fixture's /agent list). The FE
// resolver's live scan (sessionLastAgent, web/src/sync/selectors.ts) reads
// info.agent off ANY message newest-first, so the assistant stamp is the
// evidence that flips the composer from "Resolving agent…" to "@plan".
func agentHoldTranscript(now float64) []messageWithParts {
	return []messageWithParts{
		{
			Info:  map[string]any{"id": "hold-u1", "sessionID": agentHoldSessionID, "role": "user", "time": map[string]any{"created": now - 4000, "completed": now - 4000}},
			Parts: []map[string]any{textPart("hold-u1", agentHoldSessionID, "hold-p1", "Map the deployment topology for the parser service.", now-4000)},
		},
		{
			Info: map[string]any{"id": "hold-a1", "sessionID": agentHoldSessionID, "role": "assistant", "agent": "plan",
				"time":  map[string]any{"created": now - 3900, "completed": now - 3500},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think", "variant": "high"}},
			Parts: []map[string]any{textPart("hold-a1", agentHoldSessionID, "hold-p2", "Topology mapped: parser feeds the tokenizer; the fixture harness wraps both. No external calls.", now-3900)},
		},
	}
}

// releaseAgentHoldLatch closes any installed hold latch and disarms it.
// Idempotent. Closing (not nil-then-race) wakes every held GET at once.
func (f *FakeOpenCode) releaseAgentHoldLatch() {
	f.agentHoldMu.Lock()
	ch := f.agentHoldBlock
	f.agentHoldBlock = nil
	f.agentHoldMu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// handleFixtureAgentHoldArm performs a full deterministic (re)arm of the
// agent-evidence-hold session. It is idempotent and order-independent: every
// arm starts from the same fixture-side AND aggregator-visible state, however
// many releases, prompts, or sibling resets happened before. Steps:
//
//  1. Close any stale latch (unblock GETs wedged by a prior arm).
//  2. Fixture-side reset under f.mu: script the release-time transcript
//     (dropping any turns accumulated by prompts since the last arm), clear
//     busy/pending blocker state, bump resetGen (invalidates leaked stall
//     defers — same rationale as handleFixtureReset), drop any existing row,
//     append a fresh one.
//  3. Install the fresh latch BEFORE any emit, so a GET racing the
//     session.created fan-out already blocks.
//  4. Emit session.deleted (only if a row existed — the aggregator store's
//     deleteSessionLocked clears messages, msgLoaded, lastAgent, the
//     cold-seed memo, and the EnsureMessages single-flight latch: BOTH
//     memoization traps the brief warns about) then session.created (fresh
//     re-admit with no lastAgent).
//
// While armed: the row is visible in /session immediately (nonempty tree row
// for the SPA), and the message-LIST GET holds indefinitely — the FE sees no
// window (not provably-empty), so resolveAgentForSession stays `pending` and
// the composer shows "Resolving agent…". Test-only infrastructure.
func (f *FakeOpenCode) handleFixtureAgentHoldArm(w http.ResponseWriter, r *http.Request) {
	f.releaseAgentHoldLatch()
	now := float64(time.Now().UnixMilli())
	row := agentHoldSessionRow(now)

	f.mu.Lock()
	existed := false
	filtered := f.sessions[:0]
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id != agentHoldSessionID {
			filtered = append(filtered, s)
		} else {
			existed = true
		}
	}
	f.sessions = append(filtered, row)
	f.messages[agentHoldSessionID] = agentHoldTranscript(now)
	delete(f.busy, agentHoldSessionID)
	delete(f.archived, agentHoldSessionID)
	for qid, sid := range f.pendingQ {
		if sid == agentHoldSessionID {
			delete(f.pendingQ, qid)
			delete(f.pendingQReq, qid)
		}
	}
	for pid, req := range f.pendingP {
		if s, _ := req["sessionID"].(string); s == agentHoldSessionID {
			delete(f.pendingP, pid)
		}
	}
	f.resetGen[agentHoldSessionID]++
	f.mu.Unlock()

	// Latch first, emits second: any message GET the aggregator spawns off the
	// session.created fan-out (cold-seed or client-open fetch) must already
	// block. (A GET that slipped through in the microsecond window between the
	// stale-latch close above and this install would serve the fresh scripted
	// transcript early; in the serial spec flow nothing is fetching agenthold
	// at arm time — the previous page is closed.)
	f.agentHoldMu.Lock()
	f.agentHoldBlock = make(chan struct{})
	f.agentHoldMu.Unlock()

	if existed {
		// Shape: {"info":{"id":...}} — what TranslatorV1's session.deleted arm
		// parses (pkg/state/translate.go:148). A bare {"sessionID":...} is
		// silently IGNORED (NormIgnored), leaving the aggregator store holding
		// the session's messages/lastAgent/msgLoaded — exactly the stale-state
		// trap that made a re-arm nondeterministic (repeat-run flake).
		f.emit("session.deleted", map[string]any{"info": map[string]any{"id": agentHoldSessionID}})
	}
	f.emit("session.created", map[string]any{"info": row})
	writeJSON(w, map[string]any{"armed": agentHoldSessionID})
}

// handleFixtureAgentHoldRelease releases the evidence hold: held message GETs
// complete and serve the scripted plan-stamped transcript, which the
// aggregator's reconcile turns into message deltas + messages.loaded — the FE
// live scan then resolves the composer to @plan. Idempotent (no-op when not
// armed). No session-list change: the row was already visible from arm.
func (f *FakeOpenCode) handleFixtureAgentHoldRelease(w http.ResponseWriter, r *http.Request) {
	f.releaseAgentHoldLatch()
	writeJSON(w, map[string]any{"released": agentHoldSessionID})
}

// handleFixtureAgentHoldReset is the afterEach hygiene teardown: release any
// hold, remove the session row + transcript + blocker state fixture-side, and
// emit session.deleted so the aggregator store forgets it entirely. After a
// reset the session does not exist at all — sibling specs in the serial suite
// never observe agenthold, making the spec order-independent.
func (f *FakeOpenCode) handleFixtureAgentHoldReset(w http.ResponseWriter, r *http.Request) {
	f.releaseAgentHoldLatch()
	f.mu.Lock()
	existed := false
	filtered := f.sessions[:0]
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id != agentHoldSessionID {
			filtered = append(filtered, s)
		} else {
			existed = true
		}
	}
	f.sessions = filtered
	delete(f.messages, agentHoldSessionID)
	delete(f.busy, agentHoldSessionID)
	delete(f.archived, agentHoldSessionID)
	delete(f.resetGen, agentHoldSessionID)
	for qid, sid := range f.pendingQ {
		if sid == agentHoldSessionID {
			delete(f.pendingQ, qid)
			delete(f.pendingQReq, qid)
		}
	}
	for pid, req := range f.pendingP {
		if s, _ := req["sessionID"].(string); s == agentHoldSessionID {
			delete(f.pendingP, pid)
		}
	}
	f.mu.Unlock()
	if existed {
		// Same info-envelope shape as arm (see the note there).
		f.emit("session.deleted", map[string]any{"info": map[string]any{"id": agentHoldSessionID}})
	}
	writeJSON(w, map[string]any{"reset": agentHoldSessionID})
}

func (f *FakeOpenCode) appendMessage(sessionID string, m messageWithParts) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[sessionID] = append(f.messages[sessionID], m)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
