package alerts

// notify_test.go — lane-1 tests for the FCM HTTP v1 notify sender
// (pkg/alerts/notify.go): mock token + FCM servers, real RSA service-account
// credentials, the OAuth2 JWT flow, the data-only message contract, delivery
// gating (mirroring Web Push), UNREGISTERED pruning, token caching, and
// init-failure → channel-disabled semantics.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// --- mocks ---

// tokenExchange is one captured OAuth2 token-endpoint request.
type tokenExchange struct {
	GrantType string
	Assertion string
}

type tokenMock struct {
	mu   sync.Mutex
	reqs []tokenExchange
}

func (m *tokenMock) add(grant, assertion string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reqs = append(m.reqs, tokenExchange{GrantType: grant, Assertion: assertion})
}

func (m *tokenMock) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.reqs)
}

func (m *tokenMock) last() tokenExchange {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reqs[len(m.reqs)-1]
}

// fcmRequestBody is the FCM HTTP v1 request body as the tests read it.
// Message.Data decodes into map[string]string — a non-string data value
// fails the decode, which is exactly the all-strings contract.
type fcmRequestBody struct {
	Message struct {
		Token   string            `json:"token"`
		Data    map[string]string `json:"data"`
		Android *struct {
			Priority    string `json:"priority"`
			CollapseKey string `json:"collapse_key"`
			TTL         string `json:"ttl"`
		} `json:"android"`
	} `json:"message"`
}

type fcmReceipt struct {
	Path          string
	Authorization string
	Raw           []byte
	Body          fcmRequestBody
}

// fcmMock captures every request and answers via a configurable responder
// (indexed by request order).
type fcmMock struct {
	mu       sync.Mutex
	count    int
	receipts chan fcmReceipt
	respond  func(n int) (status int, body string)
	// respondToken, when set, wins over respond and keys on the TARGET
	// TOKEN — for tests where the per-token outcome must be deterministic
	// (fan-out order is not).
	respondToken func(token string) (status int, body string)
}

func newFCMMock() *fcmMock {
	return &fcmMock{
		receipts: make(chan fcmReceipt, 32),
		respond:  func(int) (int, string) { return http.StatusOK, "{}" },
	}
}

func (m *fcmMock) setRespond(f func(n int) (int, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.respond = f
}

func (m *fcmMock) setRespondToken(f func(token string) (int, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.respondToken = f
}

func (m *fcmMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	rec := fcmReceipt{Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), Raw: b}
	_ = json.Unmarshal(b, &rec.Body)
	m.mu.Lock()
	m.count++
	status, body := m.respond(m.count)
	if m.respondToken != nil {
		status, body = m.respondToken(rec.Body.Message.Token)
	}
	m.mu.Unlock()
	m.receipts <- rec
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func (m *fcmMock) waitNext(t *testing.T) fcmReceipt {
	t.Helper()
	select {
	case r := <-m.receipts:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("no FCM request arrived within 2s")
		return fcmReceipt{}
	}
}

func (m *fcmMock) assertNoRequest(t *testing.T, context string) {
	t.Helper()
	select {
	case r := <-m.receipts:
		t.Fatalf("unexpected FCM request (%s): %+v", context, r.Body)
	case <-time.After(300 * time.Millisecond):
	}
}

func (m *fcmMock) requests() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.count
}

func eventually(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(msg)
}

// --- fixture ---

// notifyFixture wires a real Notifier against a mock OAuth2 token endpoint
// (from the credentials file's token_uri) and a mock FCM API (via the
// package-internal fcmBase override). The notifier's clock is a frozen
// fakeClock so cooldown/expiry behavior is deterministic.
type notifyFixture struct {
	cfg    *Store
	pres   *Presence
	tokens *TokenRegistry
	nt     *Notifier
	fcm    *fcmMock
	tmu    *tokenMock
	priv   *rsa.PrivateKey
	clk    *fakeClock
	dir    string // state dir — registry/history reload assertions
}

func newNotifyFixture(t *testing.T) *notifyFixture {
	return newNotifyFixtureExpiry(t, 3600)
}

// newNotifyFixtureExpiry is newNotifyFixture with a configurable OAuth
// expires_in (seconds) — the token-cache boundary tests drive the frozen
// clock across the 5-min-early refresh edge with a short-lived token.
func newNotifyFixtureExpiry(t *testing.T, expiresIn int) *notifyFixture {
	t.Helper()
	dir := t.TempDir()

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa keygen: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})

	tmu := &tokenMock{}
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		tmu.add(r.PostFormValue("grant_type"), r.PostFormValue("assertion"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"access_token":"test-access-token","expires_in":%d,"token_type":"Bearer"}`, expiresIn)))
	}))
	t.Cleanup(tokenSrv.Close)

	creds := map[string]string{
		"type":         "service_account",
		"project_id":   "proj-42",
		"private_key":  string(pemKey),
		"client_email": "bot@proj-42.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
		"client_id":    "1234",
	}
	cj, _ := json.Marshal(creds)
	credsPath := filepath.Join(dir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, cj, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	c := cfg.Get()
	c.Notify = &NotifyConfig{CredentialsFile: credsPath, ProjectID: "proj-42", TtlSec: 3600}
	if err := cfg.Replace(c); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	pres := NewPresence()
	tokens := NewTokenRegistry(dir)
	fcm := newFCMMock()
	fcmSrv := httptest.NewServer(fcm)
	t.Cleanup(fcmSrv.Close)

	nt, err := NewNotifier(cfg, pres, tokens)
	if err != nil {
		t.Fatalf("NewNotifier: %v", err)
	}
	nt.fcmBase = fcmSrv.URL
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	nt.now = clk.Now
	// Default the fixture logger to a discard handler: failure-path tests
	// without a captureLogger call would otherwise write real warn lines to
	// the test run's stderr (production default is vhlog's shared logger).
	nt.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	return &notifyFixture{cfg: cfg, pres: pres, tokens: tokens, nt: nt, fcm: fcm, tmu: tmu, priv: priv, clk: clk, dir: dir}
}

// notice is a small builder for distinct test notices (distinct types dodge
// the per-(type, token) cooldown).
func notice(typ, kind string, ts int64) Notice {
	return Notice{Type: typ, Kind: kind, SessionID: "s1", Root: "s1", Project: "proj", Title: "T", Detail: "d", Ts: ts}
}

// --- OAuth2 JWT flow ---

// TestNotifierJWTFlow pins the service-account token exchange: the correct
// grant_type, an RS256 JWT with the contract claims (iss=client_email,
// scope=firebase.messaging, aud=token_uri, exp=iat+1h), and a signature that
// verifies against the credentials' public key.
func TestNotifierJWTFlow(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "", ""); err != nil {
		t.Fatal(err)
	}
	f.nt.Send(notice(TypeFinished, "", 1))

	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 1 {
		t.Fatalf("token exchanges = %d, want 1", got)
	}
	ex := f.tmu.last()
	if ex.GrantType != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
		t.Fatalf("grant_type = %q, want jwt-bearer", ex.GrantType)
	}

	parts := strings.Split(ex.Assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion is not a 3-part JWT: %q", ex.Assertion)
	}
	hdr, err := b64urlDecode(parts[0])
	if err != nil {
		t.Fatalf("jwt header decode: %v", err)
	}
	var h struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(hdr, &h); err != nil || h.Alg != "RS256" || h.Typ != "JWT" {
		t.Fatalf("jwt header = %s (%v)", hdr, err)
	}
	clm, err := b64urlDecode(parts[1])
	if err != nil {
		t.Fatalf("jwt claims decode: %v", err)
	}
	var c struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Iat   int64  `json:"iat"`
		Exp   int64  `json:"exp"`
	}
	if err := json.Unmarshal(clm, &c); err != nil {
		t.Fatalf("jwt claims parse: %v (%s)", err, clm)
	}
	if c.Iss != "bot@proj-42.iam.gserviceaccount.com" {
		t.Errorf("iss = %q", c.Iss)
	}
	if c.Scope != fcmScope {
		t.Errorf("scope = %q, want %q", c.Scope, fcmScope)
	}
	if c.Iat != 1_700_000_000 {
		t.Errorf("iat = %d, want the notifier clock (1700000000)", c.Iat)
	}
	if c.Exp != c.Iat+3600 {
		t.Errorf("exp-iat = %d, want 3600", c.Exp-c.Iat)
	}
	if !strings.HasPrefix(c.Aud, "http://127.0.0.1:") {
		t.Errorf("aud = %q, want the credentials' token_uri", c.Aud)
	}

	sig, err := b64urlDecode(parts[2])
	if err != nil {
		t.Fatalf("jwt signature decode: %v", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&f.priv.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatalf("RS256 signature does not verify: %v", err)
	}
}

// --- the load-bearing crux ---

// TestNotifierWaitingQuestionFCMReceipt is the LOAD-BEARING crux for Slice 2:
// a waiting notice (question kind), unattended, with a registered token →
// one data-only FCM HTTP v1 message with vh_condition=question_pending,
// android.priority=HIGH (Doze-defeating), collapse_key=waiting, all data
// values strings, and no `notification` block.
func TestNotifierWaitingQuestionFCMReceipt(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "phone", ""); err != nil {
		t.Fatal(err)
	}

	f.nt.Send(Notice{
		Type:      TypeWaiting,
		Kind:      KindQuestion,
		SessionID: "s1",
		Root:      "s1",
		Project:   "proj",
		Title:     "T",
		Detail:    "Waiting for your input",
		Ts:        1_700_000_000_123,
	})

	r := f.fcm.waitNext(t)
	if r.Path != "/v1/projects/proj-42/messages:send" {
		t.Fatalf("FCM path = %q", r.Path)
	}
	if r.Authorization != "Bearer test-access-token" {
		t.Fatalf("Authorization = %q", r.Authorization)
	}
	m := r.Body.Message
	if m.Token != "device-token-1" {
		t.Fatalf("message.token = %q", m.Token)
	}
	// Decoding into map[string]string already proves every data value is a
	// string; DeepEqual proves presence and exact values.
	wantData := map[string]string{
		"vh_kind":      "notice",
		"vh_event":     "waiting",
		"vh_condition": "question_pending",
		"vh_count":     "1",
		"vh_ts":        "1700000000123",
	}
	if !reflect.DeepEqual(m.Data, wantData) {
		t.Fatalf("data = %+v\nwant %+v", m.Data, wantData)
	}
	if m.Android == nil {
		t.Fatal("missing android config")
	}
	if m.Android.Priority != "HIGH" {
		t.Fatalf("android.priority = %q, want HIGH (waiting must beat Doze)", m.Android.Priority)
	}
	if m.Android.CollapseKey != "waiting" {
		t.Fatalf("android.collapse_key = %q, want waiting", m.Android.CollapseKey)
	}
	if m.Android.TTL != "3600s" {
		t.Fatalf("android.ttl = %q, want 3600s (config ttl_sec)", m.Android.TTL)
	}
	if strings.Contains(string(r.Raw), `"notification"`) {
		t.Fatalf("message must be data-only (no notification block): %s", r.Raw)
	}
}

// TestNotifierSessionStartedFCMReceipt pins the v3-change-3 message shape:
// session_started maps to vh_condition=session_started, NORMAL priority
// (only waiting is HIGH), collapse_key=session_started (derives from
// vh_event), data-only, vh_count fixed "1".
func TestNotifierSessionStartedFCMReceipt(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "phone", ""); err != nil {
		t.Fatal(err)
	}

	f.nt.Send(Notice{
		Type:      TypeSessionStarted,
		SessionID: "s1",
		Root:      "s1",
		Project:   "proj",
		Title:     "Fix login",
		Detail:    "Session started",
		Ts:        1_700_000_000_123,
	})

	r := f.fcm.waitNext(t)
	m := r.Body.Message
	wantData := map[string]string{
		"vh_kind":      "notice",
		"vh_event":     TypeSessionStarted,
		"vh_condition": condSessionStarted,
		"vh_count":     "1",
		"vh_ts":        "1700000000123",
	}
	if !reflect.DeepEqual(m.Data, wantData) {
		t.Fatalf("data = %+v\nwant %+v", m.Data, wantData)
	}
	if m.Android == nil {
		t.Fatal("missing android config")
	}
	if m.Android.Priority != "NORMAL" {
		t.Fatalf("android.priority = %q, want NORMAL (only waiting is HIGH)", m.Android.Priority)
	}
	if m.Android.CollapseKey != TypeSessionStarted {
		t.Fatalf("android.collapse_key = %q, want %q", m.Android.CollapseKey, TypeSessionStarted)
	}
	if strings.Contains(string(r.Raw), `"notification"`) {
		t.Fatalf("message must be data-only (no notification block): %s", r.Raw)
	}
}

// --- condition + priority mapping table ---

// TestNotifierConditionAndPriorityMapping pins the full vh_condition table
// and the HIGH-only-for-waiting priority rule, end to end through Send.
func TestNotifierConditionAndPriorityMapping(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "", ""); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		n         Notice
		condition string
		priority  string
	}{
		{notice(TypeWaiting, KindPermission, 101), condPermissionPending, "HIGH"},
		{notice(TypeWaiting, KindQuestion, 102), condQuestionPending, "HIGH"},
		{notice(TypeFinished, "", 103), condSessionUnread, "NORMAL"},
		{notice(TypeStuckThinking, "", 104), condDegradedThinking, "NORMAL"},
		{notice(TypeRunaway, "", 105), condDegradedRunaway, "NORMAL"},
		{notice(TypeStalled, "", 106), condDegradedStalled, "NORMAL"},
		{notice(TypeSessionStarted, "", 107), condSessionStarted, "NORMAL"},
		{Notice{Type: TypeStalled, Title: "OpenCode", Ts: 108}, condWorkerDown, "NORMAL"},
	}

	byTS := map[string]fcmReceipt{}
	for _, c := range cases {
		f.nt.Send(c.n)
		r := f.fcm.waitNext(t)
		byTS[r.Body.Message.Data["vh_ts"]] = r
		// Step the frozen clock past cooldown_sec (300s) so the next send —
		// including another waiting — is a fresh cooldown window. The last
		// send lands 7×301s past t0 (well inside the cached OAuth token's
		// 3600s validity, even with the post-last advance).
		f.clk.advance(301 * time.Second)
	}
	for _, c := range cases {
		r, ok := byTS[strconv.FormatInt(c.n.Ts, 10)]
		if !ok {
			t.Fatalf("no receipt for ts=%d", c.n.Ts)
		}
		m := r.Body.Message
		if m.Data["vh_condition"] != c.condition {
			t.Errorf("%s(kind=%s): vh_condition = %q, want %q", c.n.Type, c.n.Kind, m.Data["vh_condition"], c.condition)
		}
		if m.Android == nil || m.Android.Priority != c.priority {
			got := "nil"
			if m.Android != nil {
				got = m.Android.Priority
			}
			t.Errorf("%s: priority = %s, want %s", c.n.Type, got, c.priority)
		}
		if m.Android == nil || m.Android.CollapseKey != c.n.Type {
			t.Errorf("%s: collapse_key must equal the vh_event value", c.n.Type)
		}
	}
}

// --- gating (mirrors Web Push) ---

// TestNotifierGatingTypeFilter: the active profile's types filter excludes
// the notice → no FCM request, no cooldown consumption.
func TestNotifierGatingTypeFilter(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "", ""); err != nil {
		t.Fatal(err)
	}
	c := f.cfg.Get()
	c.Profiles = []Profile{{Name: "p", ChannelPolicy: PolicyAlways, Types: []string{TypeFinished}}}
	c.Active = "p"
	if err := f.cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	f.nt.Send(notice(TypeWaiting, KindQuestion, 1)) // not in the filter
	f.fcm.assertNoRequest(t, "type filtered by profile")
}

// TestNotifierGatingAttended: an attending device suppresses FCM (the away
// path only).
func TestNotifierGatingAttended(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "", ""); err != nil {
		t.Fatal(err)
	}
	f.pres.Heartbeat(Device{ID: "d1", LastInteraction: time.Now()})
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.assertNoRequest(t, "attended")
}

// TestNotifierGatingCooldown: the second send of the same type within
// cooldown_sec (default 300) to the same token is suppressed — reading the
// SAME knob as Web Push, from the notify channel's own map.
func TestNotifierGatingCooldown(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", "", ""); err != nil {
		t.Fatal(err)
	}
	if got := f.cfg.Get().Detect.CooldownSec; got != 300 {
		t.Fatalf("test premise: default cooldown_sec = %d, want 300", got)
	}
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t) // first delivers
	f.nt.Send(notice(TypeFinished, "", 2))
	f.fcm.assertNoRequest(t, "cooldown")

	// A different type is a different cooldown key → delivers.
	f.nt.Send(notice(TypeRunaway, "", 3))
	f.fcm.waitNext(t)
}

// --- UNREGISTERED pruning ---

// TestNotifierPrunesUnregisteredTokens pins the delivery-hygiene contract:
// a token is pruned ONLY on FCM responses carrying explicit UNREGISTERED
// evidence in the error body — 400 INVALID_ARGUMENT or 404 NOT_FOUND with
// the FcmError detail (or a top-level error.status of UNREGISTERED, the
// details-less shape FCM also answers dead tokens with). A generic 404
// NOT_FOUND (FCM's answer to sender-side misconfiguration, e.g. a wrong/
// deleted project ID) and a 400 with another reason must NOT prune: pruning
// on those would mass-erase every valid registration. Every case also
// asserts the PERSISTED registry: a second TokenRegistry reloaded from the
// same state dir must agree (prunes are deletions on disk, retentions are
// retentions on disk).
func TestNotifierPrunesUnregisteredTokens(t *testing.T) {
	const unregistered400Body = `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	const invalidBody = `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}`
	const unregistered404Body = `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	const projectNotFoundBody = `{"error":{"code":404,"status":"NOT_FOUND","message":"Requested entity was not found"}}`
	const topLevelUnregisteredBody = `{"error":{"code":404,"status":"UNREGISTERED"}}`

	// reloadCount builds a fresh TokenRegistry over the same state dir and
	// returns its Count() — the daemon-restart view of the registry.
	reloadCount := func(f *notifyFixture) int {
		return NewTokenRegistry(f.dir).Count()
	}

	// Case 1: 400 + UNREGISTERED detail → pruned, and persisted-absent.
	f := newNotifyFixture(t)
	f.fcm.setRespond(func(int) (int, string) { return 400, unregistered400Body })
	_ = f.tokens.Upsert("tok-a", "", "")
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	eventually(t, func() bool { return f.tokens.Count() == 0 }, "400 UNREGISTERED must prune the token")
	if got := reloadCount(f); got != 0 {
		t.Fatalf("case 1 reload: registry count = %d, want 0 (prune must persist)", got)
	}

	// Case 2: 404 + UNREGISTERED detail → pruned, and persisted-absent.
	f2 := newNotifyFixture(t)
	f2.fcm.setRespond(func(int) (int, string) { return 404, unregistered404Body })
	_ = f2.tokens.Upsert("tok-b", "", "")
	f2.nt.Send(notice(TypeFinished, "", 1))
	f2.fcm.waitNext(t)
	eventually(t, func() bool { return f2.tokens.Count() == 0 }, "404 UNREGISTERED must prune the token")
	if got := reloadCount(f2); got != 0 {
		t.Fatalf("case 2 reload: registry count = %d, want 0 (prune must persist)", got)
	}

	// Case 3: 404 generic/project NOT_FOUND (no UNREGISTERED evidence) →
	// RETAINED — sender-side misconfiguration must not erase registrations —
	// and the retention must persist.
	f3 := newNotifyFixture(t)
	f3.fcm.setRespond(func(int) (int, string) { return 404, projectNotFoundBody })
	_ = f3.tokens.Upsert("tok-c", "", "")
	f3.nt.Send(notice(TypeFinished, "", 1))
	f3.fcm.waitNext(t)
	time.Sleep(300 * time.Millisecond) // give a (wrong) prune path a chance
	if f3.tokens.Count() != 1 {
		t.Fatal("404 without UNREGISTERED detail must NOT prune the token")
	}
	if got := reloadCount(f3); got != 1 {
		t.Fatalf("case 3 reload: registry count = %d, want 1 (retention must persist)", got)
	}

	// Case 4: 400 with another reason → kept, and persisted-kept.
	f4 := newNotifyFixture(t)
	f4.fcm.setRespond(func(int) (int, string) { return 400, invalidBody })
	_ = f4.tokens.Upsert("tok-d", "", "")
	f4.nt.Send(notice(TypeFinished, "", 1))
	f4.fcm.waitNext(t)
	time.Sleep(300 * time.Millisecond) // give the prune path (wrongly) a chance
	if f4.tokens.Count() != 1 {
		t.Fatal("400 non-UNREGISTERED must NOT prune the token")
	}
	if got := reloadCount(f4); got != 1 {
		t.Fatalf("case 4 reload: registry count = %d, want 1 (retention must persist)", got)
	}

	// Case 5 (F4): top-level error.status UNREGISTERED, no details array —
	// the details-less shape FCM also answers dead tokens with → pruned.
	f5 := newNotifyFixture(t)
	f5.fcm.setRespond(func(int) (int, string) { return 404, topLevelUnregisteredBody })
	_ = f5.tokens.Upsert("tok-e", "", "")
	f5.nt.Send(notice(TypeFinished, "", 1))
	f5.fcm.waitNext(t)
	eventually(t, func() bool { return f5.tokens.Count() == 0 }, "404 top-level UNREGISTERED status must prune the token")
	if got := reloadCount(f5); got != 0 {
		t.Fatalf("case 5 reload: registry count = %d, want 0 (prune must persist)", got)
	}
}

// --- token cache ---

// TestNotifierTokenCacheReuse: two deliveries share one OAuth2 exchange; the
// cached access token serves the second send.
func TestNotifierTokenCacheReuse(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-a", "", "")
	_ = f.tokens.Upsert("tok-b", "", "")

	f.nt.Send(notice(TypeFinished, "", 1)) // fans out to BOTH tokens
	f.fcm.waitNext(t)
	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 1 {
		t.Fatalf("token exchanges = %d, want 1 (cache reuse)", got)
	}
}

// --- auth recovery ---

// TestNotifierAuth401ForceRefresh: a 401 from FCM forces exactly one token
// refresh and the retried send then succeeds.
func TestNotifierAuth401ForceRefresh(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-a", "", "")
	f.fcm.setRespond(func(n int) (int, string) {
		if n == 1 {
			return 401, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`
		}
		return 200, "{}"
	})
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t) // the 401 attempt
	eventually(t, func() bool { return f.fcm.requests() == 2 }, "401 must retry once")
	if got := f.tmu.count(); got != 2 {
		t.Fatalf("token exchanges = %d, want 2 (initial + forced refresh)", got)
	}
	if f.tokens.Count() != 1 {
		t.Fatal("401 must not prune the token")
	}
}

// TestNotifier5xxSingleRetry: a 5xx gets exactly one cheap retry and no more.
func TestNotifier5xxSingleRetry(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-a", "", "")
	f.fcm.setRespond(func(int) (int, string) { return 500, `{"error":{"code":500}}` })
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	eventually(t, func() bool { return f.fcm.requests() == 2 }, "5xx must retry exactly once")
	time.Sleep(300 * time.Millisecond)
	if got := f.fcm.requests(); got != 2 {
		t.Fatalf("requests = %d, want exactly 2 (no retry loop)", got)
	}
	if f.tokens.Count() != 1 {
		t.Fatal("5xx must not prune the token")
	}
}

// --- concurrency + OAuth cache boundaries (review defers A-F1 / B-F2) ---

// TestNotifierConcurrentSendCooldownAndTokenCache (A-F1): two Sends racing
// from simultaneous goroutines against one notifier. The per-(type,token)
// cooldown map must account correctly under the race — each token is allowed
// EXACTLY once across both fan-outs (mutex-serialized onCooldown: first
// caller records, loser is suppressed) — and the OAuth cache must be
// race-safe: exactly ONE token exchange total serves both delivery
// goroutines. A follow-up same-type send inside the window stays suppressed.
func TestNotifierConcurrentSendCooldownAndTokenCache(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-concurrent-a", "", "")
	_ = f.tokens.Upsert("tok-concurrent-b", "", "")

	var wg sync.WaitGroup
	start := make(chan struct{})
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			defer wg.Done()
			<-start
			f.nt.Send(notice(TypeFinished, "", int64(1000+i)))
		}(i)
	}
	close(start)
	wg.Wait()

	r1 := f.fcm.waitNext(t)
	r2 := f.fcm.waitNext(t)
	toks := map[string]bool{r1.Body.Message.Token: true, r2.Body.Message.Token: true}
	if len(toks) != 2 || !toks["tok-concurrent-a"] || !toks["tok-concurrent-b"] {
		t.Fatalf("concurrent fan-out tokens = %v, want each registered token exactly once", toks)
	}

	// Cache race-safety: both delivery goroutines shared ONE exchange.
	if got := f.tmu.count(); got != 1 {
		t.Fatalf("token exchanges = %d, want 1 (concurrent sends must share the cached token)", got)
	}

	// Cooldown accounting under the race: no third delivery leaked through.
	time.Sleep(200 * time.Millisecond)
	if got := f.fcm.requests(); got != 2 {
		t.Fatalf("fcm requests = %d, want exactly 2 (each (type,token) allowed once)", got)
	}

	// And a sequential same-type send inside the window is suppressed.
	f.nt.Send(notice(TypeFinished, "", 2000))
	f.fcm.assertNoRequest(t, "same-type send within cooldown after the race")
}

// TestNotifierTokenCacheRefreshBoundary (B-F2a): with a short-lived OAuth
// token (expires_in=400s), the cache is reused strictly BEFORE the 5-min-early
// refresh boundary (now+300s < exp) and re-exchanged exactly AT it
// (now+300s == exp is already stale). The frozen clock makes every step
// deterministic.
func TestNotifierTokenCacheRefreshBoundary(t *testing.T) {
	f := newNotifyFixtureExpiry(t, 400)
	_ = f.tokens.Upsert("tok-expiry", "", "")

	// t0: first send — exchange #1; cache exp = t0+400s.
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 1 {
		t.Fatalf("exchanges = %d, want 1 after first send", got)
	}

	// t0+90s: now+300 = t0+390 < t0+400 → cached token reused. A different
	// notice type dodges the per-(type,token) cooldown.
	f.clk.advance(90 * time.Second)
	f.nt.Send(notice(TypeRunaway, "", 2))
	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 1 {
		t.Fatalf("exchanges after +90s = %d, want 1 (cache reused before the boundary)", got)
	}

	// t0+100s: now+300 == exp → NOT Before(exp) → refresh (exchange #2).
	f.clk.advance(10 * time.Second)
	f.nt.Send(notice(TypeStuckThinking, "", 3))
	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 2 {
		t.Fatalf("exchanges after +100s = %d, want 2 (refresh exactly at the 5-min-early boundary)", got)
	}

	// t0+150s: refreshed cache (exp = t0+500s) is served again — no third exchange.
	f.clk.advance(50 * time.Second)
	f.nt.Send(notice(TypeStalled, "", 4))
	f.fcm.waitNext(t)
	if got := f.tmu.count(); got != 2 {
		t.Fatalf("exchanges after +150s = %d, want 2 (refreshed cache reused)", got)
	}
}

// TestNotifierPersistent401Bounded (B-F2b): when EVERY FCM attempt answers
// 401 — even after the forced token refresh — the sender terminates
// bounded: exactly 2 FCM requests (initial + one refreshed retry), exactly 2
// exchanges (initial + one forced refresh), no retry loop, and the
// registration is RETAINED (a 401 is an auth problem, not dead-token
// evidence).
func TestNotifierPersistent401Bounded(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-401", "", "")
	f.fcm.setRespond(func(int) (int, string) { return 401, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}` })

	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t) // the initial 401
	eventually(t, func() bool { return f.fcm.requests() == 2 }, "persistent 401 must force-refresh and retry exactly once")
	time.Sleep(300 * time.Millisecond)
	if got := f.fcm.requests(); got != 2 {
		t.Fatalf("fcm requests = %d, want exactly 2 (bounded termination, no loop)", got)
	}
	if got := f.tmu.count(); got != 2 {
		t.Fatalf("token exchanges = %d, want exactly 2 (initial + forced refresh, no further)", got)
	}
	if f.tokens.Count() != 1 {
		t.Fatal("persistent 401 must NOT prune the registration")
	}
}

// --- init failures → channel disabled ---

// TestNotifierInitFailures: every unusable credentials shape fails
// NewNotifier (caller leaves the channel disabled). Error messages must name
// the path, never the contents.
func TestNotifierInitFailures(t *testing.T) {
	dir := t.TempDir()

	build := func(n *NotifyConfig) (*Notifier, error) {
		cfg, err := NewStore(filepath.Join(t.TempDir(), "alerts.jsonc"))
		if err != nil {
			t.Fatal(err)
		}
		if n != nil {
			c := cfg.Get()
			c.Notify = n
			if err := cfg.Replace(c); err != nil {
				t.Fatal(err)
			}
		}
		return NewNotifier(cfg, NewPresence(), NewTokenRegistry(dir))
	}

	if _, err := build(nil); err == nil {
		t.Error("unconfigured store must fail NewNotifier")
	}
	if _, err := build(&NotifyConfig{CredentialsFile: filepath.Join(dir, "missing.json")}); err == nil {
		t.Error("missing credentials file must fail NewNotifier")
	}

	garbage := filepath.Join(dir, "garbage.json")
	if err := os.WriteFile(garbage, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := build(&NotifyConfig{CredentialsFile: garbage}); err == nil {
		t.Error("garbage credentials file must fail NewNotifier")
	}

	noFields := filepath.Join(dir, "no-fields.json")
	if err := os.WriteFile(noFields, []byte(`{"project_id":"p"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := build(&NotifyConfig{CredentialsFile: noFields}); err == nil {
		t.Error("credentials without client_email/token_uri must fail NewNotifier")
	}

	badKey := filepath.Join(dir, "bad-key.json")
	if err := os.WriteFile(badKey, []byte(`{"client_email":"a@b.c","token_uri":"https://oauth2.googleapis.com/token","private_key":"not a pem"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := build(&NotifyConfig{CredentialsFile: badKey})
	if err == nil {
		t.Fatal("unusable private_key must fail NewNotifier")
	}
	if strings.Contains(err.Error(), "not a pem") {
		t.Fatalf("error must not echo credentials contents: %v", err)
	}
}

// TestNotifierProjectAndTTLDefaults: project_id falls back to the
// credentials file; ttl_sec<=0 falls back to the 24h default.
func TestNotifierProjectAndTTLDefaults(t *testing.T) {
	f := newNotifyFixture(t) // config carries project+ttl: prove the fallback with a second notifier
	c := f.cfg.Get()
	c.Notify.ProjectID = ""
	c.Notify.TtlSec = 0
	if err := f.cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	nt, err := NewNotifier(f.cfg, f.pres, f.tokens)
	if err != nil {
		t.Fatalf("NewNotifier with empty project_id: %v", err)
	}
	nt.fcmBase = f.nt.fcmBase
	nt.now = f.nt.now
	_ = f.tokens.Upsert("tok-default", "", "")

	nt.Send(notice(TypeFinished, "", 1))
	r := f.fcm.waitNext(t)
	if r.Path != "/v1/projects/proj-42/messages:send" {
		t.Fatalf("project fallback path = %q, want the credentials' proj-42", r.Path)
	}
	if ttl := r.Body.Message.Android.TTL; ttl != "86400s" {
		t.Fatalf("default ttl = %q, want 86400s", ttl)
	}
}

// --- engine integration ---

// TestEngineNotifyReady pins the flip: config alone or sender alone is not
// ready; both together are; dropping the config section disables again.
func TestEngineNotifyReady(t *testing.T) {
	dir := t.TempDir()
	cfg, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	pres := NewPresence()
	eng := NewEngine(cfg, pres, NewDispatcher(cfg, pres))
	if eng.NotifyReady() {
		t.Fatal("no config + no sender must not be ready")
	}

	c := cfg.Get()
	c.Notify = &NotifyConfig{CredentialsFile: filepath.Join(dir, "nope.json"), ProjectID: "p"}
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	if eng.NotifyReady() {
		t.Fatal("configured config without sender must not be ready")
	}

	creds := filepath.Join(dir, "creds.json")
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	cj, _ := json.Marshal(map[string]string{
		"project_id":   "p",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@p.iam.gserviceaccount.com",
		"token_uri":    "https://oauth2.googleapis.com/token",
	})
	if err := os.WriteFile(creds, cj, 0o600); err != nil {
		t.Fatal(err)
	}
	c = cfg.Get()
	c.Notify.CredentialsFile = creds // repoint at the loadable file
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	tokens := NewTokenRegistry(dir)
	nt, err := NewNotifier(cfg, pres, tokens)
	if err != nil {
		t.Fatalf("NewNotifier: %v", err)
	}
	eng.SetNotifier(nt)
	if !eng.NotifyReady() {
		t.Fatal("configured + attached sender must be ready")
	}

	// A later config edit that drops the section disables the channel again.
	c = cfg.Get()
	c.Notify = nil
	if err := cfg.Replace(c); err != nil {
		t.Fatal(err)
	}
	if eng.NotifyReady() {
		t.Fatal("sender attached but config section dropped must not be ready")
	}
}

// TestEngineDaemonNoticeReachesNotifier pins the ENGINE join point (Slice 2):
// a daemon-level notice fanned out through EmitDaemonNotice reaches the
// attached FCM notifier with the worker_down condition — even while the
// dispatcher suppresses all outbound channels ("Silent" profile).
func TestEngineDaemonNoticeReachesNotifier(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-engine", "", "")
	if err := f.cfg.SetActive("Silent"); err != nil { // PolicyNever
		t.Fatal(err)
	}
	eng := NewEngine(f.cfg, f.pres, NewDispatcher(f.cfg, f.pres))
	eng.SetNotifier(f.nt)
	eng.EmitDaemonNotice("opencode serve pid 9 exited")

	r := f.fcm.waitNext(t)
	if cond := r.Body.Message.Data["vh_condition"]; cond != condWorkerDown {
		t.Fatalf("daemon notice condition = %q, want worker_down", cond)
	}
	if ev := r.Body.Message.Data["vh_event"]; ev != TypeStalled {
		t.Fatalf("daemon notice event = %q, want stalled", ev)
	}
}

// TestEngineWaitingNoticeCarriesKind pins the emission-site kind recording
// through the REAL onEvent → fire path: a permission set fires waiting with
// kind=permission, a question set fires waiting with kind=question. Also
// pins the JSON shape: kind is omitempty (absent for other notice types).
func TestEngineWaitingNoticeCarriesKind(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.onEvent(ev(1, state.KindPermissionSet, map[string]any{"sessionID": "s1", "id": "p1"}))
	w.onEvent(ev(2, state.KindQuestionSet, map[string]any{"sessionID": "s2", "id": "q1"}))

	if len(*fired) != 2 {
		t.Fatalf("want 2 waiting notices, got %d: %+v", len(*fired), *fired)
	}
	if (*fired)[0].Type != TypeWaiting || (*fired)[0].Kind != KindPermission || (*fired)[0].SessionID != "s1" {
		t.Fatalf("permission notice drift: %+v", (*fired)[0])
	}
	if (*fired)[1].Type != TypeWaiting || (*fired)[1].Kind != KindQuestion || (*fired)[1].SessionID != "s2" {
		t.Fatalf("question notice drift: %+v", (*fired)[1])
	}

	// Shape: a notice without a kind must not carry the key at all.
	b, _ := json.Marshal(Notice{Type: TypeFinished, SessionID: "s", Root: "s", Ts: 1})
	if strings.Contains(string(b), `"kind"`) {
		t.Fatalf("kind must be omitempty: %s", b)
	}
}

// --- v3: per-token push policy + send-failure observability ---

// syncBuf is a mutex-guarded log buffer: the failure logger writes from
// per-token delivery goroutines while the test reads.
type syncBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogger swaps the notifier's logger for a buffered one.
func captureLogger(f *notifyFixture) *syncBuf {
	sb := &syncBuf{}
	f.nt.logger = slog.New(slog.NewTextHandler(sb, nil))
	return sb
}

// TestNotifierAlwaysPolicyDeliversWhileAttended is the LOAD-BEARING crux for
// v3 change 1: with a device actively attending, an always-policy token
// RECEIVES its push while a when_unattended token in the SAME registry is
// suppressed in the same send. Cooldown still applies to always tokens
// (attendance-exempt, not cooldown-exempt); a different type escapes the
// cooldown key and still delivers while attended.
func TestNotifierAlwaysPolicyDeliversWhileAttended(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-always-1", "on-call phone", "always")
	_ = f.tokens.Upsert("tok-wu-1", "", "") // default: when_unattended
	f.pres.Heartbeat(Device{ID: "d1", LastInteraction: time.Now()})

	f.nt.Send(notice(TypeWaiting, KindQuestion, 1))

	r := f.fcm.waitNext(t)
	if r.Body.Message.Token != "tok-always-1" {
		t.Fatalf("delivered token = %q, want tok-always-1 (always policy bypasses attendance)", r.Body.Message.Token)
	}
	f.fcm.assertNoRequest(t, "when_unattended token must be suppressed in the same attended send")

	// Cooldown applies to the always token too: same (type, token) within
	// cooldown_sec is suppressed even though attendance is bypassed.
	f.nt.Send(notice(TypeWaiting, KindPermission, 2)) // same type → same cooldown key
	f.fcm.assertNoRequest(t, "cooldown must still gate always-policy tokens")

	// A different type escapes the cooldown and still delivers while attended.
	f.nt.Send(notice(TypeFinished, "", 3))
	r = f.fcm.waitNext(t)
	if r.Body.Message.Token != "tok-always-1" {
		t.Fatalf("second delivery token = %q, want tok-always-1", r.Body.Message.Token)
	}
	f.fcm.assertNoRequest(t, "when_unattended token stays suppressed while attended")

	// (Unattended fan-out to BOTH policies — when_unattended is the default
	// posture and always only ADDS delivery — is pinned by the a-F1
	// companion, TestNotifierAlwaysPolicyDeliversWhileUnattended; presence
	// here stays attended on the real clock, so this test cannot flip it.)
}

// TestNotifierAlwaysPolicyDeliversWhileUnattended (a-F1): the companion pin
// to TestNotifierAlwaysPolicyDeliversWhileAttended — UNATTENDED (no presence
// heartbeats), an always-policy token is delivered ALONGSIDE the default
// when_unattended token in the same send. always only ADDS delivery on top
// of the default away path; it never replaces it.
func TestNotifierAlwaysPolicyDeliversWhileUnattended(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-always-un", "on-call phone", "always")
	_ = f.tokens.Upsert("tok-wu-un", "tablet", "") // default: when_unattended
	// No heartbeat → unattended (fresh Presence).

	f.nt.Send(notice(TypeFinished, "", 1))

	r1 := f.fcm.waitNext(t)
	r2 := f.fcm.waitNext(t)
	toks := map[string]bool{r1.Body.Message.Token: true, r2.Body.Message.Token: true}
	if len(toks) != 2 || !toks["tok-always-un"] || !toks["tok-wu-un"] {
		t.Fatalf("unattended fan-out tokens = %v, want BOTH the always and when_unattended tokens exactly once", toks)
	}
}

// TestNotifierFailureLogging pins the one-line-per-failure contract across
// every failure class: channel=notify, a classified reason, the HTTP status
// where applicable, and the token identified as label-or-hash — plus the
// sanitized last_error each class leaves on the operator surface.
func TestNotifierFailureLogging(t *testing.T) {
	const projectNotFound = `{"error":{"code":404,"status":"NOT_FOUND","message":"Requested entity was not found"}}`

	t.Run("oauth exchange failed", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		f.nt.creds.TokenURI = "http://127.0.0.1:1/token" // unreachable
		_ = f.tokens.Upsert("tok-oauth", "pixel", "")
		f.nt.Send(notice(TypeFinished, "", 1))
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "oauth exchange failed"
		}, "oauth failure must set last_error")
		line := sb.String()
		for _, want := range []string{
			`msg="notify: fcm send failed"`,
			"channel=notify",
			"reason=\"oauth exchange failed\"",
			"token=pixel",
		} {
			if !strings.Contains(line, want) {
				t.Fatalf("oauth log line missing %q:\n%s", want, line)
			}
		}
		if strings.Contains(line, "status=") {
			t.Fatalf("oauth failure has no HTTP status; got:\n%s", line)
		}
	})

	t.Run("401 refresh exhaustion", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		_ = f.tokens.Upsert("tok-401x", "phone-401", "")
		f.fcm.setRespond(func(int) (int, string) {
			return 401, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`
		})
		f.nt.Send(notice(TypeFinished, "", 1))
		f.fcm.waitNext(t)
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "401 UNAUTHENTICATED"
		}, "persistent 401 must set last_error")
		line := sb.String()
		for _, want := range []string{
			`msg="notify: fcm send failed"`,
			"reason=\"unauthenticated after refresh\"",
			"status=401",
			"code=UNAUTHENTICATED",
			"token=phone-401",
		} {
			if !strings.Contains(line, want) {
				t.Fatalf("401 log line missing %q:\n%s", want, line)
			}
		}
	})

	t.Run("5xx retry exhaustion", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		_ = f.tokens.Upsert("tok-5xx", "phone-5xx", "")
		f.fcm.setRespond(func(int) (int, string) { return 500, `{"error":{"code":500}}` })
		f.nt.Send(notice(TypeFinished, "", 1))
		f.fcm.waitNext(t)
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "500 fcm 5xx retry exhausted"
		}, "5xx exhaustion must set last_error")
		line := sb.String()
		for _, want := range []string{
			"reason=\"fcm 5xx retry exhausted\"",
			"status=500",
			"token=phone-5xx",
		} {
			if !strings.Contains(line, want) {
				t.Fatalf("5xx log line missing %q:\n%s", want, line)
			}
		}
	})

	t.Run("429 quota", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		_ = f.tokens.Upsert("tok-429", "phone-429", "")
		f.fcm.setRespond(func(int) (int, string) {
			return 429, `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`
		})
		f.nt.Send(notice(TypeFinished, "", 1))
		f.fcm.waitNext(t)
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "429 RESOURCE_EXHAUSTED"
		}, "429 must set last_error")
		line := sb.String()
		for _, want := range []string{"reason=\"rate limited (quota)\"", "status=429"} {
			if !strings.Contains(line, want) {
				t.Fatalf("429 log line missing %q:\n%s", want, line)
			}
		}
	})

	t.Run("404 rejected", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		_ = f.tokens.Upsert("tok-404", "phone-404", "")
		f.fcm.setRespond(func(int) (int, string) { return 404, projectNotFound })
		f.nt.Send(notice(TypeFinished, "", 1))
		f.fcm.waitNext(t)
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "404 NOT_FOUND"
		}, "404 must set last_error (status + canonical name)")
		line := sb.String()
		for _, want := range []string{"reason=\"fcm rejected message\"", "status=404", "code=NOT_FOUND"} {
			if !strings.Contains(line, want) {
				t.Fatalf("404 log line missing %q:\n%s", want, line)
			}
		}
		// The raw response body must not be echoed.
		if strings.Contains(line, "Requested entity") {
			t.Fatalf("log must not carry response body text:\n%s", line)
		}
	})

	t.Run("404 unregistered prune decision", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		_ = f.tokens.Upsert("tok-dead", "phone-dead", "")
		f.fcm.setRespond(func(int) (int, string) {
			return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
		})
		f.nt.Send(notice(TypeFinished, "", 1))
		f.fcm.waitNext(t)
		eventually(t, func() bool { return f.tokens.Count() == 0 }, "UNREGISTERED must prune")
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "404 UNREGISTERED"
		}, "prune must still set last_error (delivery failed)")
		line := sb.String()
		for _, want := range []string{
			`msg="notify: token unregistered, pruned"`,
			"reason=\"token unregistered (pruned)\"",
			"code=UNREGISTERED",
			"token=phone-dead",
		} {
			if !strings.Contains(line, want) {
				t.Fatalf("prune log line missing %q:\n%s", want, line)
			}
		}
	})

	t.Run("transport error", func(t *testing.T) {
		f := newNotifyFixture(t)
		sb := captureLogger(f)
		f.nt.fcmBase = "http://127.0.0.1:1" // unreachable FCM endpoint
		_ = f.tokens.Upsert("tok-transport", "phone-xport", "")
		f.nt.Send(notice(TypeFinished, "", 1))
		eventually(t, func() bool {
			_, lastErr := f.nt.Health()
			return lastErr == "transport error"
		}, "transport failure must set last_error")
		line := sb.String()
		for _, want := range []string{"reason=\"transport error\"", "token=phone-xport", "err="} {
			if !strings.Contains(line, want) {
				t.Fatalf("transport log line missing %q:\n%s", want, line)
			}
		}
	})
}

// TestNotifierLogSecretHygiene is the SECRET-HYGIENE crux: register a known
// distinctive token VALUE, force a failed send, and assert the value appears
// in NO log line — the token is identified by its sha256 hash prefix (the
// same derivation the cooldown map keys on) when no label exists.
func TestNotifierLogSecretHygiene(t *testing.T) {
	const secret = "SECRET-TOKEN-VALUE-Zq9x-never-log-me"
	f := newNotifyFixture(t)
	sb := captureLogger(f)
	_ = f.tokens.Upsert(secret, "", "") // no label → hash identification
	f.fcm.setRespond(func(int) (int, string) {
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","message":"Requested entity was not found"}}`
	})
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	eventually(t, func() bool {
		_, lastErr := f.nt.Health()
		return lastErr == "404 NOT_FOUND"
	}, "failed send must settle")

	line := sb.String()
	if strings.Contains(line, secret) {
		t.Fatalf("token VALUE leaked into a log line:\n%s", line)
	}
	sum := sha256.Sum256([]byte(secret))
	wantRef := hex.EncodeToString(sum[:16])
	if !strings.Contains(line, "token="+wantRef) {
		t.Fatalf("log must identify the token by its hash prefix %q:\n%s", wantRef, line)
	}
	// The sanitized operator surface carries no token material either.
	if _, lastErr := f.nt.Health(); strings.Contains(lastErr, secret) {
		t.Fatalf("token VALUE leaked into last_error: %q", lastErr)
	}
}

// TestNotifierHealthLastAttemptError pins the operator-checkable surface:
// zero/empty before any attempt, set by a failed attempt (RFC3339-formattable
// time + sanitized error), cleared by a later success.
func TestNotifierHealthLastAttemptError(t *testing.T) {
	f := newNotifyFixture(t)
	captureLogger(f) // keep failure lines out of the test run's stderr
	if at, lastErr := f.nt.Health(); !at.IsZero() || lastErr != "" {
		t.Fatalf("before any attempt: (%v, %q), want zero/empty", at, lastErr)
	}
	_ = f.tokens.Upsert("tok-h", "", "")
	f.fcm.setRespond(func(int) (int, string) {
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","message":"x"}}`
	})
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	eventually(t, func() bool {
		at, lastErr := f.nt.Health()
		return lastErr == "404 NOT_FOUND" && at.Unix() == 1_700_000_000
	}, "failed attempt must set last_attempt (notifier clock) + last_error")

	// A later success clears last_error and advances last_attempt.
	f.fcm.setRespond(func(int) (int, string) { return 200, "{}" })
	f.clk.advance(301 * time.Second) // past cooldown for the same type
	f.nt.Send(notice(TypeFinished, "", 2))
	f.fcm.waitNext(t)
	eventually(t, func() bool {
		at, lastErr := f.nt.Health()
		return lastErr == "" && at.Unix() == 1_700_000_301
	}, "success must clear last_error and advance last_attempt")
}

// TestNotifierOverlappingAttemptsProbePairing pins the pair-publication
// contract (b-F1 fix): last_attempt/last_error describe the most recent
// COMPLETED attempt — published together, under one lock hold, only at
// completion. Attempt A (slow: held at the mock until released, then 429)
// starts at t0; attempt B (fast 404) starts at t0+301 and completes while A
// is still in flight. At every observation point the timestamp and the error
// must belong to the SAME attempt: the zero state while nothing has
// completed (an in-flight attempt is invisible), exactly B's pair once B
// completes, then exactly A's pair — with A's EARLIER start time — once A
// completes. Completion order is gated by channels, not sleeps; a background
// sampler additionally rejects any mixed pairing it ever observes.
func TestNotifierOverlappingAttemptsProbePairing(t *testing.T) {
	f := newNotifyFixture(t)
	captureLogger(f) // A and B both fail — keep their lines out of stderr
	_ = f.tokens.Upsert("tok-ov", "", "")

	const t0 = int64(1_700_000_000) // the fixture clock's frozen start

	// A dedicated mock gated per attempt (the stock fcmMock serializes
	// handlers under its mutex, so a blocking responder there would block
	// B too): attempt A (vh_ts=1) is HELD until released, then answers 429;
	// any other request (attempt B, vh_ts=2) answers a generic 404 at once.
	arrivedA := make(chan struct{}, 1)
	releaseACh := make(chan struct{})
	var releaseOnce sync.Once
	releaseA := func() { releaseOnce.Do(func() { close(releaseACh) }) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body fcmRequestBody
		_ = json.Unmarshal(b, &body)
		if body.Message.Data["vh_ts"] == "1" {
			arrivedA <- struct{}{}
			<-releaseACh
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":404,"status":"NOT_FOUND","message":"x"}}`))
	}))
	t.Cleanup(srv.Close)
	// Failure-path liveness: if the test fatals while A is still held,
	// release it so srv.Close (registered above; cleanups run LIFO) can
	// finish instead of deadlocking on the held handler.
	t.Cleanup(releaseA)
	f.nt.fcmBase = srv.URL

	// The sampler records every (timestamp, error) tuple Health() ever
	// exposes; each observed tuple must be one attempt's OWN pair.
	healthPair := struct {
		mu   sync.Mutex
		seen map[[2]string]int
	}{seen: map[[2]string]int{}}
	stopSample := make(chan struct{})
	sampleDone := make(chan struct{})
	go func() {
		defer close(sampleDone)
		tick := time.NewTicker(200 * time.Microsecond)
		defer tick.Stop()
		for {
			select {
			case <-stopSample:
				return
			case <-tick.C:
				at, lastErr := f.nt.Health()
				ts := "0" // the pre-completion zero state (time.Time{}.Unix() is -62135596800)
				if !at.IsZero() {
					ts = strconv.FormatInt(at.Unix(), 10)
				}
				p := [2]string{ts, lastErr}
				healthPair.mu.Lock()
				healthPair.seen[p]++
				healthPair.mu.Unlock()
			}
		}
	}()

	// Attempt A (slow): finished at t0 — held at the mock before its response.
	f.nt.Send(notice(TypeFinished, "", 1))
	select {
	case <-arrivedA:
	case <-time.After(2 * time.Second):
		t.Fatal("attempt A never reached the mock FCM endpoint")
	}

	// While A is in flight and NOTHING has completed, the probe must show
	// the untouched zero state — an in-flight attempt is invisible.
	if at, lastErr := f.nt.Health(); !at.IsZero() || lastErr != "" {
		t.Fatalf("A in flight, none completed: probe = (%v, %q), want zero/empty", at, lastErr)
	}

	// Attempt B (fast): runaway at t0+301 (clock advanced past cooldown; a
	// different type is a different cooldown key) — completes while A is held.
	f.clk.advance(301 * time.Second)
	f.nt.Send(notice(TypeRunaway, "", 2))
	eventually(t, func() bool {
		at, lastErr := f.nt.Health()
		return at.Unix() == t0+301 && lastErr == "404 NOT_FOUND"
	}, "while A is in flight and B has completed, the probe must show exactly B's pair")

	// Release A: it completes AFTER B and the probe must flip to A's own
	// pair — A's earlier start time with A's outcome, never B's timestamp
	// paired with A's error.
	releaseA()
	eventually(t, func() bool {
		at, lastErr := f.nt.Health()
		return at.Unix() == t0 && lastErr == "429 RESOURCE_EXHAUSTED"
	}, "after A completes, the probe must show exactly A's pair (earlier start time, its own outcome)")

	// Counters are unchanged by the pair-publication move: two attempts,
	// both failed (429 quota, 404 rejected), nothing pruned or succeeded.
	f.nt.statMu.Lock()
	attempted, succeeded, failed, pruned := f.nt.attempted, f.nt.succeeded, f.nt.failed, f.nt.pruned
	f.nt.statMu.Unlock()
	if attempted != 2 || succeeded != 0 || failed != 2 || pruned != 0 {
		t.Fatalf("window counters = attempted:%d succeeded:%d failed:%d pruned:%d, want 2/0/2/0", attempted, succeeded, failed, pruned)
	}
	if f.tokens.Count() != 1 {
		t.Fatal("neither a 429 nor a generic 404 may prune the registration")
	}

	// Every tuple the sampler ever observed must be a legal same-attempt pair:
	// the zero state, B's pair, or A's pair — never a mix.
	close(stopSample)
	<-sampleDone
	legal := map[[2]string]bool{
		{"0", ""}:                                true,
		{"1700000301", "404 NOT_FOUND"}:          true, // B's pair
		{"1700000000", "429 RESOURCE_EXHAUSTED"}: true, // A's pair
	}
	healthPair.mu.Lock()
	defer healthPair.mu.Unlock()
	for p := range healthPair.seen {
		if !legal[p] {
			t.Fatalf("probe exposed a mixed pair (%s, %q) — timestamp and error must belong to the same attempt", p[0], p[1])
		}
	}
}

// TestNotifierHealthLoopLine pins the periodic channel-health line: a short
// ticker fires a summary carrying enabled, token counts by policy, and the
// attempted/succeeded/failed/pruned window counters (which reset per line).
func TestNotifierHealthLoopLine(t *testing.T) {
	f := newNotifyFixture(t)
	sb := captureLogger(f)
	_ = f.tokens.Upsert("tok-h-a", "", "always")
	_ = f.tokens.Upsert("tok-h-b", "", "") // when_unattended

	// Deterministic per-token outcomes (fan-out order is not): tok-h-a
	// succeeds, tok-h-b is UNREGISTERED and pruned.
	f.fcm.setRespondToken(func(token string) (int, string) {
		if token == "tok-h-a" {
			return 200, "{}"
		}
		return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	})
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	f.fcm.waitNext(t)
	// Wait for the counters to settle BEFORE starting the loop so the first
	// health line observes the full window (logHealth resets on each line).
	eventually(t, func() bool {
		f.nt.statMu.Lock()
		defer f.nt.statMu.Unlock()
		return f.nt.attempted == 2 && f.nt.succeeded == 1 && f.nt.pruned == 1 && f.nt.failed == 0
	}, "window counters must settle at 2 attempted / 1 succeeded / 1 pruned")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.nt.StartHealthLoop(ctx, 20*time.Millisecond)

	eventually(t, func() bool {
		line := sb.String()
		return strings.Contains(line, `msg="notify: channel health"`) &&
			strings.Contains(line, "enabled=true") &&
			strings.Contains(line, "tokens_always=1") &&
			strings.Contains(line, "tokens_when_unattended=0") && // tok-h-b was pruned
			strings.Contains(line, "attempted=2") &&
			strings.Contains(line, "succeeded=1") &&
			strings.Contains(line, "failed=0") &&
			strings.Contains(line, "pruned=1")
	}, "health line must fire with the window counters")
	cancel() // loop exits on ctx cancellation
}
