package e2e

import (
	"net/http"
	"testing"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// TestE2E_DiagYamuxResponseDirectionInstrumented is the Finding 1 production-
// wiring proving test. It drives real response bytes through the agent's
// raw-proxy copy path (controller proxy → tunnel → agent handleRawProxy →
// worker web → response back) and asserts the RESPONSE-direction yamux write
// histogram increments — the direction that was previously UNINSTRUMENTED and
// is where yamux flow-control / send-window backpressure actually accumulates.
//
// Because the e2e harness runs the controller and agent in-process, both
// YamuxWriteMonitor instances (Request on the controller side, Response on the
// agent side) write into the same process-global diag.Default registry. So a
// single tunneled request increments BOTH directions independently:
//
//   - WriteByDir[Request].Bytes  — controller browser→yamux (proxy.go yamuxW)
//   - WriteByDir[Response].Bytes — agent local-service→yamux (daemon.go respW)
//
// FAIL-without (pre-fix): WriteByDir[Response].Bytes stays at its baseline
// because the agent's local-service→yamux write leg was never wrapped with a
// monitor — the old code only instrumented the controller direction, missing
// the flow-control-blocking egress path entirely.
// PASS-with (fixed): both directions increment.
func TestE2E_DiagYamuxResponseDirectionInstrumented(t *testing.T) {
	// Snapshot baselines BEFORE the request (the shared cluster may have
	// already served other tests, so we check the DELTA, not absolute values).
	respBefore := diag.Default.Yamux.WriteByDir[diag.YamuxWriteResponse].Bytes.Load()
	reqBefore := diag.Default.Yamux.WriteByDir[diag.YamuxWriteRequest].Bytes.Load()

	// Drive a real request through the tunnel. This exercises the full proxy
	// path: controller handleRawProxy (YamuxWriteRequest wrapper) → yamux
	// stream → agent handleRawProxy → local web server → response copied back
	// through the agent's YamuxWriteResponse wrapper.
	resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
	if err != nil {
		t.Fatalf("tunneled GET /sessions: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("tunneled GET /sessions: want 200, got %d (body=%q)", resp.StatusCode, body)
	}

	respAfter := diag.Default.Yamux.WriteByDir[diag.YamuxWriteResponse].Bytes.Load()
	reqAfter := diag.Default.Yamux.WriteByDir[diag.YamuxWriteRequest].Bytes.Load()

	// Response direction MUST have incremented — the agent's local-service→
	// yamux write leg is now wrapped. This is the core Finding 1 assertion.
	if respAfter <= respBefore {
		t.Fatalf("WriteByDir[Response].Bytes did not increase: before=%d after=%d — agent response-direction write is NOT instrumented",
			respBefore, respAfter)
	}

	// Request direction MUST also have incremented — the controller's
	// browser→yamux write leg is wrapped (this was already instrumented before
	// the fix; the assertion confirms both directions are independently
	// tracked, not collapsed into one counter).
	if reqAfter <= reqBefore {
		t.Fatalf("WriteByDir[Request].Bytes did not increase: before=%d after=%d — controller request-direction write is NOT instrumented",
			reqBefore, reqAfter)
	}

	// The response carries a non-trivial body (a JSON snapshot), so the
	// response-direction byte count should be materially larger than zero new
	// bytes — at least the body length.
	newRespBytes := respAfter - respBefore
	if newRespBytes < uint64(len(body)) {
		t.Fatalf("WriteByDir[Response] new bytes (%d) < response body length (%d) — response leg may be undercounting",
			newRespBytes, len(body))
	}
}
