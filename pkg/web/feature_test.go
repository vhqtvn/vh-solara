package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// testFeature is an out-of-the-box capability module used to prove the registry
// mounts arbitrary features generically.
type testFeature struct{}

func (testFeature) Name() string { return "test" }
func (testFeature) Routes(svc Services) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"/vh/test-feature": func(w http.ResponseWriter, r *http.Request) {
			// Touch Services to confirm a feature can resolve the store.
			_ = svc.Agg(svc.ReqDir(r)).Store()
			_, _ = io.WriteString(w, "feat-ok")
		},
	}
}

func TestFeatureRegistryMountsCustomFeature(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 100)
	srv, err := NewServer(agg, oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	srv.RegisterFeature(testFeature{})
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// Custom feature route is mounted.
	resp, err := http.Get(web.URL + "/vh/test-feature")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "feat-ok" {
		t.Fatalf("custom feature route: want 200 feat-ok, got %d %q", resp.StatusCode, b)
	}

	// The built-in coordination feature is still mounted (POST /vh/send exists —
	// a GET is method-not-allowed, NOT a 404).
	resp2, err := http.Get(web.URL + "/vh/send")
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode == http.StatusNotFound {
		t.Fatal("coordination feature route /vh/send not mounted")
	}
}
