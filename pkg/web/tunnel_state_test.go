package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// Slice B (send-net-resilience) — X-VH-Tunnel-State stamping contract:
//   - UNWIRED provider (local-server, fixture server, tests): the header is
//     ABSENT on /vh/* responses. Absence is meaningful: the frontend reads
//     tunnel state as UNKNOWN (never "down") — a controller topology where
//     the header cannot arrive says nothing about the tunnel.
//   - WIRED provider (client-daemon only): the header carries the provider's
//     current value; an empty return omits the header (same as unwired).
//
// The header is OBSERVATIONAL ONLY (debate-1 Q5, BINDING): a status input
// for the FE's graded ConnStatus reduction, never delivery authority.
func TestTunnelStateHeader(t *testing.T) {
	newSrv := func(t *testing.T) *Server {
		t.Helper()
		oc := httptest.NewServer(http.NotFoundHandler())
		t.Cleanup(oc.Close)
		srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
		if err != nil {
			t.Fatal(err)
		}
		return srv
	}
	get := func(t *testing.T, srv *Server) *http.Response {
		t.Helper()
		web := httptest.NewServer(srv.Handler())
		t.Cleanup(web.Close)
		res, err := http.Get(web.URL + "/vh/version")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}

	t.Run("unwired provider omits the header", func(t *testing.T) {
		res := get(t, newSrv(t))
		if got := res.Header.Get("X-VH-Tunnel-State"); got != "" {
			t.Errorf("X-VH-Tunnel-State: want absent (unknown), got %q", got)
		}
	})

	t.Run("wired provider stamps the current value", func(t *testing.T) {
		srv := newSrv(t)
		state := "disconnected"
		srv.SetTunnelStateProvider(func() string { return state })
		res := get(t, srv)
		if got := res.Header.Get("X-VH-Tunnel-State"); got != "disconnected" {
			t.Errorf("X-VH-Tunnel-State: want disconnected, got %q", got)
		}
		state = "connected"
		res = get(t, srv)
		if got := res.Header.Get("X-VH-Tunnel-State"); got != "connected" {
			t.Errorf("X-VH-Tunnel-State: want connected (live read), got %q", got)
		}
	})

	t.Run("empty provider return omits the header", func(t *testing.T) {
		srv := newSrv(t)
		srv.SetTunnelStateProvider(func() string { return "" })
		res := get(t, srv)
		if got := res.Header.Get("X-VH-Tunnel-State"); got != "" {
			t.Errorf("X-VH-Tunnel-State: want absent on empty return, got %q", got)
		}
	})
}
