package server

import (
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// F1 decoder-buffer bridge unit tests (remote-latency brief, 2026-10-12).
//
// With the request write pipelined ahead of the ack read, the worker's ack
// frame and the head of the HTTP response can coalesce in the yamux stream
// (the worker's copy goroutine starts pumping the local service the instant
// it sends the ack). decodeAckWithResidue bridges json.Decoder.Buffered() so
// the response head is not stranded in the decoder's private buffer.

// chunkReader delivers at most chunk bytes per Read, simulating fragmented
// stream delivery (separate yamux frames arriving one at a time).
type chunkReader struct {
	r     *bytes.Reader
	chunk int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(p) > c.chunk {
		p = p[:c.chunk]
	}
	return c.r.Read(p)
}

var responseHead = []byte("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: hello\n\n")

// runAckScenario drives decodeAckWithResidue over src, then reads everything
// remaining from src through the residue bridge (the exact composition the
// copy phase uses: io.MultiReader(residue, stream)), and returns the ack plus
// the concatenated post-ack bytes.
func runAckScenario(src io.Reader) (tunnel.BaseMessage, []byte, error) {
	ack, residue, err := decodeAckWithResidue(src)
	if err != nil {
		return ack, nil, err
	}
	// The production composition: residue drained BEFORE the raw stream. The
	// source is still readable — bytes the decoder did not consume remain in
	// it (a bytes.Buffer shares that property with the yamux stream).
	bridged, err := io.ReadAll(io.MultiReader(residue, src))
	return ack, bridged, err
}

func TestDecodeAckWithResidue_AckPlusResponseCoalesced(t *testing.T) {
	// Worst case: the ack frame AND the response head were buffered in the
	// same Read window (coalesced in the worker's recvBuf).
	ackLine := []byte("{\"type\":\"raw_proxy\"}\n")
	wire := append(append([]byte{}, ackLine...), responseHead...)

	ack, bridged, err := runAckScenario(bytes.NewReader(wire))
	if err != nil {
		t.Fatalf("decodeAckWithResidue: %v", err)
	}
	if ack.Type != tunnel.TypeRawProxy {
		t.Fatalf("ack type = %q, want %q", ack.Type, tunnel.TypeRawProxy)
	}
	// The bridge must deliver the response head EXACTLY once, fully, in order
	// — neither swallowed by the decoder nor duplicated.
	if !bytes.Equal(bridged, responseHead) {
		t.Fatalf("bridged response corrupted:\n got: %q\nwant: %q", bridged, responseHead)
	}
}

func TestDecodeAckWithResidue_FragmentedAckDelivery(t *testing.T) {
	// The ack itself arrives fragmented (byte-at-a-time reads — the decoder
	// refills across multiple Reads) with the response trailing.
	ackLine := []byte("{\"type\":\"raw_proxy\"}\n")
	wire := append(append([]byte{}, ackLine...), responseHead...)
	src := &chunkReader{r: bytes.NewReader(wire), chunk: 1}

	ack, bridged, err := runAckScenario(src)
	if err != nil {
		t.Fatalf("decodeAckWithResidue: %v", err)
	}
	if ack.Type != tunnel.TypeRawProxy {
		t.Fatalf("ack type = %q", ack.Type)
	}
	if !bytes.Equal(bridged, responseHead) {
		t.Fatalf("bridged response corrupted after fragmented ack:\n got: %q\nwant: %q", bridged, responseHead)
	}
}

func TestDecodeAckWithResidue_NothingAfterAck(t *testing.T) {
	// Response delayed (worker acked, local service not answering yet): no
	// residue, empty bridge, no spurious bytes.
	ack, bridged, err := runAckScenario(strings.NewReader("{\"type\":\"raw_proxy\"}\n"))
	if err != nil {
		t.Fatalf("decodeAckWithResidue: %v", err)
	}
	if ack.Type != tunnel.TypeRawProxy {
		t.Fatalf("ack type = %q", ack.Type)
	}
	if len(bridged) != 0 {
		t.Fatalf("expected empty bridge, got %q", bridged)
	}
}

func TestDecodeAckWithResidue_TypeErrorAck(t *testing.T) {
	// Worker dial failure: TypeError JSON frame; error path must surface the
	// type so handleRawProxy can 502 (unchanged semantics).
	ack, bridged, err := runAckScenario(strings.NewReader("{\"type\":\"error\"}\n"))
	if err != nil {
		t.Fatalf("decodeAckWithResidue: %v", err)
	}
	if ack.Type != tunnel.TypeError {
		t.Fatalf("ack type = %q, want %q", ack.Type, tunnel.TypeError)
	}
	if len(bridged) != 0 {
		t.Fatalf("expected empty bridge, got %q", bridged)
	}
}

func TestDecodeAckWithResidue_GarbageIsError(t *testing.T) {
	if _, _, err := runAckScenario(strings.NewReader("not json at all")); err == nil {
		t.Fatal("expected decode error for garbage ack frame")
	}
	if _, _, err := runAckScenario(strings.NewReader("")); err == nil {
		t.Fatal("expected decode error for empty stream (worker died before acking)")
	}
}

func TestDecodeAckWithResidue_AckFollowedByPartialResponseInSameWindow(t *testing.T) {
	// The decoder's single Read window covers the ack PLUS a large chunk of
	// the response (a big SSE snapshot burst): the bridge must reconstruct the
	// FULL ordered response regardless of how much the decoder swallowed.
	ackLine := []byte("{\"type\":\"raw_proxy\"}\n")
	bigResponse := bytes.Repeat(responseHead, 64) // ~8.5KB — decoder swallows ≤512
	wire := append(append([]byte{}, ackLine...), bigResponse...)

	ack, bridged, err := runAckScenario(bytes.NewReader(wire))
	if err != nil {
		t.Fatalf("decodeAckWithResidue: %v", err)
	}
	if ack.Type != tunnel.TypeRawProxy {
		t.Fatalf("ack type = %q", ack.Type)
	}
	if !bytes.Equal(bridged, bigResponse) {
		t.Fatalf("bridged response corrupted (got %d bytes, want %d)", len(bridged), len(bigResponse))
	}
}
