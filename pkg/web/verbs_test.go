package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
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
	createStatus    int  // if non-zero, POST /session returns this status (create failure)
	promptStatus    int  // if non-zero, /session/:id/prompt_async returns this status (prompt failure)
	archiveStatus   int  // if non-zero, PATCH /session/:id (SetArchived) returns this status (archive failure)

	// archivedPATCHes records the ids of every PATCH /session/:id (SetArchived)
	// call, in order — used by the archive re-assert test to assert a re-PATCH.
	archivedPATCHes []string

	// deleteStatus: if non-zero, DELETE /session/:id (DeleteSession) returns
	// this status (delete failure simulation). deleteIDs records the ids of
	// every DELETE call, in order — used by the delete tests to assert the
	// per-id loop fired (and to distinguish gone-tolerance from a real failure).
	deleteStatus int
	deleteIDs    []string

	// listSessionsReply is the body returned by GET /session (ListSessions).
	// Defaults to nil → "[]" (no sessions). Used by the archive re-assert test
	// to fake OpenCode reporting an affected id with archived=null (didn't
	// stick because a busy subagent clobbered it).
	listSessionsReply []byte

	// permHold, when non-nil, blocks POST /permission/:id/reply (the watcher's
	// auto-reject RPC) until the channel is closed — letting a test hold the RPC
	// genuinely in-flight so Server.Shutdown's watcher-ctx cancellation can be
	// proven to abort it short of permRejectTimeout. nil (default) = no hold
	// (the handler records + returns 200 as before, so existing tests are
	// unaffected). permEntered/permDone are the rendezvous signals: permEntered
	// fires on handler entry (RPC is in-flight), permDone fires on return (clean
	// unwind after release). Both nil (default) = not tracked.
	permHold    chan struct{}
	permEntered chan struct{}
	permDone    chan struct{}
}

func (f *fakeOC) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			f.mu.Lock()
			f.creates++
			cs := f.createStatus
			f.mu.Unlock()
			if cs != 0 {
				w.WriteHeader(cs)
				return
			}
			w.Write([]byte(`{"id":"new_sess","title":"t"}`))
			return
		}
		// GET /session (ListSessions / ListArchivedSessions — both hit this
		// path; the archived=true query param is ignored by the handler, the
		// caller filters server-side). Return the configured reply, defaulting
		// to an empty list.
		f.mu.Lock()
		reply := f.listSessionsReply
		f.mu.Unlock()
		if reply == nil {
			reply = []byte("[]")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(reply)
	})
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case bytesHasSuffix(p, "/prompt_async"):
			b, _ := readAll(r)
			f.prompts = append(f.prompts, b)
			if f.promptStatus != 0 {
				w.WriteHeader(f.promptStatus)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case bytesHasSuffix(p, "/abort"):
			f.aborts++
			w.WriteHeader(http.StatusOK)
		case contains(p, "/permissions/"):
			b, _ := readAll(r)
			f.permissions = append(f.permissions, "legacy:"+b)
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete:
			// DeleteSession (DELETE /session/:id). Record the id (strip the
			// "/session/" prefix; ignore any sub-resource suffix). The handler's
			// outer f.mu.Lock()/defer Unlock() (above) already serializes this
			// append against the deletedIDs read helper, so no inner lock.
			id := strings.TrimPrefix(p, "/session/")
			if i := strings.IndexByte(id, '/'); i >= 0 {
				id = id[:i]
			}
			if id != "" {
				f.deleteIDs = append(f.deleteIDs, id)
			}
			if f.deleteStatus != 0 {
				w.WriteHeader(f.deleteStatus)
				return
			}
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPatch:
			// SetArchived (PATCH /session/:id time.archived). Used by /vh/archive
			// and by the re-assert goroutine. Record the id (strip the
			// "/session/" prefix; ignore any sub-resource suffix). The handler's
			// outer f.mu.Lock()/defer Unlock() (above) already serializes this
			// append against the archivedPATCHes read helper, so no inner lock.
			id := strings.TrimPrefix(p, "/session/")
			if i := strings.IndexByte(id, '/'); i >= 0 {
				id = id[:i]
			}
			if id != "" {
				f.archivedPATCHes = append(f.archivedPATCHes, id)
			}
			if f.archiveStatus != 0 {
				w.WriteHeader(f.archiveStatus)
				return
			}
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
		// Test-only rendezvous (permHold is nil for every production-shaped
		// test, so existing behavior is unchanged): hold the auto-reject RPC
		// genuinely in-flight so a test can prove Server.Shutdown aborts it via
		// watcher-ctx cancellation. Engaged BEFORE readAll/f.mu so the block
		// does not serialize against the fake's other handlers, and the request
		// body stays buffered for recording once released. permDone (deferred)
		// fires when the handler actually returns, so a test can confirm the
		// server-side goroutine unwinds cleanly after permHold is released.
		if f.permDone != nil {
			defer func() {
				select {
				case f.permDone <- struct{}{}:
				default:
				}
			}()
		}
		if f.permHold != nil {
			if f.permEntered != nil {
				select {
				case f.permEntered <- struct{}{}:
				default:
				}
			}
			<-f.permHold
		}
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
	web, agg, _ := newVerbServerSrv(t, f)
	return web, agg
}

// newVerbServerSrv is newVerbServer but also returns the Server (needed by tests
// that inspect web-layer state such as the fail-closed permission binding).
func newVerbServerSrv(t *testing.T, f *fakeOC) (*httptest.Server, *aggregator.Aggregator, *Server) {
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
	// Issue A: await the Server's owned background goroutines at test end.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return web, agg, srv
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
	// The server-managed state docs section (labels/pins/queue) is generated into
	// the live bytes served by this endpoint — proves /vh/skill/emit carries the
	// new content, not just that skill.Generate() produces it. Assert ALL THREE
	// subsection headers + their route anchors so an endpoint regression cannot
	// strip the pins/queue subsections while leaving the Labels header green.
	for _, must := range []string{
		"## Server-managed state docs",
		"### Labels (root-session groups + tags)",
		"### Pins (pinned session order)",
		"### Queue (per-session work distribution)",
		"/vh/labels",
		"/vh/pins",
		"/vh/session/{sessionId}/queue",
	} {
		if !strings.Contains(s, must) {
			t.Fatalf("emitted skill missing server-managed-state anchor %q", must)
		}
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
	// roots + running are server-authoritative counts (P2): they must be present
	// and equal the store's RootCount()/RunningRoots() even on an empty store
	// (both 0). The badge no longer re-derives these client-side.
	if r, _ := got[0]["roots"].(float64); int(r) != agg.Store().RootCount() {
		t.Fatalf("project roots must match store RootCount, got %v want %d", got[0]["roots"], agg.Store().RootCount())
	}
	if r, _ := got[0]["running"].(float64); int(r) != agg.Store().RunningRoots() {
		t.Fatalf("project running must match store RunningRoots, got %v want %d", got[0]["running"], agg.Store().RunningRoots())
	}
	// unreadRoots (NEW): per-project "unread idle" count (subset of roots −
	// running). Server-authoritative, present and 0 on an empty store.
	if r, ok := got[0]["unreadRoots"].(float64); !ok {
		t.Fatalf("project unreadRoots must be present, got %v", got[0])
	} else if int(r) != agg.Store().UnreadRoots() {
		t.Fatalf("project unreadRoots must match store UnreadRoots, got %v want %d", got[0]["unreadRoots"], agg.Store().UnreadRoots())
	}
}

// TestProjectsReportsRunningCount exercises the per-project Running badge source
// (P2): /vh/projects must report the SAME authoritative running-root count the
// store computes via RunningRoots(), so the SPA's project switcher badge stops
// re-deriving it client-side. Seeds two roots and makes one busy via a child so
// root-dedup leaves exactly one running root (mirrors TestRunningRoots).
func TestProjectsReportsRunningCount(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	st := agg.Store()

	// Empty store → roots 0, running 0.
	if got := projectsRunning(t, web.URL); got != 0 {
		t.Fatalf("empty store: want running 0, got %d", got)
	}

	// Two roots; a child of root "a" goes busy → 1 running root (root dedup).
	st.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"c","parentID":"a"}}`))
	st.Apply(ev("session.status", `{"sessionID":"c","status":{"type":"busy"}}`))
	if want := st.RunningRoots(); want != 1 {
		t.Fatalf("setup invariant: RunningRoots want 1, got %d", want)
	}
	if want := st.RootCount(); want != 2 {
		t.Fatalf("setup invariant: RootCount want 2, got %d", want)
	}
	// The endpoint must agree with the authoritative store counts.
	if got := projectsRunning(t, web.URL); got != 1 {
		t.Fatalf("one busy subtree: want running 1, got %d", got)
	}

	// Child idles → 0 running; roots unchanged.
	st.Apply(ev("session.idle", `{"sessionID":"c"}`))
	if got := projectsRunning(t, web.URL); got != 0 {
		t.Fatalf("after child idles: want running 0, got %d", got)
	}
}

// TestProjectsReportsUnreadCount mirrors TestProjectsReportsRunningCount for the
// per-project "unread idle" count (a SUBSET of roots − running). /vh/projects
// must report UnreadRoots(), the count of live roots marked finished-unread.
// Seeds two roots, drives one through an ordinary busy→idle completion (which
// marks its root unread via markUnreadLocked — the unread ⊆ idle invariant), so
// unreadRoots flips to 1; acking that root clears it back to 0. Also asserts the
// invariant unreadRoots <= roots − running holds in BOTH states.
func TestProjectsReportsUnreadCount(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	st := agg.Store()

	// Empty store → roots 0, running 0, unread 0.
	if got := projectsUnread(t, web.URL); got != 0 {
		t.Fatalf("empty store: want unread 0, got %d", got)
	}

	// Two roots; a child of root "a" goes busy → 1 running root. unread still 0
	// (a busy subtree is not finished-unread).
	st.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"c","parentID":"a"}}`))
	st.Apply(ev("session.status", `{"sessionID":"c","status":{"type":"busy"}}`))
	if got := projectsUnread(t, web.URL); got != 0 {
		t.Fatalf("busy subtree: want unread 0, got %d", got)
	}
	// Invariant: unread ⊆ idle (idle = roots − running = 2 − 1 = 1).
	if u, idle := st.UnreadRoots(), st.RootCount()-st.RunningRoots(); u > idle {
		t.Fatalf("invariant violated (busy state): unread %d > idle %d", u, idle)
	}

	// Child idles via the ORDINARY completion path (session.idle, markOnIdle=true)
	// → root "a" marked finished-unread → unreadRoots 1.
	st.Apply(ev("session.idle", `{"sessionID":"c"}`))
	if want := st.UnreadRoots(); want != 1 {
		t.Fatalf("setup invariant: UnreadRoots want 1, got %d", want)
	}
	if got := projectsUnread(t, web.URL); got != 1 {
		t.Fatalf("after ordinary busy→idle: want unread 1, got %d", got)
	}
	// Invariant: unread ⊆ idle (idle = roots − running = 2 − 0 = 2; unread 1).
	if u, idle := st.UnreadRoots(), st.RootCount()-st.RunningRoots(); u > idle {
		t.Fatalf("invariant violated (idle state): unread %d > idle %d", u, idle)
	}

	// Ack the root → finished-unread cleared → unreadRoots 0.
	st.AckUnread("a")
	if want := st.UnreadRoots(); want != 0 {
		t.Fatalf("setup invariant: UnreadRoots want 0 after ack, got %d", want)
	}
	if got := projectsUnread(t, web.URL); got != 0 {
		t.Fatalf("after ack: want unread 0, got %d", got)
	}
}

// TestProjectsReportsCoherentCounts is the B-F1 standing-check for the
// /vh/projects coherence fix. After handleProjects switched from THREE separate
// locked accessors (RootCount/RunningRoots/UnreadRoots, each its own RLock) to
// the single-locked Store.ProjectCounts() accessor, the response's
// roots/running/unreadRoots must (a) match the store's authoritative
// ProjectCounts() triple, and (b) satisfy the wire invariant
// unreadRoots <= roots − running, on a MIXED population (a running root AND an
// unread root coexisting) — exactly the state where the earlier three-read race
// could let a busy→idle writer interleave and surface unread > idle. The race is
// now structurally impossible: the three counts come from one RLocked read.
func TestProjectsReportsCoherentCounts(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	st := agg.Store()

	// R1 — root, busy via child C1 (subtreeBusyCount[R1] = 1).
	// R2 — root, idle (driven to finished-unread below).
	// R3 — root, idle, not unread.
	// Children never count toward roots/running/unread.
	st.Apply(ev("session.created", `{"info":{"id":"R1"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"C1","parentID":"R1"}}`))
	st.Apply(ev("session.status", `{"sessionID":"C1","status":{"type":"busy"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"R2"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"R3"}}`))

	// State 1 — busy: roots 3, running 1 (R1), unread 0; idle = 2 ⊇ unread 0.
	wantRoots, wantRunning, wantUnread := st.ProjectCounts()
	if wantRoots != 3 || wantRunning != 1 || wantUnread != 0 {
		t.Fatalf("setup invariant (busy): want ProjectCounts (3,1,0), got (%d,%d,%d)",
			wantRoots, wantRunning, wantUnread)
	}
	gotRoots, gotRunning, gotUnread := projectsCounts(t, web.URL)
	if gotRoots != wantRoots || gotRunning != wantRunning || gotUnread != wantUnread {
		t.Fatalf("busy state: endpoint (roots,running,unread)=(%d,%d,%d), want ProjectCounts (%d,%d,%d)",
			gotRoots, gotRunning, gotUnread, wantRoots, wantRunning, wantUnread)
	}
	if gotUnread > gotRoots-gotRunning {
		t.Fatalf("wire invariant violated (busy): unread %d > idle %d", gotUnread, gotRoots-gotRunning)
	}

	// Drive R2 through an ordinary busy→idle completion (session.status busy →
	// idle, markOnIdle=true) so it flips finished-unread WITHOUT disturbing R1's
	// busy subtree. Result: one running root AND one unread root coexist.
	st.Apply(ev("session.created", `{"info":{"id":"C2","parentID":"R2"}}`))
	st.Apply(ev("session.status", `{"sessionID":"C2","status":{"type":"busy"}}`))
	st.Apply(ev("session.status", `{"sessionID":"C2","status":{"type":"idle"}}`))

	// State 2 — mixed: roots 3, running 1 (R1), unread 1 (R2); idle = 2 ⊇ unread 1.
	// This is the coherence-critical state: running and unread are both nonzero,
	// so a read-interleaving race here would surface unread > idle on the wire.
	wantRoots, wantRunning, wantUnread = st.ProjectCounts()
	if wantRoots != 3 || wantRunning != 1 || wantUnread != 1 {
		t.Fatalf("setup invariant (mixed): want ProjectCounts (3,1,1), got (%d,%d,%d)",
			wantRoots, wantRunning, wantUnread)
	}
	gotRoots, gotRunning, gotUnread = projectsCounts(t, web.URL)
	if gotRoots != wantRoots || gotRunning != wantRunning || gotUnread != wantUnread {
		t.Fatalf("mixed state: endpoint (roots,running,unread)=(%d,%d,%d), want ProjectCounts (%d,%d,%d)",
			gotRoots, gotRunning, gotUnread, wantRoots, wantRunning, wantUnread)
	}
	if gotUnread > gotRoots-gotRunning {
		t.Fatalf("wire invariant violated (mixed): unread %d > idle %d", gotUnread, gotRoots-gotRunning)
	}
}

// TestProjectsDualEmitsRunningAndRunningRoots is the L-10 standing-check: the
// /vh/projects response must carry BOTH `running` (retained) and `runningRoots`
// (the exact name the SPA migrates to), with the SAME value, for the
// alias-during-transition (Posture B). Seeds a busy root so the count is
// non-zero, then asserts both wire fields are present and equal. Removal of
// `running` is a future slice gated on an operator-approved cutoff; during the
// alias window this test asserts presence of BOTH. See
// docs/ai/wire-field-deprecation.md.
func TestProjectsDualEmitsRunningAndRunningRoots(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	st := agg.Store()

	// Seed two roots; a child of "a" goes busy → 1 running root (root dedup).
	st.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	st.Apply(ev("session.created", `{"info":{"id":"c","parentID":"a"}}`))
	st.Apply(ev("session.status", `{"sessionID":"c","status":{"type":"busy"}}`))
	want := st.RunningRoots()
	if want != 1 {
		t.Fatalf("setup invariant: RunningRoots want 1, got %d", want)
	}

	resp, err := http.Get(web.URL + "/vh/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	var def map[string]any
	for _, p := range got {
		if p["dir"] == "" {
			def = p
			break
		}
	}
	if def == nil {
		t.Fatalf("default project not enumerated in /vh/projects: %v", got)
	}
	old, okO := def["running"]
	nw, okN := def["runningRoots"]
	if !okO {
		t.Errorf("/vh/projects missing retained `running` field: %v", def)
	}
	if !okN {
		t.Errorf("/vh/projects missing new `runningRoots` field: %v", def)
	}
	if okO {
		if r, _ := old.(float64); int(r) != want {
			t.Errorf("running = %v, want %d", old, want)
		}
	}
	if okN {
		if r, _ := nw.(float64); int(r) != want {
			t.Errorf("runningRoots = %v, want %d", nw, want)
		}
	}
	if okO && okN && old != nw {
		t.Errorf("running (%v) != runningRoots (%v) — alias fields drifted apart", old, nw)
	}
}

// projectsRunning GETs /vh/projects and returns the default project's running
// count (the single ""-dir entry). Fails the test on any transport/shape error.
func projectsRunning(t *testing.T, base string) int {
	t.Helper()
	resp, err := http.Get(base + "/vh/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, p := range got {
		if p["dir"] == "" {
			r, _ := p["running"].(float64)
			return int(r)
		}
	}
	t.Fatalf("default project not enumerated in /vh/projects: %v", got)
	return 0
}

// projectsUnread GETs /vh/projects and returns the default project's unreadRoots
// count (the single ""-dir entry). Fails the test on any transport/shape error.
func projectsUnread(t *testing.T, base string) int {
	t.Helper()
	resp, err := http.Get(base + "/vh/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, p := range got {
		if p["dir"] == "" {
			r, _ := p["unreadRoots"].(float64)
			return int(r)
		}
	}
	t.Fatalf("default project not enumerated in /vh/projects: %v", got)
	return 0
}

// projectsCounts GETs /vh/projects and returns the default project's
// (roots, running, unreadRoots) — the THREE contract-coupled counts behind the
// unread ⊆ idle wire invariant (idle = roots − running must bound unreadRoots).
// Fails the test on any transport/shape error. Mirrors projectsRunning/
// projectsUnread but reads all three fields in one decode so a caller can assert
// the coherent triple handleProjects now emits via Store.ProjectCounts().
func projectsCounts(t *testing.T, base string) (roots, running, unread int) {
	t.Helper()
	resp, err := http.Get(base + "/vh/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, p := range got {
		if p["dir"] == "" {
			r, _ := p["roots"].(float64)
			ru, _ := p["running"].(float64)
			u, _ := p["unreadRoots"].(float64)
			return int(r), int(ru), int(u)
		}
	}
	t.Fatalf("default project not enumerated in /vh/projects: %v", got)
	return 0, 0, 0
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

// promptCount is the race-safe reader for fakeOC.prompts (the handler appends
// under f.mu; the test asserts concurrently in the P7 consumer suite).
func (f *fakeOC) promptCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

// TestP7_SendCASAwaitAbortSettling is the consumer RED suite: the FIRST
// production caller of Store.AbortSettling. A CAS-bearing /vh/send (If-Idle-Seq
// present) rejected SOLELY by an active abort settlement (the session is
// TurnStopping / AbortSettling==true) AWAITS the gate, then reruns the FULL
// SendableNow + seq CAS; it forwards exactly ONE prompt iff the fresh CAS
// passes, else 409. All other 409 conditions stay immediate: ordinary non-abort
// busy, stale If-Idle-Seq, sequence drift during the wait, continued
// non-sendability after release (e.g. a session.error release leaves activity in
// the error state).
//
// Determinism: the abort is settled by directly applying state transitions
// (session.idle / session.error), NEVER by waiting on the real 5s settle timer.
// The only real-time waits here are bounded goroutine-rendezvous windows
// (assertSendBlockedShortly / waitFor), not correctness proofs.
func TestP7_SendCASAwaitAbortSettling(t *testing.T) {
	// assertSendBlockedShortly confirms the async send is genuinely blocked in
	// the AbortSettling await: it returns BEFORE release ⇒ the consumer is
	// missing/broken (the send 409'd immediately instead of awaiting). This is
	// the RED signal for the consumer itself.
	assertSendBlockedShortly := func(t *testing.T, done <-chan struct{}) {
		t.Helper()
		select {
		case <-done:
			t.Fatal("send returned before release — it did NOT await AbortSettling (consumer missing/broken)")
		case <-time.After(100 * time.Millisecond):
			// good: still blocked after a generous in-process window → it is awaiting.
		}
	}

	// seedAbortSettling puts session "a" into the abort-settling window: a turn
	// was running (authoritative busy), then Stop was issued. Returns the
	// activitySeq captured at this point (for the drift sub-test's providedSeq).
	seedAbortSettling := func(t *testing.T, agg *aggregator.Aggregator) uint64 {
		t.Helper()
		s := agg.Store()
		s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
		s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
		s.Stop("a", "turn1")
		if !s.AbortSettling("a") {
			t.Fatal("seed: AbortSettling should be true after Stop")
		}
		_, seq, exists := s.SendableNow("a")
		if !exists {
			t.Fatal("seed: session a should exist")
		}
		return seq
	}

	// asyncSend launches a /vh/send in a goroutine and signals done on return.
	// Returns the done channel and a pointer-to-result the goroutine writes.
	asyncSend := func(url, body string, hdr map[string]string) (<-chan struct{}, *sendResult) {
		res := &sendResult{}
		done := make(chan struct{})
		go func() {
			defer close(done)
			st, out, _ := post(t, url, body, hdr)
			res.st, res.body = st, out
		}()
		return done, res
	}

	t.Run("idle_release_forwards_exactly_one_prompt", func(t *testing.T) {
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		seedAbortSettling(t, agg)

		// providedSeq huge ⇒ the seq CAS passes after release; only the abort
		// window blocks the initial send.
		done, _ := asyncSend(web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})

		assertSendBlockedShortly(t, done)
		if n := f.promptCount(); n != 0 {
			t.Fatalf("before release: promptCount=%d, want 0 (await must not forward)", n)
		}

		// Deterministic release: a LIVE session.idle settles the abort (activity
		// busy→idle, gate opens). The waiter wakes, the fresh CAS passes, and the
		// send forwards exactly ONE prompt.
		agg.Store().Apply(ev("session.idle", `{"sessionID":"a"}`))
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("after idle release: send did not return (await did not unblock)")
		}
		if n := f.promptCount(); n != 1 {
			t.Fatalf("after idle release: promptCount=%d, want EXACTLY 1 (fresh CAS passed → forward one prompt)", n)
		}
	})

	t.Run("error_release_unblocks_but_non_sendable_409", func(t *testing.T) {
		// Deviation from the card's literal "idle/error → 1 prompt": session.error
		// settles the abort gate (the await unblocks) BUT leaves activity in the
		// ERROR state, so the fresh SendableNow CAS fails (act != idle). Per the
		// design's "forward iff the fresh CAS passes, else 409", an error release
		// therefore 409s. This subtest proves the await unblocks on the error
		// terminal AND that "continued non-sendability after release" stays 409.
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		seedAbortSettling(t, agg)

		done, res := asyncSend(web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})

		assertSendBlockedShortly(t, done)
		if n := f.promptCount(); n != 0 {
			t.Fatalf("before release: promptCount=%d, want 0", n)
		}

		agg.Store().Apply(ev("session.error", `{"sessionID":"a"}`))
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("after error release: send did not return (await did not unblock on the error terminal)")
		}
		if res.st != http.StatusConflict {
			t.Fatalf("after error release: status=%d, want 409 (activity=error → fresh CAS fails)", res.st)
		}
		if n := f.promptCount(); n != 0 {
			t.Fatalf("after error release: promptCount=%d, want 0 (non-sendable → no forward)", n)
		}
	})

	t.Run("activity_seq_drift_before_release_409", func(t *testing.T) {
		// providedSeq captured at seed (the abort window's activity seq). An
		// activity transition during the wait (here: session.status idle, which
		// bumps activitySeq WITHOUT releasing the gate — NormSessionStatus idle
		// does not settle the abort) makes the post-release seq CAS stale → 409.
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		providedSeq := seedAbortSettling(t, agg)

		done, res := asyncSend(web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: strconv.FormatUint(providedSeq, 10)})

		assertSendBlockedShortly(t, done)
		if n := f.promptCount(); n != 0 {
			t.Fatalf("before drift: promptCount=%d, want 0", n)
		}

		// Advance activity-seq WITHOUT releasing the gate.
		agg.Store().Apply(ev("session.status", `{"sessionID":"a","status":{"type":"idle"}}`))
		// Then release via the live idle terminal.
		agg.Store().Apply(ev("session.idle", `{"sessionID":"a"}`))
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("after release: send did not return")
		}
		if res.st != http.StatusConflict {
			t.Fatalf("after seq drift + release: status=%d, want 409 (activitySeq drifted past If-Idle-Seq)", res.st)
		}
		if n := f.promptCount(); n != 0 {
			t.Fatalf("after seq drift + release: promptCount=%d, want 0 (stale CAS → no forward)", n)
		}
	})

	t.Run("request_context_cancelled_returns_no_prompt", func(t *testing.T) {
		// The await is request-context-cancellable: cancelling the request during
		// the wait unblocks it with zero prompts forwarded. The done channel is
		// closed on return so assertSendBlockedShortly proves the send was
		// genuinely awaiting before the cancel (a pre-consumer immediate 409
		// would fire done and fail the block assertion).
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		seedAbortSettling(t, agg)

		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, web.URL+"/vh/send",
				bytes.NewBufferString(`{"sessionID":"a","text":"follow"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(csrfHeader, "1")
			req.Header.Set(ifIdleSeqHeader, "999999")
			resp, _ := http.DefaultClient.Do(req)
			if resp != nil {
				resp.Body.Close()
			}
		}()

		assertSendBlockedShortly(t, done)
		if n := f.promptCount(); n != 0 {
			t.Fatalf("before cancel: promptCount=%d, want 0", n)
		}

		cancel()
		select {
		case <-done:
			// good: the cancelled request returned.
		case <-time.After(3 * time.Second):
			t.Fatal("after request cancel: send did not return (await ignored context cancellation)")
		}
		if n := f.promptCount(); n != 0 {
			t.Fatalf("after cancel: promptCount=%d, want 0 (cancellation must not forward)", n)
		}
	})

	t.Run("ordinary_non_abort_busy_immediate_409", func(t *testing.T) {
		// A busy session that is NOT mid-abort (TurnRunning, AbortSettling==false)
		// must 409 IMMEDIATELY — the await is only for the abort-settlement window.
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		s := agg.Store()
		s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
		s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
		if s.AbortSettling("a") {
			t.Fatal("ordinary running session must have AbortSettling==false")
		}

		st, _, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"x"}`,
			map[string]string{ifIdleSeqHeader: "999999"})
		if st != http.StatusConflict {
			t.Fatalf("ordinary non-abort busy must 409 IMMEDIATELY, got %d", st)
		}
		if n := f.promptCount(); n != 0 {
			t.Fatalf("ordinary busy: promptCount=%d, want 0", n)
		}
	})

	t.Run("settle_in_snapshot_to_await_window_no_stale_409", func(t *testing.T) {
		// B1 regression pin (tier1_b from commit-review). The /vh/send CAS path
		// MUST observe sendability + activitySeq + the abort gate as a SINGLE
		// atomic snapshot. Under the two-read form, an abort settling in the gap
		// between the SendableNow read (sendable=false, STALE — the session is
		// now idle post-settle) and the AbortSettling read (gate=open, FRESH)
		// left the handler holding a stale sendable=false alongside a fresh
		// gate-open. The await guard (!sendable && seqCAS && AbortSettling) was
		// then false, so the handler skipped BOTH WaitAbortSettling AND the
		// mandatory fresh SendableNow+seq CAS rerun, falling through to
		// `if !sendable` (stale true) → 409. With a large If-Idle-Seq the fresh
		// CAS WOULD pass and a prompt SHOULD forward; instead it stale-409'd — a
		// residual instance of the exact race this slice exists to close.
		//
		// This subtest injects the settle DETERMINISTICALLY in the
		// snapshot→await window via the sendCASPostSnapshotHook (nil in prod) and
		// asserts the contract holds: no stale 409 — the handler forwards
		// EXACTLY ONE prompt when the fresh CAS passes. (RED on the two-read
		// form, where the hook sits between the two reads; GREEN on the single
		// atomic SendCASState snapshot, where the hook sits after it and the
		// await re-snapshots authoritatively.)
		f := &fakeOC{}
		web, agg := newVerbServer(t, f)
		seedAbortSettling(t, agg)

		// Hook: settle the abort (live idle → gate opens, activity busy→idle,
		// activitySeq bumps S→S+1) immediately after the handler's atomic
		// snapshot, before the await decision. This is the precise settle that
		// used to land in the read1→read2 gap.
		sendCASPostSnapshotHook = func(sid string) {
			if sid == "a" {
				agg.Store().Apply(ev("session.idle", `{"sessionID":"a"}`))
			}
		}
		t.Cleanup(func() { sendCASPostSnapshotHook = nil })

		// Large If-Idle-Seq (>= the post-settle activitySeq) → the fresh CAS
		// passes. The handler must forward, not stale-409.
		st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})
		if st != 200 || out["ok"] != true {
			t.Fatalf("B1: settle in snapshot→await window must NOT stale-409; got status=%d body=%v (want 200 ok — fresh CAS passes)", st, out)
		}
		if n := f.promptCount(); n != 1 {
			t.Fatalf("B1: promptCount=%d, want EXACTLY 1 (the fresh CAS forwarded, not a stale 409)", n)
		}
	})
}

// sendResult captures an async /vh/send response for the P7 consumer suite.
type sendResult struct {
	st   int
	body map[string]any
}

func TestIdempotentSendReplays(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	body := `{"sessionID":"a","text":"continue","idempotency_key":"k1"}`
	st1, out1, _ := post(t, web.URL+"/vh/send", body, nil)
	st2, out2, h2 := post(t, web.URL+"/vh/send", body, nil)
	if st1 != 200 || st2 != 200 {
		t.Fatalf("both want 200, got %d %d", st1, st2)
	}
	// Fresh send delivers a prompt into an existing session.
	if out1["outcome"] != OutcomePromptRetried {
		t.Fatalf("fresh send outcome want %q, got %v", OutcomePromptRetried, out1["outcome"])
	}
	// A replay must report outcome=reused (the side effect already happened).
	if out2["outcome"] != OutcomeReused {
		t.Fatalf("replay send outcome want %q, got %v", OutcomeReused, out2["outcome"])
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
	if out["outcome"] != OutcomeCreated {
		t.Fatalf("fresh spawn outcome want %q, got %v", OutcomeCreated, out["outcome"])
	}
	if f.creates != 1 || len(f.prompts) != 1 {
		t.Fatalf("spawn must create once and prompt once, got creates=%d prompts=%d", f.creates, len(f.prompts))
	}
}

// TestSpawnOutcomeReused verifies a replayed spawn (same idempotency_key) reports
// outcome=reused and does NOT re-execute the side effect (no second create).
func TestSpawnOutcomeReused(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	body := `{"prompt":"hi","title":"T","idempotency_key":"sp-1"}`
	st1, out1, h1 := post(t, web.URL+"/vh/spawn", body, nil)
	if st1 != 200 || out1["outcome"] != OutcomeCreated {
		t.Fatalf("fresh spawn want outcome=%q, got %d %v", OutcomeCreated, st1, out1)
	}
	if h1.Get("X-VH-Idempotent-Replay") != "" {
		t.Fatal("first spawn must not be a replay")
	}
	st2, out2, h2 := post(t, web.URL+"/vh/spawn", body, nil)
	if st2 != 200 || out2["outcome"] != OutcomeReused {
		t.Fatalf("replay spawn want outcome=%q, got %d %v", OutcomeReused, st2, out2)
	}
	if h2.Get("X-VH-Idempotent-Replay") != "1" {
		t.Fatal("second identical-key spawn should be a replay")
	}
	if out1["sessionID"] != out2["sessionID"] {
		t.Fatalf("replay should return the same sessionID, got %v vs %v", out1["sessionID"], out2["sessionID"])
	}
	if f.creates != 1 {
		t.Fatalf("replay must not re-create, got creates=%d", f.creates)
	}
}

// TestSpawnOutcomeFailedCreate verifies a create-session failure tags outcome=failed
// and surfaces no sessionID.
func TestSpawnOutcomeFailedCreate(t *testing.T) {
	f := &fakeOC{createStatus: http.StatusInternalServerError}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi","idempotency_key":"sp-fail"}`, nil)
	if st < 500 {
		t.Fatalf("create-failure want a 5xx-class status, got %d", st)
	}
	if out["outcome"] != OutcomeFailed {
		t.Fatalf("create-failure outcome want %q, got %v", OutcomeFailed, out["outcome"])
	}
	if _, ok := out["sessionID"]; ok {
		t.Fatalf("create-failure should not carry a sessionID, got %v", out["sessionID"])
	}
}

// TestSendOutcomeFailed verifies a send transport/prompt failure tags outcome=failed.
func TestSendOutcomeFailed(t *testing.T) {
	f := &fakeOC{promptStatus: http.StatusInternalServerError}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"x","idempotency_key":"sd-fail"}`, nil)
	if st < 500 {
		t.Fatalf("send-failure want a 5xx-class status, got %d", st)
	}
	if out["outcome"] != OutcomeFailed {
		t.Fatalf("send-failure outcome want %q, got %v", OutcomeFailed, out["outcome"])
	}
}

// TestSpawnOutcomeFailedReplayStaysFailed verifies the idempotency replay of a
// terminal failure is returned VERBATIM (outcome stays "failed", never rewritten
// to "reused") and does NOT re-execute the side effect. This is the contract the
// caller's failure-rate accounting depends on: a retry of a failed attempt is a
// cached replay, not a fresh execution, and the retryable signal is preserved.
func TestSpawnOutcomeFailedReplayStaysFailed(t *testing.T) {
	f := &fakeOC{createStatus: http.StatusBadGateway}
	web, _ := newVerbServer(t, f)
	body := `{"prompt":"hi","idempotency_key":"sp-fail-replay"}`
	st1, out1, h1 := post(t, web.URL+"/vh/spawn", body, nil)
	if st1 < 500 {
		t.Fatalf("first spawn-failure want a 5xx-class status, got %d", st1)
	}
	if out1["outcome"] != OutcomeFailed {
		t.Fatalf("first spawn-failure outcome want %q, got %v", OutcomeFailed, out1["outcome"])
	}
	if h1.Get("X-VH-Idempotent-Replay") != "" {
		t.Fatal("first spawn must not be a replay")
	}
	if f.creates != 1 {
		t.Fatalf("first spawn must hit create once, got creates=%d", f.creates)
	}
	// Retry with the SAME idempotency_key → cached replay, no re-execute.
	st2, out2, h2 := post(t, web.URL+"/vh/spawn", body, nil)
	if st2 != st1 {
		t.Fatalf("replay must return the cached status %d, got %d", st1, st2)
	}
	if out2["outcome"] != OutcomeFailed {
		t.Fatalf("replayed failure must stay %q (not rewritten to %q), got %v", OutcomeFailed, OutcomeReused, out2["outcome"])
	}
	if h2.Get("X-VH-Idempotent-Replay") != "1" {
		t.Fatal("retried identical-key spawn should be a replay")
	}
	if f.creates != 1 {
		t.Fatalf("replay must NOT re-execute create, got creates=%d", f.creates)
	}
}

// TestSendOutcomeFailedReplayStaysFailed is the send-side mirror: a replayed
// send failure stays "failed" and is not re-forwarded to the upstream prompt.
func TestSendOutcomeFailedReplayStaysFailed(t *testing.T) {
	f := &fakeOC{promptStatus: http.StatusBadGateway}
	web, _ := newVerbServer(t, f)
	body := `{"sessionID":"a","text":"x","idempotency_key":"sd-fail-replay"}`
	st1, out1, h1 := post(t, web.URL+"/vh/send", body, nil)
	if st1 < 500 {
		t.Fatalf("first send-failure want a 5xx-class status, got %d", st1)
	}
	if out1["outcome"] != OutcomeFailed {
		t.Fatalf("first send-failure outcome want %q, got %v", OutcomeFailed, out1["outcome"])
	}
	if h1.Get("X-VH-Idempotent-Replay") != "" {
		t.Fatal("first send must not be a replay")
	}
	if len(f.prompts) != 1 {
		t.Fatalf("first send must forward once, got prompts=%d", len(f.prompts))
	}
	st2, out2, h2 := post(t, web.URL+"/vh/send", body, nil)
	if st2 != st1 {
		t.Fatalf("replay must return the cached status %d, got %d", st1, st2)
	}
	if out2["outcome"] != OutcomeFailed {
		t.Fatalf("replayed failure must stay %q (not rewritten to %q), got %v", OutcomeFailed, OutcomeReused, out2["outcome"])
	}
	if h2.Get("X-VH-Idempotent-Replay") != "1" {
		t.Fatal("retried identical-key send should be a replay")
	}
	if len(f.prompts) != 1 {
		t.Fatalf("replay must NOT re-forward prompt, got prompts=%d", len(f.prompts))
	}
}

// TestSpawnOutcomeCreateOkPromptFailed verifies the spawn branch where session
// creation succeeds but the first prompt fails: outcome is "created" (a session
// WAS minted → counting), ok is false (the first turn did not complete),
// AND a sessionID is present. ok:false + outcome:"created" is intentional:
// outcome is the accounting/mint signal; ok is the operational status.
func TestSpawnOutcomeCreateOkPromptFailed(t *testing.T) {
	f := &fakeOC{promptStatus: http.StatusInternalServerError}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi","idempotency_key":"sp-promptfail"}`, nil)
	if st < 500 {
		t.Fatalf("create-ok-prompt-failed want a 5xx-class status, got %d", st)
	}
	if out["ok"] != false {
		t.Fatalf("create-ok-prompt-failed want ok=false, got %v", out["ok"])
	}
	if out["outcome"] != OutcomeCreated {
		t.Fatalf("create-ok-prompt-failed outcome want %q (a session was minted → counting), got %v", OutcomeCreated, out["outcome"])
	}
	if out["sessionID"] != "new_sess" {
		t.Fatalf("create-ok-prompt-failed should carry the minted sessionID, got %v", out["sessionID"])
	}
	if f.creates != 1 || len(f.prompts) != 1 {
		t.Fatalf("create must succeed and prompt must be attempted once, got creates=%d prompts=%d", f.creates, len(f.prompts))
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

// TestP7_SendCASAwaitAbortSettling_ReconcileClearRelease pins DEFER finding
// p7-d2 (reconcile-clear release path). The existing consumer suite
// (TestP7_SendCASAwaitAbortSettling) only exercises the LIVE idle and LIVE error
// release paths; this adds the RECONCILE-CLEAR release: SetActivityFromStatuses
// idling a TurnStopping session opens the gate via the clearActivity closure
// (reducers.go:337-356 → setAbortSettlingLocked(false) under s.mu). The waiter
// must unblock, the post-await FULL SendCASState+seq CAS recheck must run, and
// the documented outcome holds: a fresh CAS (large If-Idle-Seq) forwards EXACTLY
// ONE prompt (TurnIdle + activity idle → sendable).
//
// Determinism (p7-d2 hardened): the waitAbortSettlingParkHook fires at the
// commit-to-park point inside WaitAbortSettling, deterministically proving the
// /vh/send consumer's request goroutine parked on the abort gate channel BEFORE
// the reconcile-clear release is injected — replacing the prior elapsed-time
// sleep (100ms) as the SOLE parking proof, which could pass vacuously under
// scheduler delay (the release landing before the goroutine parked → fast-path
// return → the test passes without exercising the await-unblock path). The
// OUTCOME is deterministic regardless: after the reconcile-clear release the
// session is stably TurnIdle+ActivityIdle, so the recheck always observes
// sendable=true.
func TestP7_SendCASAwaitAbortSettling_ReconcileClearRelease(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	s := agg.Store()
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	s.Stop("a", "turn1") // TurnStopping, gate closed, settle timer armed
	if !s.AbortSettling("a") {
		t.Fatal("seed: AbortSettling should be true after Stop")
	}

	// Deterministic parked-observable (p7-d2): the park hook fires at the
	// commit-to-park point inside WaitAbortSettling (gate confirmed closed under
	// RLock, channel in hand), proving the send goroutine genuinely parked BEFORE
	// the release is injected. This replaces the prior 100ms elapsed-time sleep.
	parked := make(chan struct{}, 1)
	state.SetWaitAbortSettlingParkHookForTest(func(sid string) {
		if sid == "a" {
			select {
			case parked <- struct{}{}:
			default:
			}
		}
	})
	t.Cleanup(func() { state.SetWaitAbortSettlingParkHookForTest(nil) })

	// providedSeq huge ⇒ the seq CAS passes after release; only the abort window
	// blocks the initial send.
	res := &sendResult{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})
		res.st, res.body = st, out
	}()

	// Deterministic parking proof: wait for the park signal. The send goroutine
	// is now parked in WaitAbortSettling on the abort gate channel. A missing /
	// broken consumer (immediate 409) would never park → bounded-liveness
	// timeout. The prior elapsed-time sleep could NOT distinguish "parked" from
	// "not yet scheduled to park."
	select {
	case <-parked:
		// good: the send goroutine parked in the await.
	case <-time.After(3 * time.Second):
		t.Fatal("send goroutine did not park in WaitAbortSettling — consumer missing/broken or park hook did not fire")
	}
	if n := f.promptCount(); n != 0 {
		t.Fatalf("before release: promptCount=%d, want 0 (await must not forward)", n)
	}

	// Release via reconcile-clear: the periodic /session/status snapshot reports
	// "a" as idle. SetActivityFromStatuses's clearActivity closure
	// (reducers.go:337-356) sees !busy["a"], idles activity, and — because the
	// session is TurnStopping — settles the abort: cancelStopTimerLocked +
	// setAbortSettlingLocked(false) (opens the gate + wakes the waiter) +
	// TurnIdle. This is the bounded-latency backstop for the case OpenCode did
	// not emit session.idle on abort.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"a": json.RawMessage(`{"type":"idle"}`),
	})

	select {
	case <-done:
		// good: the waiter unblocked.
	case <-time.After(3 * time.Second):
		t.Fatal("after reconcile-clear release: send did not return (waiter did not unblock — clearActivity did not open the gate)")
	}
	if res.st != 200 || res.body["ok"] != true {
		t.Fatalf("reconcile-clear release: status=%d body=%v, want 200 ok (fresh CAS passed → forward one prompt)", res.st, res.body)
	}
	if n := f.promptCount(); n != 1 {
		t.Fatalf("reconcile-clear release: promptCount=%d, want EXACTLY 1 (fresh CAS passed → forward one prompt, not a stale 409)", n)
	}
}

// TestP7_SendCASAwaitAbortSettling_SessionDeleteYields404 pins DEFER finding
// p7-d2 (session-delete release path). At session teardown,
// deleteSessionLocked (reducers.go:592) deletes s.sessions[id] and THEN calls
// signalAbortWaitersLocked (reducers.go:717), which closes the wait channel —
// waking any blocked WaitAbortSettling caller — before the turn-state records
// are deleted. The woken caller's post-await SendCASState recheck then sees
// exists=false (the session is gone) and the handler returns a clean 404, NOT a
// stale forward or a wedge (the caller parked on a channel whose map entry was
// deleted outright, so it would never unblock without this explicit signal).
//
// Determinism (p7-d2 hardened): the waitAbortSettlingParkHook fires at the
// commit-to-park point inside WaitAbortSettling, deterministically proving the
// send goroutine parked on the abort gate channel BEFORE the session-delete is
// injected — replacing the prior elapsed-time sleep (100ms) as the SOLE parking
// proof. The OUTCOME is deterministic regardless: after session.deleted the
// session is stably gone, so the recheck always observes exists=false → 404.
func TestP7_SendCASAwaitAbortSettling_SessionDeleteYields404(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	s := agg.Store()
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	s.Stop("a", "turn1") // TurnStopping, gate closed
	if !s.AbortSettling("a") {
		t.Fatal("seed: AbortSettling should be true after Stop")
	}

	// Deterministic parked-observable (p7-d2): the park hook fires at the
	// commit-to-park point inside WaitAbortSettling, proving the send goroutine
	// genuinely parked BEFORE the session-delete is injected. Replaces the prior
	// 100ms elapsed-time sleep.
	parked := make(chan struct{}, 1)
	state.SetWaitAbortSettlingParkHookForTest(func(sid string) {
		if sid == "a" {
			select {
			case parked <- struct{}{}:
			default:
			}
		}
	})
	t.Cleanup(func() { state.SetWaitAbortSettlingParkHookForTest(nil) })

	res := &sendResult{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})
		res.st, res.body = st, out
	}()

	// Deterministic parking proof: wait for the park signal before teardown.
	select {
	case <-parked:
		// good: the send goroutine parked in the await.
	case <-time.After(3 * time.Second):
		t.Fatal("send goroutine did not park in WaitAbortSettling — consumer missing/broken or park hook did not fire")
	}
	if n := f.promptCount(); n != 0 {
		t.Fatalf("before delete: promptCount=%d, want 0", n)
	}

	// Release via session teardown: session.deleted → deleteSessionLocked. It
	// deletes s.sessions["a"] (line 668) and then calls signalAbortWaitersLocked
	// (line 717), closing the wait channel the waiter is parked on. The waiter's
	// recheck SendCASState → se == nil → exists=false → 404.
	s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))

	select {
	case <-done:
		// good: the waiter unblocked.
	case <-time.After(3 * time.Second):
		t.Fatal("after session-delete: send did not return (waiter did not unblock — signalAbortWaitersLocked did not wake it)")
	}
	if res.st != http.StatusNotFound {
		t.Fatalf("session-delete release: status=%d, want 404 (session gone — the recheck sees exists=false, not a stale forward or hang)", res.st)
	}
	if n := f.promptCount(); n != 0 {
		t.Fatalf("session-delete release: promptCount=%d, want 0 (session gone → no forward)", n)
	}
}

// TestP7_SendCAS_SpuriousWakeAfterRearm_Yields409 closes DEFER finding p7-d1 at
// the VERBS layer. The state-layer companion
// (TestP7_WaitAbortSettling_SpuriousWakeAfterRearm_RecheckAuthoritative) proves
// only the STATE mechanism (SendCASState sees sendable=false after a Stop#2
// re-arm). This test observes the user-visible VERBS-layer OUTCOME — the actual
// HTTP 409 + zero forwarded prompts — for the EXACT interleaving the
// "spurious true return is safe" doc claim (turn_state.go:370-375) rests on:
//
//  1. Stop#1 → TurnStopping, gate closed (channel A armed).
//  2. A CAS-bearing /vh/send awaits in WaitAbortSettling (parked on channel A).
//  3. Release#1 (live session.idle) opens the gate — channel A closed.
//  4. Stop#2 re-arms a FRESH channel B (gate closed again), TurnStopping.
//  5. The stale waiter wakes (channel A was closed by release#1) — spurious wake.
//  6. The post-await fresh SendCASState+seq CAS recheck sees the NEW TurnStopping
//     → sendable=false → the handler 409s with ZERO prompts forwarded.
//
// Determinism: both hooks sequence the interleaving deterministically —
// waitAbortSettlingParkHook (fired at the commit-to-park point) rendezvous-
// confirms the send goroutine parked on channel A BEFORE release#1, and
// sendCASPostAwaitHook (fired between WaitAbortSettling's return and the fresh
// recheck, ON the send goroutine) sequences Stop#2 into the await→recheck gap.
// The recheck then deterministically observes Stop#2's TurnStopping — no
// scheduler race between the re-arm's Lock and the recheck's RLock (which made
// this interleaving non-deterministic at the verbs layer without the hook).
func TestP7_SendCAS_SpuriousWakeAfterRearm_Yields409(t *testing.T) {
	f := &fakeOC{}
	web, agg := newVerbServer(t, f)
	s := agg.Store()
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	s.Stop("a", "turn1") // Stop#1: TurnStopping, gate closed, channel A armed
	if !s.AbortSettling("a") {
		t.Fatal("Stop#1: AbortSettling should be true (gate closed)")
	}

	// Hook B (park rendezvous): signals when the send goroutine commits to park
	// inside WaitAbortSettling (on channel A). nil in production.
	parked := make(chan struct{}, 1)
	state.SetWaitAbortSettlingParkHookForTest(func(sid string) {
		if sid == "a" {
			select {
			case parked <- struct{}{}:
			default:
			}
		}
	})
	t.Cleanup(func() { state.SetWaitAbortSettlingParkHookForTest(nil) })

	// Hook A (post-await re-arm): sequences Stop#2 into the await→recheck gap,
	// ON the send goroutine (the hook fires inline in the handler, between
	// WaitAbortSettling's return and the fresh SendCASState recheck). This is
	// the spurious-wake re-arm — a fresh gate close before the recheck. nil in
	// production.
	sendCASPostAwaitHook = func(sid string) {
		if sid == "a" {
			s.Stop("a", "turn2") // Stop#2: re-arm channel B, TurnStopping, gate closed
		}
	}
	t.Cleanup(func() { sendCASPostAwaitHook = nil })

	// Launch the async CAS send. providedSeq huge ⇒ the seq CAS passes; only the
	// abort window (Stop#1's gate) blocks the initial send.
	res := &sendResult{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		st, out, _ := post(t, web.URL+"/vh/send", `{"sessionID":"a","text":"follow"}`,
			map[string]string{ifIdleSeqHeader: "999999"})
		res.st, res.body = st, out
	}()

	// Rendezvous: wait for the send goroutine to park in WaitAbortSettling on
	// channel A (deterministic — the park hook fires at the commit-to-park
	// point). This confirms step 2 before we inject release#1.
	select {
	case <-parked:
		// good: parked on channel A.
	case <-time.After(3 * time.Second):
		t.Fatal("send goroutine did not park in WaitAbortSettling — consumer missing/broken or park hook did not fire")
	}
	if n := f.promptCount(); n != 0 {
		t.Fatalf("before release#1: promptCount=%d, want 0 (await must not forward)", n)
	}

	// Release#1: a LIVE session.idle settles the abort (activity busy→idle,
	// gate opens, channel A closed). The parked send goroutine wakes — the
	// spurious-wake (step 5): channel A was closed by release#1, so the stale
	// waiter's <-ch returns immediately. It then hits the post-await hook,
	// which issues Stop#2 (step 4, sequenced into the await→recheck gap).
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))

	// The send goroutine: wakes → post-await hook (Stop#2 re-arm) → fresh
	// SendCASState+seq CAS recheck sees Stop#2's TurnStopping → sendable=false →
	// 409. Bounded liveness guard (the outcome is deterministic — Stop#2 ran on
	// the send goroutine before the recheck, so the recheck always sees it).
	select {
	case <-done:
		// good: the send returned.
	case <-time.After(3 * time.Second):
		t.Fatal("send did not return after spurious-wake + Stop#2 re-arm")
	}

	// OUTCOME observed (not mechanism-asserted): HTTP 409 + zero prompts. The
	// spurious wake did NOT become send authority — the fresh recheck caught
	// Stop#2's re-arm and refused the send.
	if res.st != http.StatusConflict {
		t.Fatalf("spurious-wake-after-rearm: status=%d, want %d (fresh recheck saw Stop#2's TurnStopping → sendable=false → 409)", res.st, http.StatusConflict)
	}
	if n := f.promptCount(); n != 0 {
		t.Fatalf("spurious-wake-after-rearm: promptCount=%d, want 0 (the spurious wake must NOT become send authority — no prompt forwarded)", n)
	}

	// Ground truth: Stop#2 genuinely re-armed the gate (channel B armed, gate
	// closed, TurnStopping) — confirming the rearm the recheck observed was real.
	if !s.AbortSettling("a") {
		t.Errorf("after Stop#2: AbortSettling=false, want true (gate re-armed by the post-await hook's Stop#2)")
	}
	if ts := s.TurnState("a"); ts != state.TurnStopping {
		t.Errorf("after Stop#2: TurnState=%q, want %q (re-armed by the post-await hook)", ts, state.TurnStopping)
	}
}
