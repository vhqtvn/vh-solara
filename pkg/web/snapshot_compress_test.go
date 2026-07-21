package web

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// decodeGzip64 reverses maybeCompressSnapshot's envelope (base64 → gzip → raw
// JSON). Mirrors the client's decodeSnapshot (native DecompressionStream) path
// exactly, so a round-trip here proves the wire bytes the client receives.
func decodeGzip64(t *testing.T, b []byte) []byte {
	t.Helper()
	var env struct {
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("unmarshal gzip64 envelope: %v", err)
	}
	if env.Encoding != "gzip64" {
		t.Fatalf("envelope encoding want gzip64, got %q", env.Encoding)
	}
	raw, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatalf("base64 decode: %v", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	return out
}

// isGzip64Envelope reports whether b carries the {encoding:"gzip64",data:...}
// envelope produced by maybeCompressSnapshot (vs. a raw snapshot JSON object).
func isGzip64Envelope(b []byte) bool {
	return bytes.Contains(b, []byte(`"encoding":"gzip64"`))
}

// TestWantsCompress pins the z=1 query opt-in. Absent / z=0 / garbage must stay
// false so a client that did not opt in gets the legacy raw-JSON wire shape.
func TestWantsCompress(t *testing.T) {
	cases := map[string]bool{
		"":     false,
		"0":    false,
		"1":    true,
		"true": false, // only the literal "1" opts in
		"2":    false,
	}
	for q, want := range cases {
		r := mustReq("GET", "/vh/stream?sessions=a&z="+q, nil)
		if got := wantsCompress(r); got != want {
			t.Errorf("z=%q: want %v, got %v", q, want, got)
		}
	}
	// No z param at all → false (protects a stale client).
	r := mustReq("GET", "/vh/stream?sessions=a", nil)
	if wantsCompress(r) {
		t.Error("absent z param must NOT opt into compression")
	}
}

// TestWantsProject pins the proj=1 query opt-in (Phase 2 Gate A). Mirrors
// TestWantsCompress exactly: absent / proj=0 / garbage must stay false so an old
// client that does not opt in gets the legacy AUTHORITY_COMPLETE wire shape.
// Only the literal "1" opts in. Phase 2 does not wire the projection path yet;
// this test pins the capability-detection helper that Phase 4 consumes.
func TestWantsProject(t *testing.T) {
	cases := map[string]bool{
		"":     false,
		"0":    false,
		"1":    true,
		"true": false, // only the literal "1" opts in
		"2":    false,
	}
	for q, want := range cases {
		r := mustReq("GET", "/vh/stream?sessions=a&proj="+q, nil)
		if got := wantsProject(r); got != want {
			t.Errorf("proj=%q: want %v, got %v", q, want, got)
		}
	}
	// No proj param at all → false (protects a stale client).
	r := mustReq("GET", "/vh/stream?sessions=a", nil)
	if wantsProject(r) {
		t.Error("absent proj param must NOT opt into projected mode")
	}
	// proj=1 rides alongside z=1 on the same URL — both are independent opt-ins.
	r2 := mustReq("GET", "/vh/stream?sessions=a&z=1&proj=1", nil)
	if !wantsProject(r2) || !wantsCompress(r2) {
		t.Error("proj=1 and z=1 must be independently detectable on the same URL")
	}
}

// TestMaybeCompressSnapshot pins the helper's three-way decision: threshold,
// compress flag, and lossless round-trip.
func TestMaybeCompressSnapshot(t *testing.T) {
	t.Run("below threshold stays raw even when compress requested", func(t *testing.T) {
		small := bytes.Repeat([]byte("a"), snapshotCompressThreshold-1)
		out := maybeCompressSnapshot(small, true)
		if !bytes.Equal(out, small) {
			t.Fatalf("small payload must pass through raw, got %d bytes (envelope=%v)", len(out), isGzip64Envelope(out))
		}
	})
	t.Run("compress=false keeps large payload raw", func(t *testing.T) {
		large := []byte(`{"seq":1,"messages":{"a":[` + strings.Repeat(`{"info":{"id":"m","text":"`+strings.Repeat("x", 4000)+`"}},`, 1) + `]}}`)
		out := maybeCompressSnapshot(large, false)
		if !bytes.Equal(out, large) {
			t.Fatal("compress=false must return the payload unchanged")
		}
	})
	t.Run("large + compress=true → gzip64 envelope, lossless round-trip, smaller", func(t *testing.T) {
		// A highly compressible payload (mirrors a real transcript: repeated
		// JSON structure). gzip must shrink it well below the raw size.
		large := bytes.Repeat([]byte(`{"info":{"id":"m1","role":"user"},"parts":[{"type":"text","text":"hello world "}]},`), 200)
		out := maybeCompressSnapshot(large, true)
		if !isGzip64Envelope(out) {
			t.Fatalf("large compressed payload must be a gzip64 envelope, got: %s", string(out[:min(80, len(out))]))
		}
		decoded := decodeGzip64(t, out)
		if !bytes.Equal(decoded, large) {
			t.Fatal("gzip64 round-trip must be lossless")
		}
		if len(out) >= len(large) {
			t.Fatalf("compressed payload should be smaller: raw=%d out=%d", len(large), len(out))
		}
	})
}

// TestWarmSnapshotCompression is the end-to-end contract: a session whose
// messages are ALREADY loaded (warm) inlines the transcript into the snapshot —
// and with z=1 that snapshot ships gzip64-compressed on BOTH the SSE stream and
// the GET endpoint. Without z=1 the legacy raw shape is preserved bit-for-bit.
// This is the asymmetry fix: the cold path already compresses (messages.batch);
// now the warm path does too.
func TestWarmSnapshotCompression(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{`{"id":"a","title":"A","time":{"updated":1}}`}
	// A transcript large enough to exceed snapshotCompressThreshold so the
	// server actually compresses it (small transcripts pass through raw).
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

	// Warm the session: a GET triggers the synchronous ensureMessages, which
	// fetches + marks the session loaded. After this, a Stream-2 connection is
	// the WARM path (gate.messagesLoaded=true → snapshot inlines the transcript).
	warmResp, err := http.Get(web.URL + "/vh/snapshot?sessions=a")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, warmResp.Body)
	warmResp.Body.Close()
	waitFor(t, func() bool { return agg.Store().IsMessagesLoaded("a") }, "session a warm (messages loaded)")

	// --- GET path: z=1 → gzip64, no-z → raw ---
	t.Run("GET /vh/snapshot z=1 is gzip64 and decodes to the warm transcript", func(t *testing.T) {
		resp, err := http.Get(web.URL + "/vh/snapshot?sessions=a&z=1")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !isGzip64Envelope(body) {
			t.Fatalf("warm GET with z=1 must return a gzip64 envelope, got: %s", string(body[:min(80, len(body))]))
		}
		decoded := decodeGzip64(t, body)
		var snap struct {
			Messages map[string][]struct {
				Info struct {
					ID string `json:"id"`
				} `json:"info"`
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(decoded, &snap); err != nil {
			t.Fatal(err)
		}
		if len(snap.Messages["a"]) != 1 {
			t.Fatalf("decoded warm snapshot want 1 message for a, got %d", len(snap.Messages["a"]))
		}
		if len(snap.Messages["a"][0].Parts[0].Text) != 4*1024 {
			t.Fatalf("transcript text want %d bytes, got %d", 4*1024, len(snap.Messages["a"][0].Parts[0].Text))
		}
	})

	t.Run("GET /vh/snapshot without z=1 is raw JSON (legacy wire shape)", func(t *testing.T) {
		resp, err := http.Get(web.URL + "/vh/snapshot?sessions=a")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if isGzip64Envelope(body) {
			t.Fatal("warm GET without z=1 must NOT compress — legacy raw JSON contract")
		}
		// The raw snapshot still carries the inlined transcript.
		if !bytes.Contains(body, []byte(`"m1"`)) {
			t.Fatal("raw warm snapshot must contain the inlined message id")
		}
	})

	// --- Stream path: z=1 → gzip64 snapshot frame, no-z → raw snapshot frame ---
	t.Run("Stream /vh/stream z=1 first snapshot frame is gzip64", func(t *testing.T) {
		resp, err := http.Get(web.URL + "/vh/stream?sessions=a&z=1")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		reader := bufio.NewReader(resp.Body)
		ev, data := readSSEFrame(t, reader)
		if ev != "snapshot" {
			t.Fatalf("first frame want 'snapshot', got %q", ev)
		}
		if !isGzip64Envelope([]byte(data)) {
			t.Fatalf("warm stream snapshot with z=1 must be a gzip64 envelope, got: %s", data[:min(80, len(data))])
		}
		// Round-trip and confirm the transcript is present.
		decoded := decodeGzip64(t, []byte(data))
		if !bytes.Contains(decoded, []byte(`"m1"`)) {
			t.Fatal("decoded gzip64 stream snapshot must contain the inlined message")
		}
	})

	t.Run("Stream /vh/stream without z=1 first snapshot frame is raw JSON", func(t *testing.T) {
		resp, err := http.Get(web.URL + "/vh/stream?sessions=a")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		reader := bufio.NewReader(resp.Body)
		ev, data := readSSEFrame(t, reader)
		if ev != "snapshot" {
			t.Fatalf("first frame want 'snapshot', got %q", ev)
		}
		if isGzip64Envelope([]byte(data)) {
			t.Fatal("warm stream snapshot without z=1 must NOT compress — legacy raw JSON contract")
		}
		if !bytes.Contains([]byte(data), []byte(`"m1"`)) {
			t.Fatal("raw warm stream snapshot must contain the inlined message")
		}
	})
}

// mustReq builds an *http.Request without failing the test on malformed input
// (test fixtures are static). Used by the wantsCompress table test.
func mustReq(method, url string, body io.Reader) *http.Request {
	r, err := http.NewRequest(method, url, body)
	if err != nil {
		panic(err)
	}
	return r
}
