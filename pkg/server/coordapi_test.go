package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// coordTestHandler builds just the coordination front (routes + bearer +
// worker-resolution), with a sentinel for the non-coordination fall-through.
func coordTestHandler(d *Daemon) http.Handler {
	coordMux := http.NewServeMux()
	d.registerCoordRoutes(coordMux)
	fallthroughSentinel := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "fell-through", 599)
	})
	return d.coordFront(coordMux, fallthroughSentinel)
}

func do(t *testing.T, h http.Handler, method, path, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	h.ServeHTTP(rec, req)
	return rec
}

func TestCoordBearerGating(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	d.APIToken = "s3cret"
	h := coordTestHandler(d)

	// No bearer → 401.
	if rec := do(t, h, "GET", "/api/workers/w1/sessions", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no bearer: want 401, got %d", rec.Code)
	}
	// Wrong bearer → 401.
	if rec := do(t, h, "GET", "/api/workers/w1/sessions", "nope"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong bearer: want 401, got %d", rec.Code)
	}
	// Correct bearer, unknown worker → 404 (passed auth, reached resolution).
	if rec := do(t, h, "GET", "/api/workers/w1/sessions", "s3cret"); rec.Code != http.StatusNotFound {
		t.Fatalf("correct bearer + unknown worker: want 404, got %d", rec.Code)
	}
}

func TestCoordOpenWhenNoToken(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	h := coordTestHandler(d)
	// Open API: no bearer needed; unknown worker still 404.
	if rec := do(t, h, "GET", "/api/workers/w1/sessions", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("open API unknown worker: want 404, got %d", rec.Code)
	}
}

func TestCoordOfflineWorker(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	d.Registry.AddWorker(&Worker{ID: "w1", Name: "w1", Status: "offline"}) // Transport nil
	h := coordTestHandler(d)
	if rec := do(t, h, "GET", "/api/workers/w1/sessions", ""); rec.Code != http.StatusBadGateway {
		t.Fatalf("offline worker: want 502, got %d", rec.Code)
	}
}

func TestCoordRoutesMatchedAndFallThrough(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	h := coordTestHandler(d)
	// Coordination routes are matched (unknown worker → 404, NOT the 599 sentinel).
	for _, p := range []struct{ method, path string }{
		{"GET", "/api/workers/w1/sessions"},
		{"POST", "/api/workers/w1/sessions"},
		{"GET", "/api/workers/w1/sessions/s1"},
		{"DELETE", "/api/workers/w1/sessions/s1"},
		{"POST", "/api/workers/w1/sessions/s1/message"},
		{"POST", "/api/workers/w1/sessions/s1/archive"},
		{"POST", "/api/workers/w1/sessions/s1/questions/q1"},
		{"POST", "/api/workers/w1/sessions/s1/permissions/p1"},
		{"GET", "/api/workers/w1/events"},
	} {
		rec := do(t, h, p.method, p.path, "")
		if rec.Code == 599 {
			t.Fatalf("%s %s should be a coordination route, fell through", p.method, p.path)
		}
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s want 404 (unknown worker), got %d", p.method, p.path, rec.Code)
		}
	}
	// A non-coordination path falls through to the next handler (the sentinel).
	if rec := do(t, h, "GET", "/api/workers", ""); rec.Code != 599 {
		t.Fatalf("non-coord path should fall through (599), got %d", rec.Code)
	}
	if rec := do(t, h, "POST", "/api/workers/w1/kill", ""); rec.Code != 599 {
		t.Fatalf("kill is not a coord route, should fall through (599), got %d", rec.Code)
	}
}

func TestReadJSONObjAndDirQuery(t *testing.T) {
	// readJSONObj tolerates an empty body.
	req := httptest.NewRequest("POST", "/x", strings.NewReader(""))
	if m := readJSONObj(req); len(m) != 0 {
		t.Fatalf("empty body should be empty map, got %v", m)
	}
	req = httptest.NewRequest("POST", "/x", strings.NewReader(`{"text":"hi"}`))
	if m := readJSONObj(req); m["text"] != "hi" {
		t.Fatalf("want text=hi, got %v", m)
	}
	// dirQuery carries ?dir= through and merges extras.
	req = httptest.NewRequest("GET", "/x?dir=/proj", nil)
	q := dirQuery(req, map[string][]string{"sessions": {"s1"}})
	if !strings.Contains(q, "dir=%2Fproj") || !strings.Contains(q, "sessions=s1") {
		t.Fatalf("dirQuery merge wrong: %q", q)
	}
}
