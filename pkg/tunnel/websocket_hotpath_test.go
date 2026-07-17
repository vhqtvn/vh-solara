package tunnel

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// This file proves the F3 invariant: the tunnel WebSocket Write hot path does
// NOT acquire yamux's streamLock. The previous design called
// yamux.Session.NumStreams() on EVERY wsRWC.Write (to populate the
// active_streams_at_write histogram), and NumStreams() takes the session
// streamLock (yamux@v0.1.2/session.go). The operator required the hot write
// path to stay lock-free. The fix samples the lock-free global gauge
// (diag.Default.Yamux.ActiveStreams, an atomic.Int64) per write and defers the
// only per-session NumStreams() read to threshold-gated (≥100ms) slow-write
// incidents.
//
// The test below substitutes a counting streamSampler for the real yamux
// session and asserts NumStreams() is invoked ZERO times across many fast
// writes — the structural proof that the hot path no longer touches the lock.

// countingSampler is a streamSampler that counts NumStreams() invocations. If
// the hot Write path ever calls NumStreams(), calls goes non-zero and the test
// fails. want is the value NumStreams() reports when it IS called (used only by
// the slow-path correlation case to distinguish "sampler value" from "gauge
// value").
type countingSampler struct {
	calls atomic.Int64
	want  int64
}

func (c *countingSampler) NumStreams() int {
	c.calls.Add(1)
	return int(c.want)
}

// wsDrainServer is a real gorilla websocket server that reads (drains) every
// frame the client sends as fast as it arrives, so the client's WriteMessage
// returns promptly and the write path stays in the fast regime (well under
// diag.SlowWSWriteNs). It also serves the diagnostics JSON snapshot at /diag.
func wsDrainServer(t *testing.T, diagHandler http.Handler) (*httptest.Server, *websocket.Conn) {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("/diag", diagHandler)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			if _, _, err := c.NextReader(); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)

	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	u.Path = "/ws"
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		srv.Close()
		t.Fatalf("dial: %v", err)
	}
	return srv, c
}

// wsSnap mirrors the subset of the diagnostics snapshot JSON we assert on. The
// full snapshot type lives in package diagnostics and is unexported, so we
// re-declare only the fields we read by JSON tag.
type wsSnap struct {
	Probes struct {
		WSWrite []struct {
			Side                 string `json:"side"`
			ActiveStreamsAtWrite struct {
				Count int64 `json:"count"`
				Min   int64 `json:"min_ns"`
				Max   int64 `json:"max_ns"`
				Sum   int64 `json:"sum_ns"`
			} `json:"active_streams_at_write"`
		} `json:"ws_write"`
	} `json:"probes"`
}

func wsSnapshot(t *testing.T, base string) wsSnap {
	t.Helper()
	res, err := http.Get(base + "/diag")
	if err != nil {
		t.Fatalf("diag GET: %v", err)
	}
	defer res.Body.Close()
	var snap wsSnap
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("diag read: %v", err)
	}
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("diag unmarshal: %v", err)
	}
	return snap
}

// TestWSRWCWriteHotPathSkipsNumStreams is the F3 structural proof.
//
// FAIL-without (the bug): the old Write path called s.NumStreams() on every
// Write to populate ActiveStreamsAtWrite, so countingSampler.calls would be N
// (one per write) and the observed histogram values would equal the sampler's
// `want`, not the global gauge.
//
// PASS-with (the fix): the hot path reads only the lock-free global gauge, so
// countingSampler.calls stays 0 AND the histogram records exactly N
// observations sourced from the gauge value (proving the gauge — not
// NumStreams() — was sampled).
func TestWSRWCWriteHotPathSkipsNumStreams(t *testing.T) {
	diag.ResetForTest()
	const (
		n     = 50
		gauge = int64(11) // distinct from sampler.want to tell them apart
	)
	diag.Default.Yamux.ActiveStreams.Store(gauge)

	// sampler.want is deliberately != gauge: if the hot path were still using
	// NumStreams(), the observed histogram min would be 42, not 11.
	sampler := &countingSampler{want: 42}

	srv, conn := wsDrainServer(t, diag.Handler())
	defer srv.Close()
	defer conn.Close()

	w := newWSRWC(conn, diag.SideClient)
	w.setSession(sampler) // would be sampled per-write under the old bug

	payload := []byte("vhsolara-hotpath-probe")
	for i := 0; i < n; i++ {
		if _, err := w.Write(payload); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	// (1) The structural invariant: NumStreams() was never invoked on the hot
	// path. Under the old code this would be n (one per Write).
	if got := sampler.calls.Load(); got != 0 {
		t.Fatalf("hot path called NumStreams() %d times across %d fast writes — "+
			"the tunnel write path must not acquire yamux's streamLock", got, n)
	}

	// (2) The histogram still captured per-write samples, but sourced from the
	// lock-free global gauge (gauge), NOT the sampler (want). count==n proves
	// exactly one observation per write; min==gauge proves the gauge (not
	// NumStreams()) fed those observations.
	snap := wsSnapshot(t, srv.URL)
	var ws *struct {
		Side                 string `json:"side"`
		ActiveStreamsAtWrite struct {
			Count int64 `json:"count"`
			Min   int64 `json:"min_ns"`
			Max   int64 `json:"max_ns"`
			Sum   int64 `json:"sum_ns"`
		} `json:"active_streams_at_write"`
	}
	for i := range snap.Probes.WSWrite {
		if snap.Probes.WSWrite[i].Side == "worker_client" {
			ws = &snap.Probes.WSWrite[i]
			break
		}
	}
	if ws == nil {
		t.Fatalf("no worker_client ws_write entry in snapshot")
	}
	if ws.ActiveStreamsAtWrite.Count != n {
		t.Fatalf("ActiveStreamsAtWrite.Count = %d, want %d (one observation per write)",
			ws.ActiveStreamsAtWrite.Count, n)
	}
	if ws.ActiveStreamsAtWrite.Min != gauge {
		t.Fatalf("ActiveStreamsAtWrite.Min = %d, want %d (the global gauge value, "+
			"NOT the sampler's NumStreams()=%d — proves the hot path sampled the lock-free gauge)",
			ws.ActiveStreamsAtWrite.Min, gauge, sampler.want)
	}

	// (3) No slow incidents on the fast path (all writes drained immediately).
	if inc := diag.Default.WSWrite[diag.SideClient].SlowWriteIncidents.Snapshot(); len(inc) != 0 {
		t.Fatalf("expected 0 slow incidents on the hot path, got %d", len(inc))
	}
}
