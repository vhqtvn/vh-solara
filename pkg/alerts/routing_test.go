package alerts

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// configWith builds a store seeded with one webhook channel and one active
// profile of the given policy.
func configWith(t *testing.T, url, secret, policy string) *Store {
	t.Helper()
	cfg, err := NewStore(filepath.Join(t.TempDir(), "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	c := cfg.Get()
	c.Channels = []Channel{{ID: "c1", Type: ChannelWebhook, URL: url, Secret: secret, Enabled: true}}
	c.Profiles = []Profile{{Name: "p", Channels: []string{"c1"}, ChannelPolicy: policy}}
	c.Active = "p"
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestWebhookHMACSignature(t *testing.T) {
	type cap struct {
		sig  string
		body []byte
	}
	ch := make(chan cap, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		ch <- cap{r.Header.Get("X-VH-Signature"), b}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := configWith(t, srv.URL, "topsecret", PolicyAlways)
	d := NewDispatcher(cfg, NewPresence())
	status, err := d.SendTest("c1")
	if err != nil || status != http.StatusOK {
		t.Fatalf("SendTest status=%d err=%v", status, err)
	}
	got := <-ch
	mac := hmac.New(sha256.New, []byte("topsecret"))
	mac.Write(got.body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if got.sig != want {
		t.Errorf("signature mismatch:\n got %s\nwant %s", got.sig, want)
	}
}

func TestDispatchRoutesByProfileAndAttendance(t *testing.T) {
	fired := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fired <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	didFire := func(d *Dispatcher) bool {
		d.Dispatch(Notice{Type: TypeFinished, SessionID: "s1"})
		select {
		case <-fired:
			return true
		case <-time.After(500 * time.Millisecond):
			return false
		}
	}

	// always → fires even when attended.
	cfg := configWith(t, srv.URL, "", PolicyAlways)
	pres := NewPresence()
	pres.Heartbeat(Device{ID: "d1", LastInteraction: time.Now()}) // attended
	if !didFire(NewDispatcher(cfg, pres)) {
		t.Error("policy=always must fire regardless of attendance")
	}

	// never → never fires.
	cfg = configWith(t, srv.URL, "", PolicyNever)
	if didFire(NewDispatcher(cfg, NewPresence())) {
		t.Error("policy=never must not fire")
	}

	// when_unattended + away → fires.
	cfg = configWith(t, srv.URL, "", PolicyWhenUnattended)
	if !didFire(NewDispatcher(cfg, NewPresence())) {
		t.Error("when_unattended + away must fire")
	}

	// when_unattended + attended → does not fire.
	cfg = configWith(t, srv.URL, "", PolicyWhenUnattended)
	pres = NewPresence()
	pres.Heartbeat(Device{ID: "d1", LastInteraction: time.Now()})
	if didFire(NewDispatcher(cfg, pres)) {
		t.Error("when_unattended + attended must not fire")
	}
}

func TestDispatchCooldownSuppressesSecond(t *testing.T) {
	fired := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fired <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	cfg := configWith(t, srv.URL, "", PolicyAlways) // default cooldown 300s
	d := NewDispatcher(cfg, NewPresence())

	n := Notice{Type: TypeFinished, SessionID: "s1"}
	d.Dispatch(n)
	<-fired // first fires
	d.Dispatch(n)
	select {
	case <-fired:
		t.Error("second dispatch within cooldown must be suppressed")
	case <-time.After(400 * time.Millisecond):
		// suppressed as expected
	}
}
