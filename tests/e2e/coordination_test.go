package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/mcp"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// cluster is shared across the package: one real controller + tunneled worker +
// fake opencode, brought up once.
var cluster *Cluster

func TestMain(m *testing.M) {
	c, err := StartCluster()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e setup failed:", err)
		os.Exit(1)
	}
	cluster = c
	code := m.Run()
	c.Close()
	os.Exit(code)
}

func wpath(suffix string) string { return "/api/workers/" + cluster.WorkerID + suffix }

// V1 + V3: a snapshot over the tunnel carries gate facts and the epoch header.
func TestE2E_SnapshotGateAndEpochOverTunnel(t *testing.T) {
	resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("snapshot want 200, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Vh-Epoch") == "" {
		t.Fatal("X-VH-Epoch header must pass through the tunnel")
	}
	var snap struct {
		Epoch string                    `json:"epoch"`
		Gate  map[string]map[string]any `json:"gate"`
	}
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("snapshot decode: %v", err)
	}
	if snap.Epoch == "" {
		t.Fatal("snapshot must carry epoch")
	}
	// The fixture seeds a "demo" root session; its gate must be present.
	if _, ok := snap.Gate["demo"]; !ok {
		t.Fatalf("gate facts missing for fixture session 'demo' (gate keys: %v)", keys(snap.Gate))
	}
	g := snap.Gate["demo"]
	if _, ok := g["activity"]; !ok {
		t.Fatalf("gate.demo missing activity: %v", g)
	}
}

// V3: the coordination API is bearer-gated and resolves workers.
func TestE2E_AuthAndWorkerResolution(t *testing.T) {
	if resp, _, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", "", nil); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no bearer want 401, got %v (err %v)", statusOf(resp), err)
	}
	if resp, _, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", "wrong", nil); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong bearer want 401, got %v (err %v)", statusOf(resp), err)
	}
	if resp, _, err := cluster.Do(http.MethodGet, "/api/workers/nope/sessions", "", cluster.APIToken, nil); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown worker want 404, got %v (err %v)", statusOf(resp), err)
	}
}

// V2: spawn / send / abort drive the worker's opencode through the tunnel.
func TestE2E_SpawnSendAbortOverTunnel(t *testing.T) {
	resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions"), `{"title":"e2e"}`, cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("spawn want 200, got %v: %s", statusOf(resp), body)
	}
	var sp struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(body, &sp)
	if !sp.OK || !strings.HasPrefix(sp.SessionID, "ses_") {
		t.Fatalf("spawn result unexpected: %s", body)
	}

	// send to the spawned session.
	resp, body, err = cluster.Do(http.MethodPost, wpath("/sessions/"+sp.SessionID+"/message"), `{"text":"continue"}`, cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("send want 200, got %v: %s", statusOf(resp), body)
	}

	// abort (DELETE) the fixture's demo session.
	resp, body, err = cluster.Do(http.MethodDelete, wpath("/sessions/demo"), "", cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("abort want 200, got %v: %s", statusOf(resp), body)
	}
}

// TestE2E_AbortSettleSendOverTunnel is the P7 Slice 3 load-bearing proof: a
// CAS-bearing /vh/send issued DURING an abort-settle window AWAITS the
// fail-closed gate (zero prompts reach the fake OpenCode), then — once the
// canceled run's terminal (session.idle / session.error) propagates back through
// the real /event stream to the worker store — forwards EXACTLY ONE prompt when
// the fresh CAS passes (idle release), or 409s when the settle leaves the
// session non-sendable (error release). This is what makes "P7 = abort races
// fixed" actually true: it observes the await + terminal-settle + forward/409
// OUTCOME end-to-end over the real in-process tunnel
// (controller → yamux → worker /vh/send → store gate ← fixture terminal),
// not just an abort verb returning 200.
//
// Determinism: the abort is settled by a fixture seam emitting the terminal
// event directly through the real /event stream (Fake.EmitSessionTerminal), NOT
// by sleeping for the ~5s settle timer. The consumer's WaitAbortSettling is
// event-driven (ctx-cancellable), so the test triggers release via the seam.
// The settle window is armed by a stable busy (Fake.EmitSessionBusy — no
// [[stall]] 5s sleep, no [[perm]]/[[ask]] pending blocker), so nothing competes
// with the deterministic seam release.
//
// Parking determinism (p7-d4): the CAS send reaching the commit-to-park
// boundary in the await is proven via the waitAbortSettlingParkHook (fired at
// the commit-to-park point inside the worker's WaitAbortSettling), NOT by an
// elapsed-time sleep — so a release landing before the goroutine reached the
// park point cannot pass the test vacuously. The hook is reachable because the
// harness is in-process: the worker's pkg/state package var IS the test's
// package var (same process, same binary).
func TestE2E_AbortSettleSendOverTunnel(t *testing.T) {
	// spawnAbortSettle brings a FRESH spawned session into the abort-settle
	// window: a real spawn over the tunnel, a deterministic busy via the fixture
	// seam (propagated through the real /event stream), then a real abort over
	// the tunnel (DELETE → /vh/abort → fixture abort + Store.Stop → TurnStopping,
	// gate closed). Returns the session id. Each call spawns its own session so
	// leaked goroutines / state from one sub-test cannot perturb another.
	spawnAbortSettle := func(t *testing.T) string {
		t.Helper()
		resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions"),
			`{"title":"abort-settle-e2e"}`, cluster.APIToken, nil)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("spawn want 200, got %v: %s (err %v)", statusOf(resp), body, err)
		}
		var sp struct {
			OK        bool   `json:"ok"`
			SessionID string `json:"sessionID"`
		}
		_ = json.Unmarshal(body, &sp)
		if !sp.OK || !strings.HasPrefix(sp.SessionID, "ses_") {
			t.Fatalf("spawn result unexpected: %s", body)
		}
		sid := sp.SessionID
		// Confirm the spawn's session.created reached the store over yamux (gate
		// present + idle) before arming busy, so the busy emit lands on a known
		// session. The /event stream is FIFO (created is emitted before the spawn
		// response; busy is emitted after), but polling confirms propagation.
		waitGateActivity(t, sid, "idle")
		// Deterministic busy: a LIVE session.status busy through the real event
		// stream (the authoritative new-turn path). Stable — no auto-idle, no
		// pending blocker — so the abort-settle gate stays closed until the seam
		// releases it.
		cluster.Fake.EmitSessionBusy(sid)
		waitGateActivity(t, sid, "busy")
		// Real abort over the tunnel. Store.Stop runs synchronously in the
		// handler (TurnStopping + close the gate), so the gate is closed by the
		// time the 200 returns.
		resp, body, err = cluster.Do(http.MethodDelete, wpath("/sessions/"+sid), "", cluster.APIToken, nil)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("abort want 200, got %v: %s (err %v)", statusOf(resp), body, err)
		}
		return sid
	}

	// asyncCASSend issues a CAS-bearing /vh/send (If-Idle-Seq) over the tunnel
	// in a goroutine. Returns a done channel (closed on return) + a result
	// pointer the goroutine writes. assertAwaiting (below) pairs this done
	// channel with the park hook to prove the send reached commit-to-park in
	// WaitAbortSettling before the seam release (done not closed ⇒ awaiting).
	asyncCASSend := func(sid, ifIdleSeq string) (<-chan struct{}, *casSendResult) {
		res := &casSendResult{}
		done := make(chan struct{})
		go func() {
			defer close(done)
			resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions/"+sid+"/message"),
				`{"text":"follow-up after abort"}`, cluster.APIToken,
				map[string]string{"If-Idle-Seq": ifIdleSeq})
			if err != nil {
				res.err = err
				return
			}
			res.st = resp.StatusCode
			res.body = body
		}()
		return done, res
	}

	// armParkHook installs the deterministic parked-observable for the P7
	// await-path. The e2e harness is fully in-process (StartCluster runs the
	// controller daemon + worker agent + worker web server in one process), so
	// the worker's pkg/state package-level waitAbortSettlingParkHook var is the
	// SAME instance the test reaches via state.SetWaitAbortSettlingParkHookForTest.
	// The hook fires at the COMMIT-TO-PARK point inside the worker's
	// WaitAbortSettling (gate confirmed closed under RLock, wait channel in hand,
	// blocking select is the very next statement), so receiving the signal
	// deterministically proves the CAS send goroutine reached the commit-to-park
	// boundary (abort gate channel in hand) BEFORE the terminal release is
	// injected. This replaces the prior 150ms elapsed-time barrier as the sole
	// parking proof, which could pass vacuously under scheduler delay (the release
	// landing before the goroutine reached the park point →
	// fast-path return → the test passes without exercising the await-unblock
	// path). A broken/missing consumer that immediate-409s would never reach
	// the park point → the bounded-liveness timeout fails the test. The hook is
	// reset in t.Cleanup so each sub-test owns it cleanly.
	armParkHook := func(t *testing.T, sid string) <-chan struct{} {
		t.Helper()
		parked := make(chan struct{}, 1)
		state.SetWaitAbortSettlingParkHookForTest(func(s string) {
			if s == sid {
				select {
				case parked <- struct{}{}:
				default:
				}
			}
		})
		t.Cleanup(func() { state.SetWaitAbortSettlingParkHookForTest(nil) })
		return parked
	}

	// assertAwaiting proves the CAS send reached the commit-to-park boundary in
	// the worker's AbortSettling await: the park hook fired at the commit-to-park
	// point (the send goroutine holds the abort gate channel; the blocking select
	// is next) AND the fake OpenCode has received ZERO prompts for it (the
	// consumer forwards only AFTER the gate opens). A pre-consumer immediate
	// 409/200 would never fire the park hook → the bounded-liveness timeout fails
	// this assertion — the RED signal for a missing/broken consumer or a gate
	// that was not actually closed.
	assertAwaiting := func(t *testing.T, parked <-chan struct{}, sid string) {
		t.Helper()
		select {
		case <-parked:
			// good: the CAS send goroutine reached commit-to-park in the worker's WaitAbortSettling.
		case <-time.After(5 * time.Second):
			t.Fatal("CAS send did not park in WaitAbortSettling — consumer missing/broken, or park hook did not fire over the tunnel")
		}
		if n := cluster.Fake.PromptArrivals(sid); n != 0 {
			t.Fatalf("during await: PromptArrivals=%d, want 0 (await must not forward to OpenCode)", n)
		}
	}

	// Huge If-Idle-Seq ⇒ the fresh seq CAS always passes after release; only the
	// abort window blocks the initial send. (seqCAS = activitySeq <= providedSeq;
	// 999999 is >= any realistic activity seq for a freshly spawned session.)
	const freshCAS = "999999"

	t.Run("idle_release_forwards_exactly_one_prompt", func(t *testing.T) {
		sid := spawnAbortSettle(t)
		parked := armParkHook(t, sid)
		done, res := asyncCASSend(sid, freshCAS)
		assertAwaiting(t, parked, sid)

		// Deterministic release: a LIVE session.idle through the real /event
		// stream settles the abort (busy→idle, gate opens, TurnIdle). The waiter
		// wakes, the fresh CAS passes, and the send forwards EXACTLY ONE prompt.
		cluster.Fake.EmitSessionTerminal(sid, "session.idle")
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("after idle release: CAS send did not return (terminal did not settle the gate over the tunnel)")
		}
		if res.st != 200 {
			t.Fatalf("after idle release: CAS send status=%d, want 200 (fresh CAS passes → forward), body=%s", res.st, res.body)
		}
		if n := cluster.Fake.PromptArrivals(sid); n != 1 {
			t.Fatalf("after idle release: PromptArrivals=%d, want EXACTLY 1 (the fresh CAS forwarded one prompt to OpenCode)", n)
		}
	})

	t.Run("error_release_unblocks_but_non_sendable_409", func(t *testing.T) {
		// The error terminal settles the abort gate (the await unblocks) BUT
		// leaves activity in the ERROR state, so the fresh SendableNow CAS fails
		// → 409 (continued non-sendability after release). This also gives a
		// STABLE terminal-propagation observation over yamux: with no prompt
		// forwarded there is no subsequent busy churn, so the snapshot's gate
		// activity settles to "error" and stays there.
		sid := spawnAbortSettle(t)
		parked := armParkHook(t, sid)
		done, res := asyncCASSend(sid, freshCAS)
		assertAwaiting(t, parked, sid)

		cluster.Fake.EmitSessionTerminal(sid, "session.error")
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("after error release: CAS send did not return (error terminal did not settle the gate)")
		}
		if res.st != http.StatusConflict {
			t.Fatalf("after error release: CAS send status=%d, want 409 (activity=error → fresh CAS fails), body=%s", res.st, res.body)
		}
		if n := cluster.Fake.PromptArrivals(sid); n != 0 {
			t.Fatalf("after error release: PromptArrivals=%d, want 0 (non-sendable → no forward)", n)
		}
		// The terminal propagated back over yamux to the store: the snapshot's
		// gate activity for the session is now "error" (stable — no forward to
		// churn it back to busy).
		waitGateActivity(t, sid, "error")
	})
}

// casSendResult captures an async CAS /vh/send response written by asyncCASSend's
// goroutine. st=0 means the request errored before a status was received (res.err
// holds the error); the tests assert on st for the consumer-contract outcome.
type casSendResult struct {
	st   int
	body []byte
	err  error
}

// waitGateActivity polls the controller snapshot (over yamux) until session sid's
// gate activity reaches want, failing the test on timeout. The snapshot is the
// controller's view of the worker's store carried through the tunnel, so reaching
// `want` is the over-tunnel observable for "a transition propagated to the store".
func waitGateActivity(t *testing.T, sid, want string) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
		if err == nil && resp.StatusCode == 200 {
			var snap struct {
				Gate map[string]struct {
					Activity string `json:"activity"`
				} `json:"gate"`
			}
			if json.Unmarshal(body, &snap) == nil {
				if g, ok := snap.Gate[sid]; ok && g.Activity == want {
					return
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("gate activity for %s never reached %q over the tunnel within 6s", sid, want)
}

// V2: idempotency_key dedups a spawn even across the tunnel.
func TestE2E_IdempotentSpawnOverTunnel(t *testing.T) {
	body := `{"title":"idem","idempotency_key":"e2e-idem-1"}`
	r1, b1, err := cluster.Do(http.MethodPost, wpath("/sessions"), body, cluster.APIToken, nil)
	if err != nil || r1.StatusCode != 200 {
		t.Fatalf("first spawn want 200, got %v: %s", statusOf(r1), b1)
	}
	r2, b2, err := cluster.Do(http.MethodPost, wpath("/sessions"), body, cluster.APIToken, nil)
	if err != nil || r2.StatusCode != 200 {
		t.Fatalf("second spawn want 200, got %v: %s", statusOf(r2), b2)
	}
	if r2.Header.Get("X-Vh-Idempotent-Replay") != "1" {
		t.Fatal("second identical-key spawn must be an idempotent replay (through the tunnel)")
	}
	var s1, s2 struct {
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(b1, &s1)
	_ = json.Unmarshal(b2, &s2)
	if s1.SessionID != s2.SessionID {
		t.Fatalf("idempotent spawn should return the same id, got %q vs %q", s1.SessionID, s2.SessionID)
	}
}

// Regression: sequential requests on a keep-alive client must each route through
// the controller and return the correct response — never get smuggled straight
// down a pooled, still-hijacked tunnel connection (see the Connection: close fix
// in proxyToVH). Pre-fix this intermittently returned the worker SPA HTML.
func TestE2E_NoConnectionSmuggling(t *testing.T) {
	for i := 0; i < 8; i++ {
		resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 || !strings.HasPrefix(strings.TrimSpace(string(body)), "{") || !strings.Contains(string(body), `"epoch"`) {
			t.Fatalf("request %d smuggled/garbled: status=%d head=%.60s", i, resp.StatusCode, body)
		}
	}
}

// V4: the MCP facade drives the same stack (MCP → controller → tunnel → worker).
func TestE2E_MCPOverController(t *testing.T) {
	srv := mcp.New(cluster.ControllerURL, cluster.APIToken, cluster.WorkerID, "test")
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}}`,
	}, "\n") + "\n"
	var out strings.Builder
	if err := srv.Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	byID := map[float64]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			if id, ok := m["id"].(float64); ok {
				byID[id] = m
			}
		}
	}
	// list_sessions (id 2): result content includes the fixture session.
	if txt := toolText(t, byID[2]); !strings.Contains(txt, "demo") {
		t.Fatalf("MCP list_sessions should surface fixture sessions through the tunnel, got: %s", txt)
	}
	// send_message (id 3): not an error result.
	res3, _ := byID[3]["result"].(map[string]any)
	if res3 == nil || res3["isError"] == true {
		t.Fatalf("MCP send_message over the tunnel should succeed, got: %v", byID[3])
	}
}

// Pure-local: MCP in --local mode drives the worker's own /vh/* directly — no
// controller, no tunnel, no bearer. This is the common agent-on-the-worker case
// and is immune to the tunnel-proxy smuggling path.
func TestE2E_MCPLocalModeDirectToWorker(t *testing.T) {
	srv := mcp.New(cluster.WorkerVHURL, "", "", "test")
	srv.Local = true
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}}`,
	}, "\n") + "\n"
	var out strings.Builder
	if err := srv.Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	byID := map[float64]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			if id, ok := m["id"].(float64); ok {
				byID[id] = m
			}
		}
	}
	if txt := toolText(t, byID[2]); !strings.Contains(txt, "demo") {
		t.Fatalf("local MCP list_sessions should hit the worker /vh/snapshot, got: %s", txt)
	}
	res3, _ := byID[3]["result"].(map[string]any)
	if res3 == nil || res3["isError"] == true {
		t.Fatalf("local MCP send_message should succeed against the worker /vh/send, got: %v", byID[3])
	}
}

func toolText(t *testing.T, resp map[string]any) string {
	t.Helper()
	res, _ := resp["result"].(map[string]any)
	if res == nil {
		t.Fatalf("no result in %v", resp)
	}
	content, _ := res["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content in %v", res)
	}
	first, _ := content[0].(map[string]any)
	s, _ := first["text"].(string)
	return s
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}

func keys(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
