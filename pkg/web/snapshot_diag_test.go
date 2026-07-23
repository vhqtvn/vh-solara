package web

// Phase 3 proving tests for the snapshot diagnostics honesty fixes:
//   C — the reconnect-snapshot branch was MISSING RecordSnapshotPath entirely
//       (unlike the initial/promotion sites), so reconnect snapshot volume was
//       invisible to snapshot_path/snapshot_bytes. After the fix, a projected
//       stream with a valid cursor (replay succeeds → reconnect snapshot fires)
//       MUST increment SnapshotPath.
//   D — RecordSnapshotPath recorded len(marshaled) (pre-compression), despite
//       the "wire bytes" comment. With z=1 the on-wire payload is gzip64-
//       compressed ~3.4x smaller; the recorded SnapshotBytes must reflect the
//       COMPRESSED wire length, not the pre-compression marshaled length.

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// openDiagStreamReq opens a /vh/stream with arbitrary query params, bound to a
// deadline-bounded context. Returns the body reader.
func openDiagStreamReq(t *testing.T, webURL, query string, deadline time.Duration) *bufio.Reader {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, webURL+"/vh/stream?"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewReader(resp.Body)
}

// readUntilSnapshot reads SSE frames until a "snapshot" frame arrives, returning
// its data payload. Fails if the stream closes or too many non-snapshot frames
// pass without a snapshot.
func readUntilSnapshot(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	for i := 0; i < 30; i++ {
		ev, data := readSSEFrameSilent(r)
		if ev == "snapshot" {
			return data
		}
		if ev == "" {
			t.Fatal("stream closed before a snapshot frame arrived")
		}
	}
	t.Fatal("read 30 frames without finding a snapshot")
	return ""
}

// TestSnapshotDiag_BytesReflectWire proves Phase 3-D: with z=1 compression
// opted in, SnapshotBytes must reflect the COMPRESSED (wire) payload length, not
// the pre-compression marshaled length. A warm session with a large transcript
// produces a snapshot that compresses ~3.4x; recording len(marshaled) would
// overstate the diag by that factor.
//
// FAIL-without (RecordSnapshotPath(len(b))): delta == len(rawMarshal).
// PASS-with (RecordSnapshotPath(len(wire))): delta == len(wire) < len(rawMarshal).
func TestSnapshotDiag_BytesReflectWire(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// A transcript large enough to exceed snapshotCompressThreshold.
	fake.messages["a"] = `[{"info":{"id":"m1","sessionID":"a","role":"user"},"parts":[{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"` + strings.Repeat("warm", 1024) + `"}]}]`

	ocSrv := httptest.NewServer(fake.handler())
	defer ocSrv.Close()

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().Snapshot(map[string]bool{"a": true}).Sessions) == 1 }, "hydrate session a")

	srv, _ := NewServer(agg, ocSrv.URL, 1000)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Warm the session so the snapshot inlines the transcript (triggers compression).
	warmResp, err := http.Get(web.URL + "/vh/snapshot?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, warmResp.Body)
	warmResp.Body.Close()
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a warm (messages loaded)")

	// Compute the RAW (pre-compression) marshaled length for comparison.
	rawSnap := agg.Store().Snapshot(map[string]bool{"a": true})
	rawMarshal, err := json.Marshal(rawSnap)
	if err != nil {
		t.Fatal(err)
	}

	// Open the stream with z=1 so the snapshot ships gzip64-compressed.
	before := diagnostics.Default.Stream[diagnostics.StreamClassSelected].SnapshotBytes.Load()
	reader := openDiagStreamReq(t, web.URL, "sessions=a&z=1", 1*time.Second)
	data := readUntilSnapshot(t, reader)
	after := diagnostics.Default.Stream[diagnostics.StreamClassSelected].SnapshotBytes.Load()

	delta := after - before
	wireLen := uint64(len(data))

	// The recorded SnapshotBytes delta must equal the on-wire payload length
	// (the SSE data field IS the maybeCompressSnapshot output).
	if delta != wireLen {
		t.Fatalf("SnapshotBytes delta %d != wire payload length %d (Phase 3-D: should record true wire bytes)", delta, wireLen)
	}
	// The wire payload must be compressed (smaller than the raw marshaled snapshot).
	if delta >= uint64(len(rawMarshal)) {
		t.Fatalf("SnapshotBytes delta %d >= raw marshaled length %d — Phase 3-D bug: recording pre-compression bytes, not wire bytes", delta, len(rawMarshal))
	}
	// Sanity: the on-wire payload must be a gzip64 envelope (compression actually shipped).
	if !isGzip64Envelope([]byte(data)) {
		t.Fatalf("on-wire snapshot must be a gzip64 envelope with z=1, got: %s", data[:min(80, len(data))])
	}
}
