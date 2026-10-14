package alerts

// notify_test.go — lane-1 tests for the FCM HTTP v1 notify sender
// (pkg/alerts/notify.go): mock token + FCM servers, real RSA service-account
// credentials, the OAuth2 JWT flow, the data-only message contract, delivery
// gating (mirroring Web Push), UNREGISTERED pruning, token caching, and
// init-failure → channel-disabled semantics.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
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

func (m *fcmMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	rec := fcmReceipt{Path: r.URL.Path, Authorization: r.Header.Get("Authorization"), Raw: b}
	_ = json.Unmarshal(b, &rec.Body)
	m.mu.Lock()
	m.count++
	status, body := m.respond(m.count)
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
}

func newNotifyFixture(t *testing.T) *notifyFixture {
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
		_, _ = w.Write([]byte(`{"access_token":"test-access-token","expires_in":3600,"token_type":"Bearer"}`))
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

	return &notifyFixture{cfg: cfg, pres: pres, tokens: tokens, nt: nt, fcm: fcm, tmu: tmu, priv: priv, clk: clk}
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
	if err := f.tokens.Upsert("device-token-1", ""); err != nil {
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
	if err := f.tokens.Upsert("device-token-1", "phone"); err != nil {
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

// --- condition + priority mapping table ---

// TestNotifierConditionAndPriorityMapping pins the full vh_condition table
// and the HIGH-only-for-waiting priority rule, end to end through Send.
func TestNotifierConditionAndPriorityMapping(t *testing.T) {
	f := newNotifyFixture(t)
	if err := f.tokens.Upsert("device-token-1", ""); err != nil {
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
		{Notice{Type: TypeStalled, Title: "OpenCode", Ts: 107}, condWorkerDown, "NORMAL"},
	}

	byTS := map[string]fcmReceipt{}
	for _, c := range cases {
		f.nt.Send(c.n)
		r := f.fcm.waitNext(t)
		byTS[r.Body.Message.Data["vh_ts"]] = r
		// Step the frozen clock past cooldown_sec (300s) so the next send —
		// including another waiting — is a fresh cooldown window. 7 steps of
		// 301s stay inside the cached OAuth token's 3600s validity.
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
	if err := f.tokens.Upsert("device-token-1", ""); err != nil {
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
	if err := f.tokens.Upsert("device-token-1", ""); err != nil {
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
	if err := f.tokens.Upsert("device-token-1", ""); err != nil {
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
// evidence in the error body's details — 400 INVALID_ARGUMENT or 404
// NOT_FOUND with the FcmError detail. A generic 404 NOT_FOUND (FCM's answer
// to sender-side misconfiguration, e.g. a wrong/deleted project ID) and a
// 400 with another reason must NOT prune: pruning on those would mass-erase
// every valid registration.
func TestNotifierPrunesUnregisteredTokens(t *testing.T) {
	const unregistered400Body = `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	const invalidBody = `{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}`
	const unregistered404Body = `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`
	const projectNotFoundBody = `{"error":{"code":404,"status":"NOT_FOUND","message":"Requested entity was not found"}}`

	// Case 1: 400 + UNREGISTERED detail → pruned.
	f := newNotifyFixture(t)
	f.fcm.setRespond(func(int) (int, string) { return 400, unregistered400Body })
	_ = f.tokens.Upsert("tok-a", "")
	f.nt.Send(notice(TypeFinished, "", 1))
	f.fcm.waitNext(t)
	eventually(t, func() bool { return f.tokens.Count() == 0 }, "400 UNREGISTERED must prune the token")

	// Case 2: 404 + UNREGISTERED detail → pruned.
	f2 := newNotifyFixture(t)
	f2.fcm.setRespond(func(int) (int, string) { return 404, unregistered404Body })
	_ = f2.tokens.Upsert("tok-b", "")
	f2.nt.Send(notice(TypeFinished, "", 1))
	f2.fcm.waitNext(t)
	eventually(t, func() bool { return f2.tokens.Count() == 0 }, "404 UNREGISTERED must prune the token")

	// Case 3: 404 generic/project NOT_FOUND (no UNREGISTERED detail) →
	// RETAINED — sender-side misconfiguration must not erase registrations.
	f3 := newNotifyFixture(t)
	f3.fcm.setRespond(func(int) (int, string) { return 404, projectNotFoundBody })
	_ = f3.tokens.Upsert("tok-c", "")
	f3.nt.Send(notice(TypeFinished, "", 1))
	f3.fcm.waitNext(t)
	time.Sleep(300 * time.Millisecond) // give a (wrong) prune path a chance
	if f3.tokens.Count() != 1 {
		t.Fatal("404 without UNREGISTERED detail must NOT prune the token")
	}

	// Case 4: 400 with another reason → kept.
	f4 := newNotifyFixture(t)
	f4.fcm.setRespond(func(int) (int, string) { return 400, invalidBody })
	_ = f4.tokens.Upsert("tok-d", "")
	f4.nt.Send(notice(TypeFinished, "", 1))
	f4.fcm.waitNext(t)
	time.Sleep(300 * time.Millisecond) // give the prune path (wrongly) a chance
	if f4.tokens.Count() != 1 {
		t.Fatal("400 non-UNREGISTERED must NOT prune the token")
	}
}

// --- token cache ---

// TestNotifierTokenCacheReuse: two deliveries share one OAuth2 exchange; the
// cached access token serves the second send.
func TestNotifierTokenCacheReuse(t *testing.T) {
	f := newNotifyFixture(t)
	_ = f.tokens.Upsert("tok-a", "")
	_ = f.tokens.Upsert("tok-b", "")

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
	_ = f.tokens.Upsert("tok-a", "")
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
	_ = f.tokens.Upsert("tok-a", "")
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
	_ = f.tokens.Upsert("tok-default", "")

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
	_ = f.tokens.Upsert("tok-engine", "")
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
