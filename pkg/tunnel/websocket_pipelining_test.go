package tunnel

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
)

// F1 pipelining wire-compatibility proofs (remote-latency brief, 2026-10-12).
//
// The controller now writes the RawProxyMessage header frame PADDED to exactly
// RawProxyHeaderFrameLen, immediately followed by the full HTTP request bytes,
// WITHOUT waiting for the worker's ack. These tests prove the one-sided-safety
// invariant against the DEPLOYED worker read path (v1.77.1 pkg/agent/daemon.go
// handleStream): a bare json.NewDecoder(stream).Decode followed by raw reads.
//
// The hazard: json.Decoder's first Read fills at most its initial 512-byte
// buffer, and everything it slurps past the JSON value is stranded in the
// decoder's private buffer — dropped when the decoder is discarded. Without
// padding, pipelined request bytes that coalesce with the header inside the
// worker's recvBuf (yamux Read returns everything buffered, spanning frames)
// would be silently swallowed: a race-dependent truncated request head. The
// 512-byte padded header makes the decoder's first-Read window [0,512) unable
// to reach the request bytes at offset 512 — timing-INDEPENDENTLY.

// fakeHTTPRequest is a stand-in for the exact bytes handleRawProxy writes
// after the header frame (the manual request-head serialization).
var fakeHTTPRequest = []byte("POST /vh/queue HTTP/1.1\r\nHost: bason.vc.libvh.dev\r\nContent-Type: application/json\r\n\r\n{\"dir\":\"/x\",\"text\":\"hello\"}")

// oldWorkerReadPath replicates pkg/agent/daemon.go handleStream's header read
// VERBATIM (the deployed v1.77.1 code): a one-shot json.Decoder over the raw
// stream, decoder discarded on return, then the copy loop reading from the
// raw stream. Returns the decoded header and the bytes the "copy loop" sees.
func oldWorkerReadPath(r io.Reader) (BaseMessage, []byte, error) {
	var base BaseMessage
	dec := json.NewDecoder(r)
	if err := dec.Decode(&base); err != nil {
		return base, nil, err
	}
	rest, err := io.ReadAll(r)
	return base, rest, err
}

// pipelinedWrites writes exactly what the new controller writes onto one
// fresh stream: the padded header frame, then the request bytes (optionally
// fragmented), then a stream close so the worker's ReadAll can terminate.
func pipelinedWrites(t *testing.T, controller *Stream, request []byte, fragments int, interWriteDelay time.Duration) {
	t.Helper()
	rawReq := RawProxyMessage{
		BaseMessage: BaseMessage{Type: TypeRawProxy},
		Port:        0,
	}
	if err := controller.WriteJSONPadded(rawReq, RawProxyHeaderFrameLen); err != nil {
		t.Fatalf("WriteJSONPadded: %v", err)
	}
	if fragments <= 1 {
		if _, err := controller.Raw().Write(request); err != nil {
			t.Fatalf("write request: %v", err)
		}
	} else {
		chunk := (len(request) + fragments - 1) / fragments
		for off := 0; off < len(request); off += chunk {
			end := off + chunk
			if end > len(request) {
				end = len(request)
			}
			if _, err := controller.Raw().Write(request[off:end]); err != nil {
				t.Fatalf("write request fragment: %v", err)
			}
			time.Sleep(interWriteDelay)
		}
	}
	// Close only the stream's write side (yamux FIN) — the worker's
	// io.ReadAll then drains the remaining bytes and returns EOF, exactly as
	// its copy loop would on controller-side close.
	if err := controller.Close(); err != nil {
		t.Fatalf("close controller stream: %v", err)
	}
}

// TestOldWorkerReadPathNeverSwallowsPipelinedRequest is the one-sided-safety
// crux: over a REAL yamux session, for every delivery timing we can provoke
// (reader blocked before any write; everything written before the reader
// starts; request fragmented with delays), the old worker's exact read path
// decodes the header and hands the copy loop the request bytes INTACT.
//
// FAIL-without-padding: an unpadded header lets the decoder's first Read
// reach request bytes whenever they coalesce in recvBuf — the race this test
// loops hard enough to provoke (50 rounds × interleaved timings). Also fails
// if a future Go toolchain grows json.Decoder's initial buffer past
// RawProxyHeaderFrameLen — the constant must then grow with it (see
// websocket.go → RawProxyHeaderFrameLen).
func TestOldWorkerReadPathNeverSwallowsPipelinedRequest(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	sessC, err := yamux.Client(c1, nil)
	if err != nil {
		t.Fatalf("yamux client: %v", err)
	}
	defer sessC.Close()
	sessS, err := yamux.Server(c2, nil)
	if err != nil {
		t.Fatalf("yamux server: %v", err)
	}
	defer sessS.Close()

	timings := []struct {
		name            string
		readerFirst     bool
		fragments       int
		interWriteDelay time.Duration
	}{
		{"coalesced: all bytes written before the worker reads", false, 1, 0},
		{"reader blocked before any bytes arrive", true, 1, 0},
		{"request fragmented into 8 writes, 1ms apart", false, 8, time.Millisecond},
		{"reader-first + fragmented request", true, 12, 500 * time.Microsecond},
	}

	for round := 0; round < 50; round++ {
		for _, tc := range timings {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				ts, err := sessC.OpenStream()
				if err != nil {
					t.Fatalf("open stream: %v", err)
				}
				controller := &Stream{stream: ts}

				type result struct {
					base BaseMessage
					rest []byte
					err  error
				}
				resCh := make(chan result, 1)
				startWorker := func() {
					go func() {
						ws, err := sessS.AcceptStream()
						if err != nil {
							resCh <- result{err: err}
							return
						}
						base, rest, err := oldWorkerReadPath(ws)
						resCh <- result{base: base, rest: rest, err: err}
					}()
				}

				if tc.readerFirst {
					startWorker()
					time.Sleep(2 * time.Millisecond) // let the decoder block in Read
				}
				pipelinedWrites(t, controller, fakeHTTPRequest, tc.fragments, tc.interWriteDelay)
				if !tc.readerFirst {
					startWorker()
				}

				select {
				case res := <-resCh:
					if res.err != nil {
						t.Fatalf("old worker read path: %v", res.err)
					}
					if res.base.Type != TypeRawProxy {
						t.Fatalf("decoded header type = %q, want %q", res.base.Type, TypeRawProxy)
					}
					if !bytes.Equal(res.rest, fakeHTTPRequest) {
						t.Fatalf("copy-loop bytes corrupted (%d want %d):\n got: %q\nwant: %q",
							len(res.rest), len(fakeHTTPRequest), clip(res.rest), clip(fakeHTTPRequest))
					}
				case <-time.After(10 * time.Second):
					t.Fatal("timed out waiting for worker read path")
				}
			})
		}
	}
}

// clip keeps failure output readable.
func clip(b []byte) string {
	const n = 120
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// TestWriteJSONPaddedFrameShape pins the wire shape itself: the frame the
// controller emits is EXACTLY RawProxyHeaderFrameLen bytes — a complete JSON
// line (value + '\n') followed by pure space padding — so the request bytes
// always start at stream offset RawProxyHeaderFrameLen.
func TestWriteJSONPaddedFrameShape(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	sessC, _ := yamux.Client(c1, nil)
	defer sessC.Close()
	sessS, _ := yamux.Server(c2, nil)
	defer sessS.Close()

	controller, err := sessC.OpenStream()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cs := &Stream{stream: controller}
	ws, err := sessS.AcceptStream()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	rawReq := RawProxyMessage{BaseMessage: BaseMessage{Type: TypeRawProxy}, Port: 0}
	if err := cs.WriteJSONPadded(rawReq, RawProxyHeaderFrameLen); err != nil {
		t.Fatalf("WriteJSONPadded: %v", err)
	}
	if _, err := cs.Raw().Write(fakeHTTPRequest); err != nil {
		t.Fatalf("write request: %v", err)
	}
	cs.Close()

	frame := make([]byte, RawProxyHeaderFrameLen)
	if _, err := io.ReadFull(ws, frame); err != nil {
		t.Fatalf("read padded frame: %v", err)
	}
	nl := bytes.IndexByte(frame, '\n')
	if nl < 0 {
		t.Fatal("no newline delimiter in padded frame")
	}
	var got RawProxyMessage
	if err := json.Unmarshal(frame[:nl], &got); err != nil {
		t.Fatalf("padded frame JSON prefix does not decode: %v", err)
	}
	if got.Type != TypeRawProxy {
		t.Fatalf("decoded type = %q, want %q", got.Type, TypeRawProxy)
	}
	for i, b := range frame[nl+1:] {
		if b != ' ' {
			t.Fatalf("padding byte at offset %d is %q, want space", nl+1+i, b)
		}
	}
	rest, err := io.ReadAll(ws)
	if err != nil {
		t.Fatalf("read request bytes: %v", err)
	}
	if !bytes.Equal(rest, fakeHTTPRequest) {
		t.Fatalf("request bytes after padded frame corrupted: %q", clip(rest))
	}
}

// TestNaiveUnpaddedPipeliningSwallowsRequestBytes documents the hazard the
// padding exists to neutralize — the deterministic (fully-coalesced) case:
// with an UNPADDED header, a bare json.Decoder over the combined bytes swallows
// the request head into its private buffer, and the "copy loop" reading the
// source afterward sees a TRUNCATED request. On a real tunnel this outcome is
// timing-dependent (a race); here every byte is pre-buffered so it is
// guaranteed. This is the FAIL-without case for the padding invariant.
func TestNaiveUnpaddedPipeliningSwallowsRequestBytes(t *testing.T) {
	header, err := json.Marshal(RawProxyMessage{BaseMessage: BaseMessage{Type: TypeRawProxy}, Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	combined := append(append(append([]byte{}, header...), '\n'), fakeHTTPRequest...)
	src := bytes.NewBuffer(combined)

	base, rest, err := oldWorkerReadPath(src)
	if err != nil {
		t.Fatalf("old worker read path: %v", err)
	}
	if base.Type != TypeRawProxy {
		t.Fatalf("type = %q", base.Type)
	}
	if bytes.Equal(rest, fakeHTTPRequest) {
		t.Fatal("expected the fully-coalesced unpadded case to demonstrate the swallow hazard (request bytes intact) — if json.Decoder semantics changed, re-audit RawProxyHeaderFrameLen")
	}
	// The copy loop must see a TRUNCATED head: the swallowed prefix is gone.
	if len(rest) >= len(fakeHTTPRequest) {
		t.Fatalf("expected truncated copy-loop bytes, got %d (full %d)", len(rest), len(fakeHTTPRequest))
	}
}
