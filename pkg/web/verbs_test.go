package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// fakeOC is a minimal opencode stand-in for the write verbs: it records the
// requests the verbs forward so a test can assert the mechanism (dedup, CAS,
// body shaping) without a real server.
type fakeOC struct {
	mu              sync.Mutex
	prompts         []string // bodies POSTed to /session/:id/prompt_async
	creates         int
	aborts          int
	questions       []string
	permissions     []string
	permRouteAbsent bool // canonical /permission reply 404s once (route missing → legacy fallback)
	permCanonStatus int  // if non-zero, canonical /permission reply returns this status (no record)
	qStatus         int  // if non-zero, /question reply returns this status (no record)
}

func (f *fakeOC) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			f.mu.Lock()
			f.creates++
			f.mu.Unlock()
			w.Write([]byte(`{"id":"new_sess","title":"t"}`))
			return
		}
		w.Write([]byte("[]"))
	})
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case bytesHasSuffix(p, "/prompt_async"):
			b, _ := readAll(r)
			f.prompts = append(f.prompts, b)
			w.WriteHeader(http.StatusNoContent)
		case bytesHasSuffix(p, "/abort"):
			f.aborts++
			w.WriteHeader(http.StatusOK)
		case contains(p, "/permissions/"):
			b, _ := readAll(r)
			f.permissions = append(f.permissions, "legacy:"+b)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	})
	mux.HandleFunc("/question/", func(w http.ResponseWriter, r *http.Request) {
		b, _ := readAll(r)
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.qStatus != 0 {
			w.WriteHeader(f.qStatus)
			return
		}
		f.questions = append(f.questions, b)
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/permission/", func(w http.ResponseWriter, r *http.Request) {
		b, _ := readAll(r)
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.permCanonStatus != 0 {
			w.WriteHeader(f.permCanonStatus)
			return
		}
		if f.permRouteAbsent {
			f.permRouteAbsent = false
			w.WriteHeader(http.StatusNotFound) // canonical route missing → legacy fallback
			return
		}
		f.permissions = append(f.permissions, "canonical:"+b)
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func bytesHasSuffix(s, suf string) bool { return len(s) >= len(suf) && s[len(s)-len(suf):] == suf }
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
func readAll(r *http.Request) (string, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(r.Body)
	return b.String(), err
}

// newVerbServer wires a Server whose client points at the fake. The aggregator's
// Run loop is NOT started; tests seed the store via the returned aggregator.
func newVerbServer(t *testing.T, f *fakeOC) (*httptest.Server, *aggregator.Aggregator) {
	t.Helper()
	oc := httptest.NewServer(f.handler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 1000)
	srv, err := NewServer(agg, oc.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return web, agg
}

func ev(typ, props string) opencode.Event {
	return opencode.Event{Type: typ, Properties: json.RawMessage(props)}
}

// post sends a CSRF-passing JSON POST and returns status + decoded body.
func post(t *testing.T, url, body string, hdr map[string]string) (int, map[string]any, http.Header) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1") // pass the CSRF guard
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out, resp.Header
}

func TestSnapshotStampsEpochSeqHeaders(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	resp, err := http.Get(web.URL + "/vh/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("X-Vh-Epoch"); got == "" || got != agg.Store().Epoch() {
		t.Fatalf("X-VH-Epoch header want %q, got %q", agg.Store().Epoch(), got)
	}
	if resp.Header.Get("X-Vh-Seq") == "" {
		t.Fatal("X-VH-Seq header should be stamped on /vh/* responses")
	}
}

func TestSkillEmitEndpoint(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	resp, err := http.Get(web.URL + "/vh/skill/emit")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") {
		t.Fatalf("want text/markdown, got %q", ct)
	}
	if resp.Header.Get("X-Vh-Skill-Version") == "" {
		t.Fatal("missing X-VH-Skill-Version header")
	}
	// Real generated skill, not the SPA catch-all.
	s := string(body)
	if strings.HasPrefix(strings.TrimSpace(s), "<") || !strings.Contains(s, "### `send_message`") || !strings.Contains(s, "gate{}") {
		t.Fatalf("body is not the generated skill: %.80s", s)
	}
}

func TestProjectsEnumeratesInstances(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	resp, err := http.Get(web.URL + "/vh/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["dir"] != "" {
		t.Fatalf("want the default project enumerated, got %v", got)
	}
	if e, _ := got[0]["epoch"].(string); e == "" || e != agg.Store().Epoch() {
		t.Fatalf("project epoch must match the store epoch, got %v want %q", got[0]["epoch"], agg.Store().Epoch())
	}
}

func TestSendForwardsPrompt(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"continue"}`, nil)
	if st != 200 || out["ok"] != true {
		t.Fatalf("want 200 ok, got %d %v", st, out)
	}
	if len(f.prompts) != 1 || !contains(f.prompts[0], `"continue"`) || !contains(f.prompts[0], `"text"`) {
		t.Fatalf("prompt not forwarded as text part: %v", f.prompts)
	}
}

func TestSendCASRejectsBusy(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	// Session a is mid-generation: an in-flight assistant message.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"a"}}`))
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	st, _, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"x"}`, map[string]string{ifIdleSeqHeader: "999999"})
	if st != http.StatusConflict {
		t.Fatalf("CAS on a busy session must 409, got %d", st)
	}
	if len(f.prompts) != 0 {
		t.Fatalf("nothing should have been forwarded, got %v", f.prompts)
	}
}

func TestSendCASAcceptsIdleAndRejectsStaleSeq(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	s := agg.Store()
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"length"}}`))
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	curSeq := s.Snapshot(nil).Seq

	// Fresh observation (providedSeq >= activitySeq) → accepted.
	st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"continue"}`,
		map[string]string{ifIdleSeqHeader: strconv.FormatUint(curSeq, 10)})
	if st != 200 || out["ok"] != true {
		t.Fatalf("fresh CAS should accept, got %d %v", st, out)
	}

	// Stale observation (providedSeq older than the last activity change) → 409.
	st2, _, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"continue"}`,
		map[string]string{ifIdleSeqHeader: "0"})
	if st2 != http.StatusConflict {
		t.Fatalf("stale CAS seq should 409, got %d", st2)
	}
}

func TestIdempotentSendReplays(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	body := `{"sessionID":"a","text":"continue","idempotency_key":"k1"}`
	st1, _, _ := post(t, web.URL+"/vh/send", body, nil)
	st2, _, h2 := post(t, web.URL+"/vh/send", body, nil)
	if st1 != 200 || st2 != 200 {
		t.Fatalf("both want 200, got %d %d", st1, st2)
	}
	if h2.Get("X-VH-Idempotent-Replay") != "1" {
		t.Fatal("second identical-key send should be a replay")
	}
	if len(f.prompts) != 1 {
		t.Fatalf("idempotent retry must forward exactly once, got %d", len(f.prompts))
	}
}

func TestSpawnCreatesAndPrompts(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"do the thing","title":"T"}`, nil)
	if st != 200 || out["sessionID"] != "new_sess" {
		t.Fatalf("spawn want sessionID new_sess, got %d %v", st, out)
	}
	if f.creates != 1 || len(f.prompts) != 1 {
		t.Fatalf("spawn must create once and prompt once, got creates=%d prompts=%d", f.creates, len(f.prompts))
	}
}

func TestAbortAndAnswerQuestion(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	if st, _, _ := post(t, web.URL+"/vh/abort", `{"sessionID":"a"}`, nil); st != 200 || f.aborts != 1 {
		t.Fatalf("abort failed: st=%d aborts=%d", st, f.aborts)
	}
	if st, _, _ := post(t, web.URL+"/vh/answer-question", `{"questionID":"q1","answers":[["yes"]]}`, nil); st != 200 || len(f.questions) != 1 {
		t.Fatalf("answer-question failed: st=%d n=%d", st, len(f.questions))
	}
}

func TestReplyPermissionValidatesAndFallsBack(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	// Invalid reply value → 400, nothing forwarded.
	if st, _, _ := post(t, web.URL+"/vh/reply-permission", `{"permissionID":"p1","reply":"maybe"}`, nil); st != 400 {
		t.Fatalf("invalid reply must 400, got %d", st)
	}
	// Canonical route absent (404) → legacy fallback used (sessionID provided).
	f.permRouteAbsent = true
	st, out, _ := post(t, web.URL+"/vh/reply-permission", `{"permissionID":"p1","sessionID":"a","reply":"once"}`, nil)
	if st != 200 || out["ok"] != true {
		t.Fatalf("permission reply with fallback should succeed, got %d %v", st, out)
	}
	if len(f.permissions) != 1 || !contains(f.permissions[0], "legacy:") {
		t.Fatalf("expected legacy fallback to be used, got %v", f.permissions)
	}
}

func TestReplyPermissionPropagatesMeaningful4xx(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	// Canonical route returns a meaningful 400 (not route-missing) → propagate 400,
	// do NOT fall back, do NOT mask as 502. sessionID is present.
	f.permCanonStatus = http.StatusBadRequest
	st, _, _ := post(t, web.URL+"/vh/reply-permission", `{"permissionID":"p1","sessionID":"a","reply":"once"}`, nil)
	if st != http.StatusBadRequest {
		t.Fatalf("a meaningful canonical 400 must propagate (not fall back / 502), got %d", st)
	}
	if len(f.permissions) != 0 {
		t.Fatalf("no legacy fallback should have happened, got %v", f.permissions)
	}
}

func TestAnswerQuestionAlreadyClearedMapsTo410(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	// A reply to a no-longer-pending question → opencode 404 → we map to 410 Gone
	// (request-id CAS, §5), so the coordinator distinguishes "already handled".
	f.qStatus = http.StatusNotFound
	st, _, _ := post(t, web.URL+"/vh/answer-question", `{"questionID":"q1","answers":[["yes"]]}`, nil)
	if st != http.StatusGone {
		t.Fatalf("answer to a cleared question should map 404→410, got %d", st)
	}
}

func TestReplyPermissionAlreadyClearedMapsTo410(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	// No sessionID → no legacy fallback; canonical 404 → 410.
	f.permCanonStatus = http.StatusNotFound
	st, _, _ := post(t, web.URL+"/vh/reply-permission", `{"permissionID":"p1","reply":"once"}`, nil)
	if st != http.StatusGone {
		t.Fatalf("reply to a cleared permission should map 404→410, got %d", st)
	}
}
