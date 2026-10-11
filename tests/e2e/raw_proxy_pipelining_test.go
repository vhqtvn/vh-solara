package e2e

// raw_proxy_pipelining_test.go — F1 CRUX (remote-latency brief 2026-10-12):
// the controller now writes the padded RawProxy header frame
// (tunnel.RawProxyHeaderFrameLen) plus the FULL HTTP request bytes BEFORE
// reading the worker's ack (pkg/server/proxy.go handleRawProxy). The agent
// daemon in this cluster is byte-for-byte the deployed worker read path
// (pkg/agent/daemon.go handleStream: one-shot json.Decoder header read +
// raw-stream copy loop), so a green run here is the end-to-end one-sided
// wire-compatibility proof: NEW controller + OLD-shape worker.
//
// Covered request shapes through the REAL yamux tunnel:
//  1. GET with query params (response head must survive the ack decode —
//     the decodeAckWithResidue bridge);
//  2. POST with a body large enough to span multiple yamux data frames
//     behind the padded header frame;
//  3. SSE streaming response (long-lived chunked relay through both copy
//     loops, including the pipelined ack/response-head coalescing window).
import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestE2E_PipelinedRawProxyGET verifies a plain GET (with query params) still
// returns its exact body and headers through the pipelined handshake — the
// response head follows the worker's ack closely enough to coalesce in the
// controller's decoder window, so this fails if the residue bridge regresses.
func TestE2E_PipelinedRawProxyGET(t *testing.T) {
	resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions?z=1"), "", cluster.APIToken, nil)
	if err != nil {
		t.Fatalf("tunneled GET: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("tunneled GET: want 200, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Vh-Epoch") == "" {
		t.Fatal("response head corrupted — X-VH-Epoch missing (ack-decode residue bridge regression?)")
	}
	if !json.Valid(body) {
		t.Fatalf("response body not valid JSON (%d bytes): %.120q", len(body), body)
	}
}

// TestE2E_PipelinedRawProxyPostLargeBody drives a POST whose body spans
// multiple yamux data frames behind the padded header. The worker must
// receive the request head AND every body byte intact — the send handler
// JSON-decodes the body and validates the session, so a swallowed/truncated
// head or body fails the request outright.
func TestE2E_PipelinedRawProxyPostLargeBody(t *testing.T) {
	// Fresh session (self-contained state, mirroring SpawnSendAbort's shape).
	resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions"), `{"title":"f1-pipelining"}`, cluster.APIToken, nil)
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
	defer func() {
		_, _, _ = cluster.Do(http.MethodDelete, wpath("/sessions/"+sp.SessionID), "", cluster.APIToken, nil)
	}()

	// ~24KB prompt body: far beyond the 512-byte padded header frame and the
	// worker decoder's read window, exercising a large body relayed behind
	// the pipelined handshake (whether it spans multiple yamux data frames
	// depends on the fresh stream's send window — not asserted here).
	bigText := strings.Repeat("pipelined-request-body-intact ", 850) // ~24.6KB
	sendBody, _ := json.Marshal(map[string]string{"sessionID": sp.SessionID, "text": bigText})
	resp, body, err = cluster.Do(http.MethodPost, wpath(fmt.Sprintf("/sessions/%s/message", sp.SessionID)), string(sendBody), cluster.APIToken, nil)
	if err != nil {
		t.Fatalf("tunneled POST with large body: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("tunneled POST with large body: want 200, got %d: %.200q", resp.StatusCode, body)
	}
}

// TestE2E_PipelinedRawProxySSEStream opens the worker's SSE stream through
// the raw proxy and reads live frames: the request head (pipelined), the ack,
// the response head, and the long-lived chunked body all relay through both
// copy loops. A truncated/interleaved handshake kills the stream before the
// first frame.
func TestE2E_PipelinedRawProxySSEStream(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cluster.ControllerURL+wpath("/events"), nil)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+cluster.APIToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream connect: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("stream connect: want 200, got %d: %.200q", resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("stream Content-Type: %q", ct)
	}

	// Read frames until we see a snapshot-ish event (the stream opens with
	// hello + snapshot frames). Bounded by ctx; no sleeps.
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	got := map[string]int{}
	deadline := time.Now().Add(15 * time.Second)
	for sc.Scan() && time.Now().Before(deadline) {
		line := sc.Text()
		for _, ev := range []string{"event: hello", "event: snapshot", "data: {"} {
			if strings.Contains(line, ev) {
				got[strings.TrimSpace(ev)]++
			}
		}
		if got["event: snapshot"] > 0 || (got["event: hello"] > 0 && got["data: {"] > 0) {
			return // frame relay proven
		}
	}
	t.Fatalf("no SSE frames relayed through the pipelined proxy within deadline (got=%v)", got)
}
