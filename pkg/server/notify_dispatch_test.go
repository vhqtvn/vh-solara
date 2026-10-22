package server

// notify_dispatch_test.go — lane-1 co-located tests for the central FCM
// dispatcher (notify controller-hub S4 / v4 §3.4/§3.5/§9.5/§9.6; see
// notify_dispatch.go). The sender is the REAL shared transport
// (pkg/alerts.FCMTransport) against the fake OAuth + fake FCM pair from
// notify_transport_test.go; the ledger is a real file-backed journal; the
// gating ladder, claim-before-send persistence, cooldown persistence,
// pruning evidence/generation rules, the poison-fatal classification
// (GF2/c-F1) and the golden FCM message shape are pinned here.
//
// Lane 3 (tests/e2e/notify_dispatch_test.go) proves the full
// detection → feed → ledger commit → dispatch → fake-FCM spine over the
// real tunnel.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// newDispatchTransport builds the REAL shared transport against fresh
// fake OAuth + fake FCM servers (the credentials file's token_uri points
// at the fake OAuth endpoint).
func newDispatchTransport(t *testing.T, dir string) (*alerts.FCMTransport, *fakeFCM, *fakeOAuth) {
	t.Helper()
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	sa := testServiceAccount(key, "push@test-proj.iam.gserviceaccount.com", "proj-42", false)
	var m map[string]any
	if err := json.Unmarshal(sa, &m); err != nil {
		t.Fatal(err)
	}
	m["token_uri"] = oauth.srv.URL
	creds, _ := json.Marshal(m)
	credsPath := filepath.Join(dir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, creds, 0o600); err != nil {
		t.Fatal(err)
	}
	trans, err := alerts.NewFCMTransportFromFile(credsPath, "proj-42", 3600)
	if err != nil {
		t.Fatalf("NewFCMTransportFromFile: %v", err)
	}
	trans.SetBaseURL(fcm.srv.URL)
	trans.SetLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	return trans, fcm, oauth
}

// dispatchFixture wires a real file-backed ledger + token store + the REAL
// shared FCM transport against the fake OAuth/FCM pair.
type dispatchFixture struct {
	d     *Daemon
	path  string
	trans *alerts.FCMTransport
	fcm   *fakeFCM
	oauth *fakeOAuth
	clk   *mutableClock
}

// newDispatchFixture is the manager-test posture: a plain daemon with the
// durable store armed (no auth chain — the probe test uses the auth
// variant below).
func newDispatchFixture(t *testing.T) *dispatchFixture {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")

	d := NewDaemon(":0", ":0", "")
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}
	t.Cleanup(d.notifyStore.flushSendResults)
	trans, fcm, oauth := newDispatchTransport(t, dir)
	clk := &mutableClock{t: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)}
	return &dispatchFixture{d: d, path: path, trans: trans, fcm: fcm, oauth: oauth, clk: clk}
}

// newAuthDispatchFixture is the HTTP-chain posture: a passphrase-auth
// daemon whose durable store + ledger are armed at a known path, plus the
// transport fakes — for the probe test.
func newAuthDispatchFixture(t *testing.T) (*dispatchFixture, http.Handler, *http.Cookie) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")
	d, h, session := newNotifyAuthDaemon(t)
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}
	t.Cleanup(d.notifyStore.flushSendResults)
	trans, fcm, oauth := newDispatchTransport(t, dir)
	clk := &mutableClock{t: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)}
	return &dispatchFixture{d: d, path: path, trans: trans, fcm: fcm, oauth: oauth, clk: clk}, h, session
}

// mutableClock is the deterministic clock the dispatch tests drive
// (cooldown/freshness boundaries advance instead of sleeping).
type mutableClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *mutableClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *mutableClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// newTestManager builds a synchronous manager over the fixture's
// durable state (tests drive processEvent/dispatchPass directly; the
// Run loop is exercised by the probe and loop tests).
func (f *dispatchFixture) newTestManager(t *testing.T, hostPattern string, cfg NotifyDispatchConfig) *notifyDispatchManager {
	t.Helper()
	state, err := loadNotifyDispatchFile(f.path + ".dispatch")
	if err != nil {
		t.Fatalf("load dispatch state: %v", err)
	}
	m := newNotifyDispatchManager(f.d.ledger(), &f.d.notifyStore, f.trans, hostPattern, f.path+".dispatch", cfg, state)
	m.now = f.clk.Now
	return m
}

// commitRecord appends one record into the fixture's ledger (the ingest
// path's CommitPage, identity attached) and returns the committed event.
func (f *dispatchFixture) commitRecord(t *testing.T, ev NotifyEvent) NotifyEvent {
	t.Helper()
	committed, err := f.d.ledger().CommitPage(notifyPageCommit{
		SourceID:   "bason",
		WorkerID:   "bason",
		WorkerName: "bason",
		Epoch:      "e1",
		Records:    []NotifyEvent{ev},
		AdvanceTo:  ev.Seq,
	})
	if err != nil {
		t.Fatalf("CommitPage: %v", err)
	}
	if len(committed) != 1 {
		t.Fatalf("CommitPage committed %d events, want 1", len(committed))
	}
	return committed[0]
}

// baseEvent is a fresh, unattended, profile-eligible waiting record.
func baseEvent(seq int64, kind string, ts time.Time) NotifyEvent {
	return NotifyEvent{
		Type: alerts.TypeWaiting, Kind: kind,
		SessionID: "ses-" + time.Now().Format("150405.000000000") + "-" + string(rune('a'+seq%26)),
		Root:      "root", Project: "/workspace/example",
		Title: "Review requested", Detail: "d",
		Ts:  ts.UnixMilli(),
		Seq: seq, Epoch: "e1", WorkerID: "bason", WorkerName: "bason",
		Attended: false, IdleSec: 60, ProfileEligible: true,
		CooldownKey: "bason|" + alerts.TypeWaiting,
	}
}

// fcmReceiptToken extracts message.token from a captured FCM request.
func fcmReceiptToken(t *testing.T, req fakeFCMRequest) string {
	t.Helper()
	var body struct {
		Message struct {
			Token string `json:"token"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		t.Fatalf("FCM request body: %v (%s)", err, req.Body)
	}
	return body.Message.Token
}

// ---------------------------------------------------------------------------
// The gating ladder (v4 §3.4)
// ---------------------------------------------------------------------------

// TestNotifyDispatch_GatingLadderMatrix is the ladder's behavioral pin:
// scope eligibility (enabled + explicit conditions; unsupported legacy
// conditions dormant), the detection-time type-filter snapshot, attendance
// from the snapshot (when_unattended suppressed / always delivered under
// an ATTENDED origin), and cooldown suppression for repeat
// (source, type, token) keys. Expected receipts are enumerated per event.
func TestNotifyDispatch_GatingLadderMatrix(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	m := f.newTestManager(t, "", cfg)

	const (
		tokWU     = "device-token-when-unattended"
		tokAlways = "device-token-always"
		tokOff    = "device-token-disabled"
		tokScope  = "device-token-scoped"
	)
	if _, _, err := f.d.notifyStore.submit(tokWU, "wu", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.d.notifyStore.submit(tokAlways, "always", alerts.PolicyAlways); err != nil {
		t.Fatal(err)
	}
	off, _, err := f.d.notifyStore.submit(tokOff, "off", alerts.PolicyAlways)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.d.notifyStore.patch(off.ID, notifyPatch{Scope: &notifyScope{Enabled: false, Conditions: []string{}}}); err != nil {
		t.Fatal(err)
	}
	scoped, _, err := f.d.notifyStore.submit(tokScope, "scoped", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.d.notifyStore.patch(scoped.ID, notifyPatch{Scope: &notifyScope{Enabled: true, Conditions: []string{"permission_pending"}}}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		mut  func(ev *NotifyEvent)
		adv  time.Duration // clock advance before the event (clears cooldown)
		want []string
	}{
		{"attended origin: only always delivers", func(ev *NotifyEvent) { ev.Attended = true }, 0,
			[]string{tokAlways}},
		{"unattended permission: wu + always + scoped", func(ev *NotifyEvent) {}, 61 * time.Second,
			[]string{tokWU, tokAlways, tokScope}},
		{"unattended question: scoped excluded (conditions)", func(ev *NotifyEvent) { ev.Kind = "question_pending" }, 61 * time.Second,
			[]string{tokWU, tokAlways}},
		{"profile-ineligible from snapshot: nobody", func(ev *NotifyEvent) { ev.ProfileEligible = false }, 61 * time.Second,
			nil},
	}

	for i, tc := range cases {
		f.clk.Advance(tc.adv)
		ev := baseEvent(int64(i+1), "permission_pending", f.clk.Now())
		tc.mut(&ev)
		committed := f.commitRecord(t, ev)
		seen := f.fcm.count()
		m.processEvent(committed)

		got := map[string]bool{}
		for j := seen; j < f.fcm.count(); j++ {
			req := f.fcm.request(j)
			got[fcmReceiptToken(t, req)] = true
			// No host pattern configured on this manager: the one data
			// field that may be absent MUST be absent (the omit rule).
			if i == 0 {
				var body struct {
					Message struct {
						Data map[string]string `json:"data"`
					} `json:"message"`
				}
				if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
					t.Fatalf("receipt body: %v", err)
				}
				if _, has := body.Message.Data["vh_ui_url"]; has {
					t.Errorf("vh_ui_url must be OMITTED when no usable worker host is configured: %v", body.Message.Data)
				}
			}
		}
		if len(got) != len(tc.want) {
			t.Errorf("%s: got receipts %v, want exactly %v (fcm total %d)", tc.name, got, tc.want, f.fcm.count())
			continue
		}
		for _, tok := range tc.want {
			if !got[tok] {
				t.Errorf("%s: token %q must have received the push, got %v", tc.name, tok, got)
			}
		}
	}
}

// TestNotifyDispatch_FreshnessSuppressesStaleEvents pins rung 5: events
// older than the stale threshold are history-only (never pushed), fresh
// events deliver, and the cursor advances past BOTH (retention is not
// bounded by the push policy).
func TestNotifyDispatch_FreshnessSuppressesStaleEvents(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	m := f.newTestManager(t, "", cfg)
	if _, _, err := f.d.notifyStore.submit("device-token-stale-0001", "", ""); err != nil {
		t.Fatal(err)
	}

	stale := f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now().Add(-25*time.Hour)))
	m.processEvent(stale)
	if f.fcm.count() != 0 {
		t.Fatalf("stale event (25h > 24h threshold) must be history-only, got %d pushes", f.fcm.count())
	}
	m.mu.Lock()
	cursor := m.state.Cursor
	m.mu.Unlock()
	if cursor != stale.ID {
		t.Fatalf("cursor = %d, want the stale event's id %d (history-only still advances)", cursor, stale.ID)
	}

	fresh := f.commitRecord(t, baseEvent(2, "permission_pending", f.clk.Now().Add(-time.Hour)))
	m.processEvent(fresh)
	if f.fcm.count() != 1 {
		t.Fatalf("fresh event must push, got %d pushes", f.fcm.count())
	}
}

// TestNotifyDispatch_CooldownPersistsAcrossRestart pins rung 6 + v4 (i):
// a repeat (source, type, token) within the window is suppressed, the
// decision SURVIVES a controller restart (state reloaded from disk — no
// replay burst), and the window eventually reopens.
func TestNotifyDispatch_CooldownPersistsAcrossRestart(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 300 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	const tok = "device-token-cooldown-01"
	if _, _, err := f.d.notifyStore.submit(tok, "", ""); err != nil {
		t.Fatal(err)
	}

	m1 := f.newTestManager(t, "", cfg)
	m1.processEvent(f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now())))
	if f.fcm.count() != 1 {
		t.Fatalf("first event must push, got %d", f.fcm.count())
	}
	f.clk.Advance(10 * time.Second)
	m1.processEvent(f.commitRecord(t, baseEvent(2, "permission_pending", f.clk.Now())))
	if f.fcm.count() != 1 {
		t.Fatalf("same-key repeat inside the cooldown window must be suppressed, got %d", f.fcm.count())
	}
	// A DIFFERENT (source,type) key is not starved by the first (v4 (i)).
	other := baseEvent(3, "permission_pending", f.clk.Now())
	other.Type = alerts.TypeFinished
	other.CooldownKey = "bason|" + alerts.TypeFinished
	f.clk.Advance(10 * time.Second)
	m1.processEvent(f.commitRecord(t, other))
	if f.fcm.count() != 2 {
		t.Fatalf("a different cooldown key must deliver, got %d", f.fcm.count())
	}

	// Controller restart: a FRESH manager loads the persisted state.
	f.clk.Advance(10 * time.Second)
	m2 := f.newTestManager(t, "", cfg)
	m2.mu.Lock()
	if m2.state.Cursor < 3 {
		t.Fatalf("restart must load the persisted cursor, got %d", m2.state.Cursor)
	}
	if len(m2.state.Cooldowns) != 2 {
		t.Fatalf("restart must load the persisted cooldowns, got %v", m2.state.Cooldowns)
	}
	m2.mu.Unlock()
	m2.processEvent(f.commitRecord(t, baseEvent(4, "permission_pending", f.clk.Now())))
	m2.processEvent(f.commitRecord(t, otherAt(f.clk.Now(), 5)))
	if f.fcm.count() != 2 {
		t.Fatalf("persisted cooldowns must suppress post-restart replays (no burst), got %d", f.fcm.count())
	}

	// Past the window the key reopens.
	f.clk.Advance(301 * time.Second)
	m2.processEvent(f.commitRecord(t, baseEvent(6, "permission_pending", f.clk.Now())))
	if f.fcm.count() != 3 {
		t.Fatalf("past the cooldown window the key must reopen, got %d", f.fcm.count())
	}
}

func otherAt(ts time.Time, seq int64) NotifyEvent {
	ev := baseEvent(seq, "session_unread", ts)
	ev.Type = alerts.TypeFinished
	ev.Kind = "session_unread"
	ev.CooldownKey = "bason|" + alerts.TypeFinished
	return ev
}

// ---------------------------------------------------------------------------
// Exactly-once attempts (v4 §3.5/§9.6)
// ---------------------------------------------------------------------------

// TestNotifyDispatch_ClaimBeforeSendCrashOmission pins the §9.6 fence: a
// crash between the durable claim and the FCM call is ONE accepted
// best-effort omission — the restart SKIPS the claimed pair (no blind
// resend, no duplicate), the cursor advances past it, and the claimed
// cooldown keeps deterministic replay semantics.
func TestNotifyDispatch_ClaimBeforeSendCrashOmission(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 300 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	const tok = "device-token-crash-0001"
	if _, _, err := f.d.notifyStore.submit(tok, "", ""); err != nil {
		t.Fatal(err)
	}

	m1 := f.newTestManager(t, "", cfg)
	m1.testAfterClaim = func() { panic("simulated crash between claim and call") }
	ev1 := f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now()))
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("the crash seam must propagate the simulated crash")
			}
		}()
		m1.processEvent(ev1)
	}()
	if f.fcm.count() != 0 {
		t.Fatalf("the crash happened BEFORE the FCM call — 0 sends allowed, got %d", f.fcm.count())
	}

	// The claim is durable on disk.
	state, err := loadNotifyDispatchFile(f.path + ".dispatch")
	if err != nil {
		t.Fatal(err)
	}
	hash := notifyTokenHash(tok)
	if _, ok := state.Attempts["1|"+hash]; !ok {
		t.Fatalf("the attempt claim must be persisted before the call, got %+v", state.Attempts)
	}
	if _, ok := state.Cooldowns["bason|waiting|"+hash]; !ok {
		t.Fatalf("the claim must also record the cooldown timestamp, got %+v", state.Cooldowns)
	}

	// Restart: the claimed pair is skipped (accepted omission — no
	// duplicate), the cursor advances, and the loop keeps working.
	m2 := f.newTestManager(t, "", cfg)
	m2.processEvent(ev1) // replay of the interrupted event: claim exists ⇒ skip
	if f.fcm.count() != 0 {
		t.Fatalf("a claimed attempt must never resend, got %d", f.fcm.count())
	}
	m2.mu.Lock()
	cursor := m2.state.Cursor
	m2.mu.Unlock()
	if cursor != ev1.ID {
		t.Fatalf("cursor after recovery = %d, want %d", cursor, ev1.ID)
	}

	// The claimed cooldown suppresses same-key replays deterministically…
	f.clk.Advance(10 * time.Second)
	m2.processEvent(f.commitRecord(t, baseEvent(2, "permission_pending", f.clk.Now())))
	if f.fcm.count() != 0 {
		t.Fatalf("the crash-claimed cooldown must suppress same-key replays, got %d", f.fcm.count())
	}
	// …and a DIFFERENT key delivers normally post-recovery.
	f.clk.Advance(10 * time.Second)
	m2.processEvent(f.commitRecord(t, otherAt(f.clk.Now(), 3)))
	if f.fcm.count() != 1 {
		t.Fatalf("post-recovery dispatch must work for other keys, got %d", f.fcm.count())
	}
}

// TestNotifyDispatch_NoDuplicateWhenCursorPersistLags pins the other crash
// window: the send COMPLETED but the cursor persist never landed — the
// durable claim (retained until the cursor passes) still fences the
// replay, so a restart cannot produce a second attempt.
func TestNotifyDispatch_NoDuplicateWhenCursorPersistLags(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 300 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	const tok = "device-token-lagcursor-1"
	if _, _, err := f.d.notifyStore.submit(tok, "", ""); err != nil {
		t.Fatal(err)
	}

	m1 := f.newTestManager(t, "", cfg)
	// The CURSOR persist fails (claims still persist — they use the real
	// path); simulate the post-send crash by reloading from disk afterwards.
	m1.persistFn = func(string, notifyDispatchFile) error {
		return errors.New("simulated cursor persist failure")
	}
	ev1 := f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now()))
	m1.processEvent(ev1)
	if f.fcm.count() != 1 {
		t.Fatalf("the send must have happened, got %d", f.fcm.count())
	}

	// "Restart": the durable cursor lagged behind; the replay of ev1 is
	// fenced by the surviving claim.
	f.clk.Advance(10 * time.Second)
	m2 := f.newTestManager(t, "", cfg)
	m2.mu.Lock()
	reloaded := m2.state.Cursor
	_, claimed := m2.state.Attempts["1|"+notifyTokenHash(tok)]
	m2.mu.Unlock()
	if reloaded != 0 || !claimed {
		t.Fatalf("test premise: durable cursor=%d claims=%v — want the lagged cursor 0 WITH the surviving claim", reloaded, claimed)
	}
	m2.processEvent(ev1)
	if f.fcm.count() != 1 {
		t.Fatalf("a surviving claim must fence the replay (no duplicate), got %d", f.fcm.count())
	}
}

// ---------------------------------------------------------------------------
// Open vocabulary (the S3-flagged obligation)
// ---------------------------------------------------------------------------

// TestNotifyDispatch_UnknownKindNonDispatchable pins the open-vocabulary
// bar: an event whose condition is outside the §9.1 enumeration is never
// dispatched, is logged ONCE per unknown kind, and the cursor still
// advances (history-only) — no panic, no silent retry loop.
func TestNotifyDispatch_UnknownKindNonDispatchable(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	m := f.newTestManager(t, "", cfg)
	if _, _, err := f.d.notifyStore.submit("device-token-unknown-0001", "", alerts.PolicyAlways); err != nil {
		t.Fatal(err)
	}

	future := baseEvent(1, "quantum_ready", f.clk.Now())
	future.Type = "quantum_ready"
	ev1 := f.commitRecord(t, future)
	m.processEvent(ev1)
	if f.fcm.count() != 0 {
		t.Fatalf("an out-of-vocabulary condition must never dispatch, got %d pushes", f.fcm.count())
	}
	m.mu.Lock()
	saw := len(m.unknownKinds)
	cursor := m.state.Cursor
	m.mu.Unlock()
	if saw != 1 || cursor != ev1.ID {
		t.Fatalf("unknown kind logged once=%d cursor=%d (want 1, %d)", saw, cursor, ev1.ID)
	}

	// A second event of the SAME unknown kind does not re-log.
	future2 := future
	future2.Seq = 2
	ev2 := f.commitRecord(t, future2)
	m.processEvent(ev2)
	m.mu.Lock()
	saw = len(m.unknownKinds)
	m.mu.Unlock()
	if saw != 1 {
		t.Fatalf("log-once-per-kind violated: %d entries", saw)
	}
	if f.fcm.count() != 0 {
		t.Fatalf("unknown kinds stay non-dispatchable, got %d pushes", f.fcm.count())
	}
}

// ---------------------------------------------------------------------------
// Pruning (v4 §3.5/§9.5)
// ---------------------------------------------------------------------------

// respondByToken scripts the fake FCM per TARGET TOKEN (the fan-out order
// across tokens is not deterministic, so per-hit scripting cannot address
// one token of many). The response is derived from the request THIS hit
// carries (hit is 1-indexed, matching the requests slice): reading the
// NEWEST recorded request instead (f.count()-1) could address a CONCURRENT
// send's request and hand another token the dead-token answer.
func respondByToken(f *fakeFCM, byTok map[string]struct {
	status int
	body   string
}) {
	f.respond = func(hit int) (int, string, http.Header) {
		last := f.request(hit - 1)
		var body struct {
			Message struct {
				Token string `json:"token"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(last.Body), &body); err != nil {
			return 200, `{}`, nil
		}
		if r, ok := byTok[body.Message.Token]; ok {
			return r.status, r.body, nil
		}
		return 200, `{}`, nil
	}
}

// TestNotifyDispatch_PruneEvidenceGated pins the UNREGISTERED evidence
// gate: a generic 404 NOT_FOUND (sender-side misconfiguration class)
// RETAINS the token; canonical UNREGISTERED evidence (details[].errorCode)
// prunes it.
func TestNotifyDispatch_PruneEvidenceGated(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}

	// Both tokens registered; responses are keyed per token so the
	// misconfiguration answer and the dead-token answer coexist.
	const tokGeneric = "device-token-generic-404"
	const tokDead = "device-token-dead-unreg"
	if _, _, err := f.d.notifyStore.submit(tokGeneric, "generic", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.d.notifyStore.submit(tokDead, "dead", ""); err != nil {
		t.Fatal(err)
	}
	respondByToken(f.fcm, map[string]struct {
		status int
		body   string
	}{
		tokGeneric: {404, `{"error":{"code":404,"message":"Requested entity was not found","status":"NOT_FOUND"}}`},
		tokDead:    {404, `{"error":{"code":404,"message":"The registration token is not registered","status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`},
	})

	m := f.newTestManager(t, "", cfg)
	m.processEvent(f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now())))
	if got := f.fcm.count(); got != 2 {
		t.Fatalf("both tokens must have been attempted, got %d", got)
	}
	snap := f.d.notifyStore.snapshot()
	if len(snap.entries) != 1 || snap.entries[0].Token != tokGeneric {
		t.Fatalf("generic 404 must RETAIN its token; canonical UNREGISTERED must prune exactly the dead one, entries=%+v", snap.entries)
	}
}

// TestNotifyDispatch_PruneGenerationBound pins v4 §9.5 generation binding:
// a stale in-flight UNREGISTERED response for a token that was pruned and
// RE-REGISTERED meanwhile must not delete the new registration.
func TestNotifyDispatch_PruneGenerationBound(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}

	const tok = "device-token-generation"
	entry, _, err := f.d.notifyStore.submit(tok, "phone", "")
	if err != nil {
		t.Fatal(err)
	}

	// The FCM response for this token BLOCKS until released, then answers
	// canonical UNREGISTERED.
	release := make(chan struct{})
	f.fcm.respond = func(int) (int, string, http.Header) {
		<-release
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}

	m := f.newTestManager(t, "", cfg)
	ev := f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now()))
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.processEvent(ev)
	}()

	// Wait for the durable claim (send in flight), then prune + re-register
	// the SAME token value (a NEW entry with a fresh id) while the response
	// is still in flight.
	hash := notifyTokenHash(tok)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		_, claimed := m.state.Attempts["1|"+hash]
		m.mu.Unlock()
		if claimed {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := func() (int64, bool) {
		m.mu.Lock()
		defer m.mu.Unlock()
		v, ok := m.state.Attempts["1|"+hash]
		return v, ok
	}(); !ok {
		t.Fatal("the claim must be durable before the send")
	}
	if _, err := f.d.notifyStore.delete(entry.ID); err != nil {
		t.Fatal(err)
	}
	re, _, err := f.d.notifyStore.submit(tok, "phone", alerts.PolicyAlways)
	if err != nil {
		t.Fatal(err)
	}
	if re.ID == entry.ID {
		t.Fatal("re-registration must be a NEW entry (fresh id) for this scenario")
	}

	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("processEvent did not finish")
	}

	// The stale response's prune is generation-bound: the re-registered
	// entry SURVIVES.
	cur, ok := f.d.notifyStore.byID(re.ID)
	if !ok || cur.Token != tok {
		t.Fatal("a stale in-flight UNREGISTERED result must not delete the re-registered token (generation binding)")
	}
}

// TestNotifyDispatch_PruneRefreshedRegistrationSurvives pins the t1a-F1
// refresh-path hole (the reviewer's exact scenario): a send claimed
// against entry E, then the SAME token re-POSTed with a refreshed
// label/policy (the submit MERGE path — SAME id, SAME token value) while
// the FCM response is still in flight, must SURVIVE the stale canonical
// UNREGISTERED response — id+token gating alone cannot fence this, the
// per-registration generation can. The positive control proves the fix
// does not over-retain: a same-generation canonical UNREGISTERED still
// prunes.
func TestNotifyDispatch_PruneRefreshedRegistrationSurvives(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}

	const tok = "device-token-refresh-gen"
	entry, _, err := f.d.notifyStore.submit(tok, "phone", "")
	if err != nil {
		t.Fatal(err)
	}

	// The FCM response for this token BLOCKS until released, then answers
	// canonical UNREGISTERED (details[].errorCode).
	release := make(chan struct{})
	f.fcm.respond = func(int) (int, string, http.Header) {
		<-release
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}

	m := f.newTestManager(t, "", cfg)
	ev := f.commitRecord(t, baseEvent(1, "permission_pending", f.clk.Now()))
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.processEvent(ev)
	}()

	// Wait for the durable claim: the send is in flight with the
	// PRE-refresh generation captured by the prune closure.
	hash := notifyTokenHash(tok)
	if !waitForNotify(2*time.Second, func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, claimed := m.state.Attempts["1|"+hash]
		return claimed
	}) {
		t.Fatal("the claim must be durable before the send")
	}

	// The REFRESH (merge path): same raw token, refreshed label+policy —
	// the administrative ID stays stable (no delete+create here, which
	// the pre-existing generation test already covers).
	refreshed, created, err := f.d.notifyStore.submit(tok, "phone refreshed", alerts.PolicyAlways)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("a re-POST of the same token must MERGE in place, not create")
	}
	if refreshed.ID != entry.ID {
		t.Fatalf("the refresh must preserve the administrative id: %q vs %q", refreshed.ID, entry.ID)
	}

	// Release the STALE response (canonical UNREGISTERED evidence, sent
	// against the pre-refresh incarnation).
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("processEvent did not finish")
	}

	// SURVIVAL: the refreshed registration is intact — same id, same raw
	// token, refreshed label AND policy.
	cur, ok := f.d.notifyStore.byID(entry.ID)
	if !ok || cur.Token != tok {
		t.Fatal("a stale in-flight UNREGISTERED result must not delete the REFRESHED registration (generation binding, t1a-F1)")
	}
	if cur.Label != "phone refreshed" || cur.PushPolicy != alerts.PolicyAlways {
		t.Fatalf("the surviving registration must be the REFRESHED incarnation, got %+v", cur)
	}

	// POSITIVE CONTROL — same-generation canonical UNREGISTERED still
	// prunes: a fresh send claimed against the CURRENT incarnation.
	f.clk.Advance(61 * time.Second) // clear event 1's cooldown claim
	ev2 := f.commitRecord(t, baseEvent(2, "permission_pending", f.clk.Now()))
	m.processEvent(ev2) // synchronous: the send+prune complete before it returns
	if _, ok := f.d.notifyStore.byID(entry.ID); ok {
		t.Fatal("a same-generation canonical UNREGISTERED must still prune the registration")
	}
}

// blockingFetchClient parks every feed fetch until released, reporting the
// loop ctx's cancellation first. It is the deterministic anchor for the
// reload-ordering test: StopNotifyIngest is the FIRST statement of
// LoadNotifyStore in both the pre-fix and the fixed order, and its cancel
// is observable here from inside the parked pull — proving the reload
// goroutine has ENTERED the stop-join (and, under the pre-fix read-first
// order, that the registry read already completed).
type blockingFetchClient struct {
	started   chan struct{}
	cancelled chan struct{}
	release   chan struct{}

	// startOnce/cancelOnce guard the channel closes: after the test
	// releases the parked fetch, Run's post-sweep select may legitimately
	// pick the ready TICKER over the ready ctx.Done and launch another
	// sweep — a late pull re-enters the fetch with the ctx already
	// cancelled and must not re-close (it returns immediately instead).
	startOnce  sync.Once
	cancelOnce sync.Once
}

func newBlockingFetchClient() *blockingFetchClient {
	return &blockingFetchClient{
		started:   make(chan struct{}),
		cancelled: make(chan struct{}),
		release:   make(chan struct{}),
	}
}

func (c *blockingFetchClient) FetchNotifyFeedPage(ctx context.Context, _ *Worker, _ string, _ int64, _ int, _ time.Duration, _ int64) ([]byte, error) {
	c.startOnce.Do(func() { close(c.started) })
	// Park until the reload's StopNotifyIngest cancels the loop ctx, then
	// keep parking until the test releases — the join cannot drain while
	// the pull goroutine sits in this fetch. (Late post-release re-entries
	// find both channels already closed and return at once.)
	<-ctx.Done()
	c.cancelOnce.Do(func() { close(c.cancelled) })
	<-c.release
	return nil, ctx.Err()
}

func (c *blockingFetchClient) PostNotifyAck(context.Context, *Worker, string, int64, time.Duration, int64) ([]byte, error) {
	return []byte(`{"ok":true}`), nil
}

// TestNotifyDispatch_ReloadDoesNotResurrectPrunedToken pins the t1b-F1
// reload-vs-prune ordering invariant: LoadNotifyStore quiesces + JOINS the
// ingest and dispatch loops BEFORE reading the registry file, so a send
// whose canonical-UNREGISTERED prune lands while a reload is in flight can
// never be resurrected by the snapshot the reload installs. Deterministic
// choreography (no sleeps): the send parks at the fake FCM; the reload
// parks inside StopNotifyIngest joining a parked feed fetch (its cancel is
// observed from inside the fetch); the UNREGISTERED answer is released
// INTO that window — the prune durably retires the token while the reload
// is still parked in the join — then the join drains and the reload
// completes. The token must be absent in memory AND absent from the disk
// after persisting the installed registry and fresh-reloading the file.
// Under the pre-fix read-before-join order the reload's snapshot was
// captured before the prune, and setLoaded resurrected the entry here.
func TestNotifyDispatch_ReloadDoesNotResurrectPrunedToken(t *testing.T) {
	f := newDispatchFixture(t)
	const tok = "device-token-reload-prune"
	if _, _, err := f.d.notifyStore.submit(tok, "phone", ""); err != nil {
		t.Fatal(err)
	}

	// The ingest anchor: a pull loop over a parked feed fetch, installed
	// on the daemon exactly as StartNotifyIngest would (the fake
	// fleet/client stand in for Registry/Proxy — only lane-3 needs those).
	client := newBlockingFetchClient()
	enroll(t, f.d.notifySources, "wrk", "e1", "feed-token-reload-anchor")
	fleet := &fakeFleet{online: map[string]bool{"wrk": true}}
	mgr := newNotifyIngestManager(f.d.ledger(), f.d.notifySources, fleet, client, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})
	ictx, icancel := context.WithCancel(context.Background())
	f.d.notifyIngestMu.Lock()
	f.d.notifyIngest = mgr
	f.d.notifyIngestCancel = icancel
	f.d.notifyIngestMu.Unlock()
	go mgr.Run(ictx)
	t.Cleanup(f.d.StopNotifyIngest) // idempotent; the reload's stop drains it
	select {
	case <-client.started:
	case <-time.After(2 * time.Second):
		t.Fatal("the ingest pull never reached its fetch")
	}

	// The blocked-response send: canonical UNREGISTERED evidence on
	// release (the S4 blocked-response pattern).
	release := make(chan struct{})
	f.fcm.respond = func(int) (int, string, http.Header) {
		<-release
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`, nil
	}
	if err := f.d.StartNotifyDispatch(NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600, PollInterval: 10 * time.Millisecond}, f.trans); err != nil {
		t.Fatalf("StartNotifyDispatch: %v", err)
	}
	t.Cleanup(f.d.StopNotifyDispatch) // idempotent; the reload's stop drains it
	f.commitRecord(t, baseEvent(1, "permission_pending", time.Now()))
	if !waitForNotify(2*time.Second, func() bool { return f.fcm.count() == 1 }) {
		t.Fatal("the send must be in flight (parked at the fake FCM)")
	}

	// Begin the reload; it parks inside the stop-join (the ingest fetch is
	// still parked). Under the pre-fix order the registry snapshot was
	// captured BEFORE this point; under the fix it has not been read yet.
	reloadDone := make(chan error, 1)
	go func() { reloadDone <- f.d.LoadNotifyStore(f.path) }()
	select {
	case <-client.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("LoadNotifyStore never entered its stop-join")
	}

	// Release the canonical UNREGISTERED answer INTO the reload window:
	// the prune durably retires the token while the reload is parked.
	close(release)
	// Drain the join: let the parked feed fetch return so the reload can
	// complete against post-prune state.
	close(client.release)
	select {
	case err := <-reloadDone:
		if err != nil {
			t.Fatalf("LoadNotifyStore: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LoadNotifyStore did not return")
	}
	f.d.notifyStore.flushSendResults()

	// MEMORY: the confirmed-UNREGISTERED token must be absent — the
	// installed snapshot post-dates the joined prune.
	snap := f.d.notifyStore.snapshot()
	for _, e := range snap.entries {
		if e.Token == tok {
			t.Fatalf("the confirmed-UNREGISTERED token %q is RESURRECTED in memory after reload (t1b-F1: the installed snapshot must post-date the joined prune)", tok)
		}
	}

	// DISK: persist the installed registry, then fresh-reload the file —
	// no resurrection may reach the disk either.
	f.d.notifyStore.mu.Lock()
	perr := f.d.notifyStore.persistLocked()
	f.d.notifyStore.mu.Unlock()
	if perr != nil {
		t.Fatalf("persist installed registry: %v", perr)
	}
	disk, err := loadNotifyStoreFile(f.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range disk.Tokens {
		if e.Token == tok {
			t.Fatalf("the confirmed-UNREGISTERED token %q is RESURRECTED on disk after persist+reload (t1b-F1)", tok)
		}
	}
}

// blockingWatcherNotifier parks every watcher Send until released. The
// FIXED order is observable from INSIDE the parked send (the
// blockingFetchClient pattern applied to the transport seam): when the
// tick ctx is cancelled — StopNotifyWatcher's cancel — the `cancelled`
// channel closes, proving the reload goroutine has ENTERED the watcher
// stop-join, and the send keeps parking through the cancellation until
// released (the prune must land INSIDE the join window, not be aborted
// by it). In the pre-fix order nobody ever cancels the ctx, so the send
// simply completes on the release. On completion it answers canonical
// UNREGISTERED evidence.
type blockingWatcherNotifier struct {
	started   chan struct{}
	cancelled chan struct{}
	release   chan struct{}

	// startOnce/cancelOnce guard the channel closes against a second
	// Send (defensive — the choreography enqueues exactly one).
	startOnce  sync.Once
	cancelOnce sync.Once
}

func newBlockingWatcherNotifier() *blockingWatcherNotifier {
	return &blockingWatcherNotifier{
		started:   make(chan struct{}),
		cancelled: make(chan struct{}),
		release:   make(chan struct{}),
	}
}

func (b *blockingWatcherNotifier) Name() string { return "blocking-watcher" }

func (b *blockingWatcherNotifier) Send(ctx context.Context, _ string, _ NotifyMessage) error {
	b.startOnce.Do(func() { close(b.started) })
	select {
	case <-ctx.Done():
		b.cancelOnce.Do(func() { close(b.cancelled) })
		<-b.release
	case <-b.release:
		// Pre-fix arm: no stop-join exists, so no cancel ever arrives —
		// the send completes on the release alone.
	}
	return &NotifyUnregisteredError{Detail: "blocking-watcher scripted UNREGISTERED"}
}

// TestNotifyWatcher_ReloadDoesNotResurrectPrunedToken pins B-F1 (the
// reviewer's third-writer data-integrity hole): LoadNotifyStore must
// quiesce + JOIN the legacy fleet watcher — alongside ingest and dispatch
// — BEFORE reading the registry file. The watcher's fan-out sends carry
// the same generation-fenced UNREGISTERED prune as the dispatcher's;
// without the stop-join, an in-flight watcher send whose canonical
// UNREGISTERED answer lands while a reload is running lets the reload's
// PRE-JOIN snapshot resurrect the durably-retired token (RegGen cannot
// fence installing an OLDER snapshot after a COMPLETED prune).
// Deterministic choreography (no sleeps), mirroring the dispatcher-side
// TestNotifyDispatch_ReloadDoesNotResurrectPrunedToken: the watcher send
// parks inside the blocking notifier; the reload either parks inside
// StopNotifyWatcher's join (its cancel observed from inside the parked
// send — the fixed order) or completes without ever joining the loop
// (the pre-fix order, detected here); the UNREGISTERED answer is
// released INTO that window; the token must be absent in memory AND
// absent from the disk after persisting the installed registry and
// fresh-reloading the file. Red-check: removing the StopNotifyWatcher
// call from LoadNotifyStore fails this test at the memory assertion (the
// pre-fix arm below).
func TestNotifyWatcher_ReloadDoesNotResurrectPrunedToken(t *testing.T) {
	f := newDispatchFixture(t)
	const tok = "device-token-watcher-reload-prune"
	if _, _, err := f.d.notifyStore.submit(tok, "phone", ""); err != nil {
		t.Fatal(err)
	}

	// The fleet seam + watcher run loop, installed on the daemon exactly
	// as StartNotifyWatcher would (10ms interval, 40ms cache TTL — the
	// NobodyPolls posture: the background loop refreshes past the TTL on
	// its own cadence). The transport is the blocking notifier, so the
	// appeared-transition send parks deterministically.
	b := newBlockingWatcherNotifier()
	f.d.SetNotifyTransport(b)
	fake := newFleetFake()
	f.d.fetchWorkerJSON = fake.fetch
	fleetAddOnline(t, f.d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	f.d.fleetStatus.budgets.TTL = 40 * time.Millisecond
	w := newNotifyWatcher(f.d, 10*time.Millisecond, 0)
	wctx, wcancel := context.WithCancel(context.Background())
	f.d.notifyWatcherMu.Lock()
	f.d.notifyWatcher = w
	f.d.notifyWatcherCancel = wcancel
	f.d.notifyWatcherMu.Unlock()
	go w.run(wctx)
	t.Cleanup(wcancel) // the pre-fix arm never joins the loop; stop the leak

	// Baseline adoption (the first tick is silent), then the transition.
	if !waitForNotify(2*time.Second, func() bool { return f.d.fleetStatusService().refreshCount() >= 1 }) {
		t.Fatal("the watcher never produced its baseline generation")
	}
	setWorkerPerm(fake, "alpha", "/repo", 1) // appeared → dispatch → Send parks
	select {
	case <-b.started:
	case <-time.After(2 * time.Second):
		t.Fatal("the watcher send never parked at the blocking notifier")
	}

	// Begin the reload. FIXED order: it parks inside StopNotifyWatcher's
	// join (cancel observed from inside the parked send; the join cannot
	// drain while the tick waits on the parked send). PRE-FIX order: no
	// watcher stop exists, so it completes having never joined the loop.
	reloadDone := make(chan error, 1)
	go func() { reloadDone <- f.d.LoadNotifyStore(f.path) }()
	var joined bool
	select {
	case <-b.cancelled:
		joined = true
	case err := <-reloadDone:
		if err != nil {
			t.Fatalf("LoadNotifyStore: %v", err)
		}
		// The pre-fix arm: the reload already installed its snapshot
		// while the send was still parked (the prune had not landed).
	}

	// Release the canonical UNREGISTERED answer INTO the window: under
	// the fix the prune durably retires the token while the reload is
	// still parked in the join; under the pre-fix order it lands against
	// the already-installed snapshot. (In the pre-fix arm the reload has
	// ALREADY completed — its result was consumed above — so only the
	// joined arm waits for it here.)
	close(b.release)
	if joined {
		select {
		case err := <-reloadDone:
			if err != nil {
				t.Fatalf("LoadNotifyStore: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("LoadNotifyStore did not return (the watcher stop-join never drained)")
		}
	}
	f.d.notifyStore.flushSendResults()
	// Join the tick's history append before returning (pre-fix arm
	// hygiene: the loop keeps running there; a late append would race
	// t.TempDir's cleanup against the history persist).
	if !waitForNotify(2*time.Second, func() bool { return len(f.d.notifyHistory.queryAllForTest()) >= 1 }) {
		t.Fatal("the pushed transition never reached the history store")
	}

	// MEMORY: the confirmed-UNREGISTERED token must be absent — the
	// installed snapshot post-dates the joined prune. (The pre-fix arm
	// fails HERE: the reload installed the pre-prune snapshot, so the
	// dead token survived the reload.)
	snap := f.d.notifyStore.snapshot()
	for _, e := range snap.entries {
		if e.Token == tok {
			t.Fatalf("the confirmed-UNREGISTERED token %q is present in memory after reload (B-F1: LoadNotifyStore must stop-join the legacy watcher before the registry read; joined=%v)", tok, joined)
		}
	}

	// DISK: persist the installed registry, then fresh-reload the file —
	// no resurrection may reach the disk either.
	f.d.notifyStore.mu.Lock()
	perr := f.d.notifyStore.persistLocked()
	f.d.notifyStore.mu.Unlock()
	if perr != nil {
		t.Fatalf("persist installed registry: %v", perr)
	}
	disk, err := loadNotifyStoreFile(f.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range disk.Tokens {
		if e.Token == tok {
			t.Fatalf("the confirmed-UNREGISTERED token %q is present on disk after persist+reload (B-F1)", tok)
		}
	}
	if !joined {
		t.Fatal("CHOREOGRAPHY: the reload completed without ever joining the watcher loop — the StopNotifyWatcher call is missing from LoadNotifyStore (B-F1)")
	}
}

// ---------------------------------------------------------------------------
// Poison = FATAL (GF2/c-F1) — dispatch loop AND the ingest pull loop
// ---------------------------------------------------------------------------

// poisonLedger forces the b-F4 sticky-fatal condition through the S3 test
// seams: a short write followed by a FAILING rollback truncate.
func poisonLedger(t *testing.T, led *notifyLedger) {
	t.Helper()
	led.testWrite = func(f *os.File, b []byte) (int, error) { return 5, nil } // short write, nil error
	led.testTruncate = func(f *os.File, size int64) error { return errors.New("simulated rollback failure") }
}

// TestNotifyDispatch_PoisonedLedgerHaltsFatally pins the dispatch-loop
// caller of the GF2/c-F1 trigger: a poisoned ledger stops the dispatcher
// FATALY (loud log, Run exits, done closes) — never a silent retry loop.
func TestNotifyDispatch_PoisonedLedgerHaltsFatally(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600, PollInterval: 10 * time.Millisecond}
	m := f.newTestManager(t, "", cfg)
	if _, _, err := f.d.notifyStore.submit("device-token-poison-0001", "", alerts.PolicyAlways); err != nil {
		t.Fatal(err)
	}

	// Poison the journal, then commit (the commit fails into the poisoned
	// state) and run the pass: the health check classifies FATAL before
	// any dispatch.
	led := f.d.ledger()
	poisonLedger(t, led)
	if _, err := led.CommitPage(notifyPageCommit{
		SourceID: "bason", WorkerID: "bason", WorkerName: "bason", Epoch: "e1",
		Records:   []NotifyEvent{baseEvent(1, "permission_pending", f.clk.Now())},
		AdvanceTo: 1,
	}); err == nil {
		t.Fatal("the poisoned commit must fail")
	}
	if !errors.Is(led.Health(), ErrNotifyLedgerPoisoned) {
		t.Fatalf("Health() must carry ErrNotifyLedgerPoisoned, got %v", led.Health())
	}

	// Run the real loop: it must exit (done closes) and never send.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)
	select {
	case <-m.done:
	case <-time.After(2 * time.Second):
		t.Fatal("a poisoned ledger must stop the dispatch loop (Run must exit)")
	}
	if !m.isFatal() {
		t.Fatal("the manager must record the fatal stop")
	}
	if f.fcm.count() != 0 {
		t.Fatalf("a fatal stop must dispatch nothing, got %d pushes", f.fcm.count())
	}
}

// TestNotifyIngest_PoisonedLedgerStopsLoopWithoutBackoff pins the INGEST
// caller of the GF2/c-F1 trigger: a commit that fails into the poisoned
// state classifies FATAL — the loop stops, the failure NEVER reaches the
// per-source backoff.
func TestNotifyIngest_PoisonedLedgerStopsLoopWithoutBackoff(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "notify-store.json")
	led, err := armNotifyLedger(storePath, storePath+".sources", 0)
	if err != nil {
		t.Fatalf("armNotifyLedger: %v", err)
	}
	t.Cleanup(func() { _ = led.Close() })

	reg := newNotifySourceRegistry()
	enroll(t, reg, "wrk", "e1", "feed-token-0123456789abcdef")
	fleet := &fakeFleet{online: map[string]bool{"wrk": true}}
	client := newFakeNotifyFeedClient()
	client.queue("wrk", pageResp("wrk", "e1", 1, 1, srec(1, alerts.TypeWaiting, alerts.KindPermission, "s1")))
	mgr := newNotifyIngestManager(led, reg, fleet, client, NotifyIngestConfig{PollInterval: 10 * time.Millisecond})

	// Poison the journal BEFORE the pull: the page's commit fails into the
	// sticky-fatal state, and the failure must classify FATAL.
	poisonLedger(t, led)
	mgr.tickOnce(context.Background())

	if !mgr.isFatal() {
		t.Fatal("a poisoned commit must stop the ingest loop fatally")
	}
	mgr.mu.Lock()
	failN, eligible := len(mgr.failN), len(mgr.eligibleAt)
	mgr.mu.Unlock()
	if failN != 0 || eligible != 0 {
		t.Fatalf("poison must NOT feed per-source backoff: failN=%d eligibleAt=%d", failN, eligible)
	}
	// The next sweep does nothing.
	mgr.tickOnce(context.Background())
	if fetches, _ := client.calls(); len(fetches) != 1 {
		t.Fatalf("a fatally stopped loop must not pull again, fetches=%v", fetches)
	}
}

// ---------------------------------------------------------------------------
// c-F2/d-F1: the synchronized ledger pointer
// ---------------------------------------------------------------------------

// TestNotifyLedgerPointerSwapRace pins the synchronized d.notifyLedger
// access: LoadNotifyStore's re-arm (write) races concurrent ledger reads
// (the dispatch loop's wiring) — with the RWMutex in place this test is
// race-detector clean; before S4 the bare pointer swap was a data race.
func TestNotifyLedgerPointerSwapRace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")
	d := NewDaemon(":0", ":0", "")
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	// Seed one event so the readers have content to page.
	if _, err := d.ledger().CommitPage(notifyPageCommit{
		SourceID: "bason", WorkerID: "bason", WorkerName: "bason", Epoch: "e1",
		Records:   []NotifyEvent{baseEvent(1, "permission_pending", time.Now())},
		AdvanceTo: 1,
	}); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() { // the dispatch-loop-shaped reader
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = d.NotifyLedgerHead()
			_ = d.NotifyEventsSince(0, 10)
			_ = d.NotifyCoverage()
		}
	}()
	for i := 0; i < 25; i++ { // controller-restart-shaped re-arms
		if err := d.LoadNotifyStore(path); err != nil {
			t.Fatalf("re-arm %d: %v", i, err)
		}
	}
	close(stop)
	wg.Wait()
}

// ---------------------------------------------------------------------------
// The golden FCM message shape (fcm_message_v4.json)
// ---------------------------------------------------------------------------

// TestNotifyDispatch_FCMMessageGoldenShape pins the DISPATCHED message
// byte-shape against the golden fixture fcm_message_v4.json (modulo the
// configured url/token/history id): all ten vh_* data keys, string values,
// waiting→HIGH priority, collapse-by-event, TTL "<n>s", and no
// notification block.
func TestNotifyDispatch_FCMMessageGoldenShape(t *testing.T) {
	f := newDispatchFixture(t)
	cfg := NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600}
	m := f.newTestManager(t, "$ID.example.com", cfg)

	// The clock sits 1h after the golden event's detection ts: fresh (not
	// stale), with 23h of remaining freshness — more than the configured
	// 3600s TTL, so the sent TTL is exactly the golden "3600s".
	goldenTs := int64(1792454400000)
	f.clk.t = time.UnixMilli(goldenTs).Add(time.Hour)

	ev := NotifyEvent{
		ID: 41, Type: alerts.TypeWaiting, Kind: "question_pending",
		SessionID: "ses_example", Root: "ses_root", Project: "/workspace/example",
		Title: "Review requested", Detail: "Question pending",
		Ts:  goldenTs, // the golden fixture's vh_ts
		Seq: 1, Epoch: "e1",
		WorkerID: "bason", WorkerName: "bason",
		Attended: false, ProfileEligible: true, CooldownKey: "bason|waiting",
	}
	const tok = "device-token-golden-shape"
	if _, _, err := f.d.notifyStore.submit(tok, "golden", ""); err != nil {
		t.Fatal(err)
	}
	committed := f.commitRecord(t, ev)
	m.processEvent(committed)
	if f.fcm.count() != 1 {
		t.Fatalf("the golden event must dispatch, got %d", f.fcm.count())
	}

	var sent map[string]any
	if err := json.Unmarshal([]byte(f.fcm.request(0).Body), &sent); err != nil {
		t.Fatalf("sent body: %v", err)
	}
	golden := loadV4Fixture(t, "fcm_message_v4.json")

	// Normalize the legitimately-configured values onto the sent shape:
	// device token, history id (the ledger assigned 1), and the worker URL
	// derived from OUR host pattern (the golden uses worker.example).
	msg := sent["message"].(map[string]any)
	gMsg := golden["message"].(map[string]any)
	data := msg["data"].(map[string]any)
	gData := gMsg["data"].(map[string]any)
	// The URL we DID send must be the controller-configured derivation
	// (host pattern, session + dir query params — never a feed URL) —
	// asserted BEFORE the normalization below substitutes the golden's
	// configured values for the shape comparison.
	if want := "https://bason.example.com/app?dir=%2Fworkspace%2Fexample&session=ses_example"; data["vh_ui_url"] != want {
		t.Errorf("vh_ui_url sent = %v, want the controller-derived %q", data["vh_ui_url"], want)
	}
	// Normalize the legitimately-configured values onto the sent shape:
	// device token, history id (the ledger assigned 1), and the golden's
	// worker host.
	msg["token"] = gMsg["token"]
	data["vh_history_id"] = gData["vh_history_id"]
	data["vh_ui_url"] = gData["vh_ui_url"]
	if _, has := msg["notification"]; has {
		t.Error("the message must be data-only (no notification block)")
	}
	if !deepEqualJSON(msg, gMsg) {
		t.Fatalf("dispatched message shape drifted from the golden fixture:\nsent:   %s\ngolden: %s", mustJSON(msg), mustJSON(gMsg))
	}

	// Daemon-level notice (worker_down): empty sessionID/root by design,
	// the link is the worker's /app root, and priority is NORMAL.
	f.clk.Advance(61 * time.Second)
	daemon := NotifyEvent{
		Type: alerts.TypeStalled, Kind: "worker_down",
		Title: "OpenCode", Ts: f.clk.Now().UnixMilli(),
		Seq: 2, Epoch: "e1", WorkerID: "bason", WorkerName: "bason",
		Attended: false, ProfileEligible: true, CooldownKey: "bason|stalled",
	}
	committed2 := f.commitRecord(t, daemon)
	m.processEvent(committed2)
	if f.fcm.count() != 2 {
		t.Fatalf("the daemon-level event must dispatch, got %d", f.fcm.count())
	}
	var dm struct {
		Message struct {
			Data    map[string]string `json:"data"`
			Android *struct {
				Priority string `json:"priority"`
			} `json:"android"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(f.fcm.request(1).Body), &dm); err != nil {
		t.Fatal(err)
	}
	if dm.Message.Data["vh_session_id"] != "" {
		t.Errorf("daemon-level vh_session_id = %q, want empty by design", dm.Message.Data["vh_session_id"])
	}
	if want := "https://bason.example.com/app"; dm.Message.Data["vh_ui_url"] != want {
		t.Errorf("daemon-level vh_ui_url = %q, want the worker /app root %q", dm.Message.Data["vh_ui_url"], want)
	}
	if dm.Message.Android.Priority != "NORMAL" {
		t.Errorf("worker_down priority = %q, want NORMAL (only waiting is HIGH)", dm.Message.Android.Priority)
	}
}

// deepEqualJSON compares two decoded-JSON shapes (map/slice/scalar).
func deepEqualJSON(a, b any) bool {
	ab, aerr := json.Marshal(a)
	bb, berr := json.Marshal(b)
	return aerr == nil && berr == nil && string(ab) == string(bb)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// ---------------------------------------------------------------------------
// The public probe over the armed dispatcher
// ---------------------------------------------------------------------------

// TestNotifyDispatch_ProbeEnabledWithDispatcher pins the v4 probe through
// the real HTTP chain: enabled flips true only when the central dispatcher
// is armed, counts/policies track the registry, and the
// latest-completed-attempt pair (last_attempt/last_error) reflects the
// central sender — success clears last_error, failure publishes the
// sanitized summary.
func TestNotifyDispatch_ProbeEnabledWithDispatcher(t *testing.T) {
	f, h, session := newAuthDispatchFixture(t)

	// Before arming: enabled=false (the store is configured; count 0).
	rec := doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
	var probe notifyProbeView
	_ = json.Unmarshal(rec.Body.Bytes(), &probe)
	if probe.Enabled {
		t.Fatal("probe must report enabled:false before the dispatcher is armed")
	}

	// Register through the real route, then arm.
	if rec := doNotify(t, h, http.MethodPost, "/vh/notify/tokens",
		`{"token":"device-token-probe-0001","label":"probe phone","push_policy":"always"}`, withCookie(session), withCSRF()); rec.Code != http.StatusOK {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	if err := f.d.StartNotifyDispatch(NotifyDispatchConfig{Cooldown: 60 * time.Second, StaleAfter: 24 * time.Hour, TTLSec: 3600, PollInterval: 10 * time.Millisecond}, f.trans); err != nil {
		t.Fatalf("StartNotifyDispatch: %v", err)
	}
	t.Cleanup(f.d.StopNotifyDispatch)

	// A committed event flows through the REAL loop to the fake FCM.
	if _, err := f.d.ledger().CommitPage(notifyPageCommit{
		SourceID: "bason", WorkerID: "bason", WorkerName: "bason", Epoch: "e1",
		Records:   []NotifyEvent{baseEvent(1, "question_pending", time.Now())},
		AdvanceTo: 1,
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f.fcm.count() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if f.fcm.count() != 1 {
		t.Fatal("the armed dispatcher must deliver the committed event")
	}

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
		_ = json.Unmarshal(rec.Body.Bytes(), &probe)
		if probe.Enabled && probe.LastAttempt != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !probe.Enabled {
		t.Fatalf("probe must report enabled:true with the dispatcher armed: %+v", probe)
	}
	if probe.Count != 1 || probe.Policies[alerts.PolicyAlways] != 1 || probe.Policies[alerts.PolicyWhenUnattended] != 0 {
		t.Fatalf("probe counts = %+v, want count 1 / always 1 / wu 0", probe)
	}
	if probe.LastAttempt == "" || probe.LastError != "" {
		t.Fatalf("a completed successful attempt must publish last_attempt with empty last_error: %+v", probe)
	}

	// A failing attempt publishes the sanitized summary (5xx → retried
	// once → failure), and the token is retained.
	f.fcm.respond = func(int) (int, string, http.Header) {
		return 500, `{"error":{"code":500,"status":"INTERNAL"}}`, nil
	}
	if _, err := f.d.ledger().CommitPage(notifyPageCommit{
		SourceID: "bason", WorkerID: "bason", WorkerName: "bason", Epoch: "e1",
		Records:   []NotifyEvent{otherAt(time.Now(), 2)},
		AdvanceTo: 2,
	}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec = doNotify(t, h, http.MethodGet, "/vh/notify/tokens", "", withCookie(session))
		_ = json.Unmarshal(rec.Body.Bytes(), &probe)
		if probe.LastError != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if probe.LastError == "" {
		t.Fatalf("a failed attempt must publish the sanitized last_error: %+v", probe)
	}
	if len(probe.LastError) == 0 || len(probe.LastError) > 200 {
		t.Errorf("last_error must stay sanitized/short: %q", probe.LastError)
	}
	if snap := f.d.notifyStore.snapshot(); len(snap.entries) != 1 {
		t.Fatalf("a 5xx failure must retain the token, entries=%d", len(snap.entries))
	}
}
