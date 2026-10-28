package web

// Queue dispatch-policy suite (task `queue-policy-send-now` slice B1; the
// 2026-10-29 amendment §3 policy semantics, §4 G3 schema contract, §2
// escalation). The drain-loop crux (now dispatches while observably busy,
// queue still waits) lives in queue_policy_crux_test.go — it was authored
// RED-FIRST against the pre-policy tree and compiles against pre-B1 APIs.
//
// Coverage here:
//   - policy validation: absence→queue; explicit queue/now round-trip;
//     null/empty/unsupported/wrong-type → 400 queue_invalid_dispatch_policy
//     with NO store effect (bytes preserved); now under daemon-off → 409
//     queue_dispatch_policy_unsupported (never degraded);
//   - G3 schema: lazy atomic 1→2 upgrade in the same save as the first `now`
//     persistence; no gratuitous upgrade of legacy-only files; no
//     auto-downgrade; schema-2 + daemon-off refuses BEFORE any mutation with
//     bytes preserved and a visible mode-required conflict;
//   - receipt byte-compatibility fixture: a schema-1-era queue receipt's
//     canonical bytes are unchanged after the policy-era upgrade/rewrite;
//     `now` items include the member;
//   - recovery×policy: a requeued `now` item resumes under busy (the
//     `queue` arm is pinned by TestQueueIdleGateResumeWaitsForIdle);
//   - escalation (model (a) cancel + re-admit): happy path, fence rejection
//     by generation, dedupe non-collapse, non-pending refusal, concurrent
//     double-escalation;
//   - capability advert: present iff the policy scheduler is active;
//   - legacy pin: daemon-off schema-1 behavior unchanged.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// --- helpers -----------------------------------------------------------------

// rawReceiptBytes extracts the raw canonical JSON bytes of one admission
// receipt from a queue.json file (byte-level fixture comparison — json.RawMessage
// preserves the file's exact bytes for that member).
func rawReceiptBytes(t *testing.T, path, admissionID string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	recs, ok := doc["admissionReceipts"]
	if !ok {
		t.Fatalf("no admissionReceipts member in %s", path)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(recs, &m); err != nil {
		t.Fatal(err)
	}
	raw, ok := m[admissionID]
	if !ok {
		t.Fatalf("no receipt for %q in %s", admissionID, path)
	}
	return raw
}

// fileVersionStr reads the queue.json top-level version member ("" when the
// key is absent — the legacy no-version shape).
func fileVersionStr(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	v, ok := doc["version"]
	if !ok {
		return ""
	}
	return string(v)
}

// --- policy validation --------------------------------------------------------

// Store-level: absence ≡ queue (""), explicit "queue" normalizes to "", "now"
// round-trips, anything else is errQueueInvalidDispatchPolicy with no effect.
func TestQueuePolicyStoreValidation(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })

	s, _ := newTestStore(t, "s1")
	absent, _, err := s.EnqueueAdmission("", "", "", "absent policy", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if absent.DispatchPolicy != "" {
		t.Fatalf("absent policy stored as %q, want normalized \"\"", absent.DispatchPolicy)
	}
	explicit, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyQueue, "explicit queue", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if explicit.DispatchPolicy != "" {
		t.Fatalf("explicit queue stored as %q, want normalized \"\" (byte-compat elision)", explicit.DispatchPolicy)
	}
	now, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyNow, "explicit now", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if now.DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("now stored as %q, want \"now\"", now.DispatchPolicy)
	}
	for _, bad := range []QueueDispatchPolicy{"later", "NOW", "Queue"} {
		if _, _, err := s.EnqueueAdmission("", "", bad, "x", nil, QueueSendConfig{}, ""); !errors.Is(err, errQueueInvalidDispatchPolicy) {
			t.Fatalf("policy %q: err=%v, want errQueueInvalidDispatchPolicy", bad, err)
		}
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("invalid-policy admissions must have no effect: %d items", len(got))
	}
}

// Store-level: `now` under an inactive scheduler is refused (G3 now-under-
// legacy-drainer), never degraded.
func TestQueuePolicyNowRefusedUnderDaemonOff(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	if _, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyNow, "must refuse", nil, QueueSendConfig{}, ""); !errors.Is(err, errQueuePolicyUnsupported) {
		t.Fatalf("now under daemon-off: err=%v, want errQueuePolicyUnsupported", err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("refused now admission had an effect: %d items", len(got))
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatalf("refused now admission created the queue file: %v", err)
	}
}

// HTTP-level validation matrix: the illegal shapes are 400s with the
// machine-readable code and NO store effect; absent/"queue"/"now" admit.
func TestQueuePolicyHTTPValidationMatrix(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	web, root := newQueueTestServer(t)
	sid := "s_pol"

	post := func(body map[string]any) (int, map[string]any) {
		t.Helper()
		resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", body)
		defer resp.Body.Close()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatalf("decode %d: %v", resp.StatusCode, err)
		}
		return resp.StatusCode, m
	}

	// Absent member → queue default; explicit "queue" → the same elided
	// representation; "now" → materialized.
	code, body := post(map[string]any{"text": "absent"})
	if code != 200 {
		t.Fatalf("absent policy: %d %v", code, body)
	}
	code, body = post(map[string]any{"text": "explicit queue", "dispatchPolicy": "queue"})
	if code != 200 {
		t.Fatalf("explicit queue: %d %v", code, body)
	}
	code, body = post(map[string]any{"text": "explicit now", "dispatchPolicy": "now"})
	if code != 200 {
		t.Fatalf("explicit now: %d %v", code, body)
	}
	item := body["item"].(map[string]any)
	if item["dispatchPolicy"] != "now" {
		t.Fatalf("now admission echoed dispatchPolicy=%v, want \"now\"", item["dispatchPolicy"])
	}

	// The persisted file: only the now item materializes the member.
	data, err := os.ReadFile(queuePath(root, sid))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for _, it := range doc.Items {
		switch it.Text {
		case "explicit now":
			if it.DispatchPolicy != QueueDispatchPolicyNow {
				t.Fatalf("now item persisted policy %q", it.DispatchPolicy)
			}
		default:
			if it.DispatchPolicy != "" {
				t.Fatalf("queue item %q persisted policy %q, want elided", it.Text, it.DispatchPolicy)
			}
		}
	}

	// Illegal shapes → 400 + code, bytes preserved.
	before, err := os.ReadFile(queuePath(root, sid))
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]string{
		"null":         `null`,
		"empty string": `""`,
		"unsupported":  `"later"`,
		"wrong type":   `5`,
		"object":       `{"policy":"now"}`,
	} {
		// Build the body with a raw JSON member via a map[string]any that
		// marshals the member verbatim: use json.RawMessage.
		body := json.RawMessage(`{"text":"bad","dispatchPolicy":` + raw + `}`)
		req, err := http.NewRequest(http.MethodPost, web.URL+"/vh/session/"+sid+"/queue", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(csrfHeader, "1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status=%d %v, want 400", name, resp.StatusCode, m)
		}
		if m["code"] != "queue_invalid_dispatch_policy" {
			t.Fatalf("%s: code=%v, want queue_invalid_dispatch_policy", name, m["code"])
		}
	}
	after, err := os.ReadFile(queuePath(root, sid))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("queue.json mutated across refused admissions (bytes must be preserved)")
	}
}

// HTTP-level now-under-legacy: daemon OFF refuses `now` (409 code) without
// creating the file, while the legacy admission path keeps working.
func TestQueuePolicyHTTPNowUnderDaemonOff(t *testing.T) {
	web, root := newQueueTestServer(t) // daemon dispatch OFF
	sid := "s_off"

	resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "now while off", "dispatchPolicy": "now"})
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("now under daemon-off: status=%d %v, want 409", resp.StatusCode, m)
	}
	if m["code"] != "queue_dispatch_policy_unsupported" {
		t.Fatalf("now under daemon-off: code=%v, want queue_dispatch_policy_unsupported", m["code"])
	}
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("refused now admission created the queue file: %v", err)
	}
	// The legacy default path is unaffected.
	ok := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "legacy still works"})
	defer ok.Body.Close()
	if ok.StatusCode != 200 {
		t.Fatalf("legacy admission after refusal: %d", ok.StatusCode)
	}
}

// --- G3 schema -----------------------------------------------------------------

// Atomic 1→2 upgrade: the file stays 1 across queue-only admissions, and the
// FIRST save persisting a `now` item stamps 2 in the SAME write.
func TestQueueSchemaAtomicUpgradeBeforeFirstNowPersist(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	s, _ := newTestStore(t, "s1")

	if _, err := s.Enqueue("queue-only", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, s.path); v != "1" {
		t.Fatalf("after queue-only admission version=%s, want 1 (no gratuitous upgrade)", v)
	}
	if _, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyNow, "the first now", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	raw := string(mustReadFile(t, s.path))
	if v := fileVersionStr(t, s.path); v != "2" {
		t.Fatalf("after first now persistence version=%s, want 2 (same atomic write): %s", v, raw)
	}
	if !strings.Contains(raw, `"dispatchPolicy": "now"`) {
		t.Fatalf("v2 file lacks the persisted now item:\n%s", raw)
	}
}

// No gratuitous upgrade of a LEGACY (no-version) file: mutations under the
// policy-capable daemon keep writing schema 1 while the file holds no now
// item.
func TestQueueSchemaNoGratuitousLegacyUpgrade(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	p := seedQueueFileBody(t, root, "s1", `{"order":1,"items":[`+
		`{"id":"q-leg","order":1,"state":"pending","text":"legacy","attachments":[],"createdAt":1700000000000}]}`)
	s := &sessionQueueStore{path: p}
	if _, err := s.Enqueue("another queue item", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, p); v != "1" {
		t.Fatalf("legacy-only file upgraded to %s, want 1 (gratuitous upgrade forbidden)", v)
	}
}

// No auto-downgrade: once v2, further queue-only mutations keep v2.
func TestQueueSchemaNoAutoDowngrade(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	s, _ := newTestStore(t, "s1")
	if _, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyNow, "now item", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, s.path); v != "2" {
		t.Fatalf("setup: version=%s, want 2", v)
	}
	if _, err := s.Enqueue("queue-only after v2", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, s.path); v != "2" {
		t.Fatalf("queue-only mutation after v2 downgraded to %s (auto-downgrade forbidden)", v)
	}
}

// Schema 2 + daemon OFF: refuse BEFORE any mutation, bytes preserved, at
// both the store layer (List/Enqueue/Claim/Resolve/Remove) and the HTTP
// layer (409 queue_schema_mode_required — a visible mode-required conflict,
// never an authoritative empty queue).
func TestQueueSchema2DaemonOffRefusesBeforeAnyMutation(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	persisted := func() []byte {
		s, _ := newTestStore(t, "s1")
		if _, _, err := s.EnqueueAdmission("", "", QueueDispatchPolicyNow, "held now item", nil, QueueSendConfig{}, ""); err != nil {
			t.Fatal(err)
		}
		return mustReadFile(t, s.path)
	}
	before := persisted()
	SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) }) // stays off for this test

	// A fresh store at the same bytes (the restart-equivalent posture).
	root := t.TempDir()
	p := seedQueueFileRaw(t, root, "s1", before)
	fresh := &sessionQueueStore{path: p}

	for name, fn := range map[string]func() error{
		"List":    func() error { _, err := fresh.List(); return err },
		"Enqueue": func() error { _, err := fresh.Enqueue("x", nil, QueueSendConfig{}, ""); return err },
		"Claim":   func() error { _, _, err := fresh.Claim(); return err },
		"Resolve": func() error { _, err := fresh.Resolve("q-none", QueueSent, ""); return err },
		"Remove":  func() error { return fresh.Remove("q-none") },
	} {
		if err := fn(); !errors.Is(err, errQueueSchemaModeRequired) {
			t.Fatalf("%s under schema2+daemon-off: err=%v, want errQueueSchemaModeRequired", name, err)
		}
	}
	assertQueueFileUnchanged(t, p, before)

	// HTTP layer: the refusal surfaces as a 409 mode-required conflict with
	// a machine-readable code and the queueHeld binding — and NO byte moves.
	web, root := newQueueTestServer(t) // daemon OFF; its root is the default project
	p2 := seedQueueFileRaw(t, root, "s_schema2", before)
	lr, err := http.Get(web.URL + "/vh/session/s_schema2/queue")
	if err != nil {
		t.Fatal(err)
	}
	if lr.StatusCode != http.StatusConflict {
		t.Fatalf("HTTP list under schema2+daemon-off: %d, want 409", lr.StatusCode)
	}
	okBody, code := decodeQueueErr(t, lr)
	if okBody || code != "queue_schema_mode_required" {
		t.Fatalf("HTTP list code=%q ok=%v, want queue_schema_mode_required", code, okBody)
	}
	mut := csrfPost(t, web.URL+"/vh/session/s_schema2/queue", map[string]any{"text": "must not land"})
	if mut.StatusCode != http.StatusConflict {
		t.Fatalf("HTTP enqueue under schema2+daemon-off: %d, want 409", mut.StatusCode)
	}
	_, code = decodeQueueErr(t, mut)
	if code != "queue_schema_mode_required" {
		t.Fatalf("HTTP enqueue code=%q, want queue_schema_mode_required", code)
	}
	assertQueueFileUnchanged(t, p2, before)
}

// Schema 2 under an ACTIVE scheduler loads cleanly (validating the policy
// members); an item carrying an unsupported policy value in a v2 file is
// semantic corruption — refused, bytes preserved.
func TestQueueSchema2DaemonOnLoads(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	const itemJSON = `{"id":"q-v2","order":1,"state":"pending","text":"held","attachments":[],"createdAt":1700000000000,"dispatchPolicy":"now"}`
	p := seedQueueFileBody(t, root, "s1", `{"version":2,"order":1,"items":[`+itemJSON+`]}`)
	s := &sessionQueueStore{path: p}
	items, err := s.List()
	if err != nil {
		t.Fatalf("schema2 + scheduler-on List: %v", err)
	}
	if len(items) != 1 || items[0].DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("schema2 items: %+v", items)
	}
	// A v2 file with an unsupported policy value is corrupt-class.
	bad := seedQueueFileBody(t, root, "s2", `{"version":2,"order":1,"items":[`+
		`{"id":"q-bad","order":1,"state":"pending","text":"x","attachments":[],"createdAt":1700000000000,"dispatchPolicy":"whenever"}]}`)
	before := mustReadFile(t, bad)
	if _, err := (&sessionQueueStore{path: bad}).List(); !errors.Is(err, errQueueFileCorrupt) {
		t.Fatalf("unsupported policy in v2: err=%v, want errQueueFileCorrupt", err)
	}
	assertQueueFileUnchanged(t, bad, before)
}

// Legacy pin: daemon-off schema-1 files keep exactly the pre-policy
// behavior (loads, admits, claims) and stay version 1.
func TestQueuePolicyLegacyDaemonOffSchema1Unchanged(t *testing.T) {
	root := t.TempDir()
	p := seedQueueFileBody(t, root, "s1", `{"version":1,"order":1,"items":[`+
		`{"id":"q-1","order":1,"state":"pending","text":"legacy pending","attachments":[],"createdAt":1700000000000}]}`)
	s := &sessionQueueStore{path: p}
	items, err := s.List()
	if err != nil {
		t.Fatalf("daemon-off v1 List: %v", err)
	}
	if len(items) != 1 || items[0].State != QueuePending || items[0].DispatchPolicy != "" {
		t.Fatalf("daemon-off v1 items: %+v", items)
	}
	if _, err := s.Enqueue("still fine", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatalf("daemon-off v1 Enqueue: %v", err)
	}
	claimed, won, err := s.Claim()
	if err != nil || !won || claimed.ID != "q-1" {
		t.Fatalf("daemon-off v1 Claim: won=%v err=%v", won, err)
	}
	if v := fileVersionStr(t, p); v != "1" {
		t.Fatalf("daemon-off v1 file version=%s, want 1", v)
	}
}

// --- receipt byte-compatibility fixture (G3 test obligation) -------------------

// A schema-1-era queue admission's receipt keeps IDENTICAL canonical bytes
// across the policy-era upgrade + rewrite; a `now` admission's receipt
// includes the member.
func TestQueueReceiptByteCompatFixture(t *testing.T) {
	// Era 1 (schema-1): a plain queue admission with a receipt.
	s1, root := newTestStore(t, "s1")
	first, _, err := s1.EnqueueWithAttemptID("att-era1", "hello", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	p := queuePath(root, "s1")
	if v := fileVersionStr(t, p); v != "1" {
		t.Fatalf("era-1 file version=%s, want 1", v)
	}
	era1Receipt := rawReceiptBytes(t, p, "att-era1")
	if strings.Contains(string(era1Receipt), "dispatchPolicy") {
		t.Fatalf("era-1 receipt already carries a policy member: %s", era1Receipt)
	}

	// Era 2 (policy): the same queue re-opened by a policy-capable daemon —
	// a further queue admission rewrites the file (still v1), then the
	// first `now` admission upgrades it to v2. The era-1 receipt's bytes
	// must be unchanged through BOTH rewrites.
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	s2 := &sessionQueueStore{path: p}
	if _, err := s2.Enqueue("era-2 queue item", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, p); v != "1" {
		t.Fatalf("after era-2 queue-only admission version=%s, want 1", v)
	}
	if got := rawReceiptBytes(t, p, "att-era1"); string(got) != string(era1Receipt) {
		t.Fatalf("era-1 receipt bytes changed across a queue-only rewrite:\n was: %s\n now: %s", era1Receipt, got)
	}
	nowItem, _, err := s2.EnqueueAdmission("att-era2-now", "", QueueDispatchPolicyNow, "hello", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, p); v != "2" {
		t.Fatalf("after era-2 now admission version=%s, want 2", v)
	}
	// THE FIXTURE ASSERTION: identical canonical bytes for the
	// normalized-queue receipt after the schema-2 upgrade.
	if got := rawReceiptBytes(t, p, "att-era1"); string(got) != string(era1Receipt) {
		t.Fatalf("era-1 receipt bytes changed across the schema-2 upgrade:\n was: %s\n now: %s", era1Receipt, got)
	}
	// The now receipt DOES carry the member (policy distinction), and the
	// fingerprints differ (policy joins admission identity).
	nowReceipt := rawReceiptBytes(t, p, "att-era2-now")
	if !strings.Contains(string(nowReceipt), `"dispatchPolicy": "now"`) {
		t.Fatalf("now receipt lacks the policy member: %s", nowReceipt)
	}
	var era1Rec, nowRec queueAdmissionReceipt
	if err := json.Unmarshal(era1Receipt, &era1Rec); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(nowReceipt, &nowRec); err != nil {
		t.Fatal(err)
	}
	if era1Rec.Fingerprint == nowRec.Fingerprint {
		t.Fatalf("same payload with different policies fingerprinted identically — policy must join admission identity")
	}
	if nowRec.Item.DispatchPolicy != QueueDispatchPolicyNow || nowItem.DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("now receipt/item policy lost: %+v / %+v", nowRec.Item, nowItem)
	}
	// Cross-era replay: the era-1 attempt id with the SAME payload (policy
	// absent) replays the ORIGINAL receipt; with policy `now` it CONFLICTS
	// (non-collapse).
	rep, replayed, err := s2.EnqueueWithAttemptID("att-era1", "hello", nil, QueueSendConfig{}, "")
	if err != nil || !replayed || rep.ID != first.ID || rep.DispatchPolicy != "" {
		t.Fatalf("era-1 replay after upgrade: replayed=%v item=%+v err=%v", replayed, rep, err)
	}
	if _, _, err := s2.EnqueueAdmission("", "att-era1", QueueDispatchPolicyNow, "hello", nil, QueueSendConfig{}, ""); !errors.Is(err, errQueueAdmissionConflict) {
		t.Fatalf("era-1 attempt id replayed as now: err=%v, want errQueueAdmissionConflict (distinct admission)", err)
	}
}

// --- recovery × policy -----------------------------------------------------------

// A requeued (certified-resume) `now` item redispatches WITHOUT waiting for
// idle; same correlation id. (The `queue` arm — resume waits — is pinned by
// TestQueueIdleGateResumeWaitsForIdle; not duplicated here.)
func TestQueuePolicyNowRecoveryRedispatchesUnderBusy(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_RP"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_CP","parentID":"ses_RP"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_CP","status":{"type":"busy"}}`))

	st := srv.queues.store(root, "ses_RP")
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:                "rq-now-1",
		Order:             1,
		State:             QueueDispatching,
		Text:              "requeued now while busy",
		SendConfig:        QueueSendConfig{Agent: "build"},
		DispatchPolicy:    QueueDispatchPolicyNow,
		OpencodeMsgID:     "resume-mid-now",
		ClaimGeneration:   1,
		DispatchStartedAt: time.Now().UnixMilli(),
		RequeuePending:    true,
		Attempts:          []QueueAttempt{{Generation: 1, TransportClass: QueueAttemptConnectFailed, Detail: "dial tcp: refused"}},
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// While the subtree is observably busy the now-policy resume fires with
	// the SAME correlation id — the queue-policy variant of corner 7.
	waitForDrain(t, 5*time.Second, "the now-policy resume under busy", func() bool { return f.arrivals() == 1 })
	if ids := f.messageIDs(); len(ids) != 1 || ids[0] != "resume-mid-now" {
		t.Fatalf("resume messageIDs = %v, want exactly [resume-mid-now]", ids)
	}
}

// --- escalation -------------------------------------------------------------------

// Happy path through the REAL loop token + HTTP route: a pending queue item
// on a busy tree escalates (cancel + re-admit as now) and dispatches exactly
// once while busy; the original id disappears; the new item carries the
// escalation provenance.
func TestQueueEscalationHappyPath(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()
	webURL := srvLocalURL(t, srv)

	store.Apply(ev("session.created", `{"info":{"id":"ses_E1"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_CE","parentID":"ses_E1"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_CE","status":{"type":"busy"}}`))

	// Wait for the loop's custody before escalating (the handler needs a
	// live token).
	lockPath := filepath.Join(root, ".vh-solara", custodyLockFileRel)
	waitForDrain(t, 5*time.Second, "the drain loop's custody acquisition", func() bool {
		return custodyLockHeld(lockPath)
	})

	st := srv.queues.store(root, "ses_E1")
	orig, _, err := st.EnqueueWithAttemptID("att-esc", "escalate me", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}
	// The busy tree holds the original (it never dispatches as queue).
	time.Sleep(400 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("pre-escalation arrivals = %d, want 0 (queue policy held)", n)
	}

	resp := csrfPost(t, webURL+"/vh/session/ses_E1/queue/"+orig.ID+"/escalate", map[string]any{})
	defer resp.Body.Close()
	var body struct {
		Item QueueItem `json:"item"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != 200 {
		t.Fatalf("escalate: %d %v", resp.StatusCode, err)
	}
	esc := body.Item
	if esc.ID == orig.ID || esc.DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("escalated item = %+v, want fresh id + policy now", esc)
	}
	if !strings.Contains(esc.Detail, orig.ID) {
		t.Fatalf("escalated item lacks provenance detail: %q", esc.Detail)
	}

	// Exactly one dispatch, while the tree is still busy.
	waitForDrain(t, 5*time.Second, "the escalated item's dispatch under busy", func() bool { return f.arrivals() == 1 })
	if busy, _ := store.TreeBusyForDispatch("ses_E1"); !busy {
		t.Fatal("tree unexpectedly idle — the test's busy posture was lost")
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != esc.ID || items[0].State != QueueDispatching {
		t.Fatalf("post-escalation items = %+v, want exactly the escalated item dispatching", items)
	}
	// The original admission's receipt is INTACT and still answers replays
	// with the ORIGINAL (queue-policy) snapshot.
	rep, replayed, err := st.EnqueueWithAttemptID("att-esc", "escalate me", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil || !replayed || rep.ID != orig.ID || rep.DispatchPolicy != "" {
		t.Fatalf("original receipt after escalation: replayed=%v item=%+v err=%v", replayed, rep, err)
	}
}

// Fence rejection: a stale generation token cannot escalate — the item and
// the receipts are untouched.
func TestQueueEscalationFenceRejectsStaleGeneration(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	st := newQueueRegistry().store(root, "s1")
	orig, _, err := st.EnqueueWithAttemptID("att-fence", "fenced escalation", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}

	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	// Out-of-band authority bump: a NEWER owner now exists.
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	if err := writeCustodyGeneration(genPath, tok.Generation()+1); err != nil {
		t.Fatal(err)
	}

	before := mustReadFile(t, st.path)
	if _, err := st.EscalatePendingToNow(tok, orig.ID); !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale-token escalation: err=%v, want errQueueFenced", err)
	}
	assertQueueFileUnchanged(t, st.path, before)
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != orig.ID || items[0].State != QueuePending || items[0].DispatchPolicy != "" {
		t.Fatalf("fenced escalation mutated the item: %+v", items)
	}
}

// Dedupe non-collapse + non-pending refusal + concurrent double-escalation
// (store level, live token).
func TestQueueEscalationDedupeNonCollapseAndGuards(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	st := newQueueRegistry().store(root, "s1")
	orig, _, err := st.EnqueueWithAttemptID("att-dedupe", "dedupe me", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}

	// Same admission id + same payload + DIFFERENT policy → conflict, NOT a
	// collapse into the original admission.
	if _, _, err := st.EnqueueAdmission("att-dedupe", "", QueueDispatchPolicyNow, "dedupe me", nil, QueueSendConfig{Agent: "build"}, ""); !errors.Is(err, errQueueAdmissionConflict) {
		t.Fatalf("policy-flipped replay: err=%v, want errQueueAdmissionConflict", err)
	}

	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	esc, err := st.EscalatePendingToNow(tok, orig.ID)
	if err != nil {
		t.Fatalf("escalate: %v", err)
	}
	if esc.ID == orig.ID || esc.DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("escalated item = %+v", esc)
	}
	// The original receipt survives verbatim — the escalation was NOT
	// swallowed as a duplicate of the original admission.
	rep, replayed, err := st.EnqueueWithAttemptID("att-dedupe", "dedupe me", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil || !replayed || rep.ID != orig.ID || rep.DispatchPolicy != "" {
		t.Fatalf("post-escalation replay: replayed=%v item=%+v err=%v (want the ORIGINAL queue admission)", replayed, rep, err)
	}
	// Re-escalating the ORIGINAL (now absent) id is a clean not-found.
	if _, err := st.EscalatePendingToNow(tok, orig.ID); !errors.Is(err, errQueueNotFound) {
		t.Fatalf("re-escalation of the consumed id: err=%v, want errQueueNotFound", err)
	}
	// Escalating the already-now item is an idempotent no-op.
	noop, err := st.EscalatePendingToNow(tok, esc.ID)
	if err != nil || noop.ID != esc.ID {
		t.Fatalf("re-escalation of a now item: err=%v item=%+v, want no-op", err, noop)
	}
}

// Non-pending refusal: a claimed (dispatching) item cannot escalate — the
// in-flight dispatch is owned by the custody state machine.
func TestQueueEscalationNonPendingRefused(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	st := newQueueRegistry().store(root, "s1")
	it, err := st.Enqueue("then claim", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.Claim(); err != nil {
		t.Fatal(err)
	}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	if _, err := st.EscalatePendingToNow(tok, it.ID); !errors.Is(err, errQueueNotEscalatable) {
		t.Fatalf("escalation of a dispatching item: err=%v, want errQueueNotEscalatable", err)
	}
}

// Concurrent double-escalation of one pending item: exactly one caller wins,
// the loser gets not-found, and exactly ONE now item exists afterward.
func TestQueueEscalationConcurrentExactlyOnce(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	st := newQueueRegistry().store(root, "s1")
	orig, err := st.Enqueue("race escalation", nil, QueueSendConfig{Agent: "build"}, "")
	if err != nil {
		t.Fatal(err)
	}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	wins := make([]QueueItem, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			wins[i], errs[i] = st.EscalatePendingToNow(tok, orig.ID)
		}(i)
	}
	close(start)
	wg.Wait()

	nOK, id := 0, ""
	for i := 0; i < 2; i++ {
		if errs[i] == nil {
			nOK++
			id = wins[i].ID
		} else if !errors.Is(errs[i], errQueueNotFound) {
			t.Fatalf("loser %d err=%v, want errQueueNotFound", i, errs[i])
		}
	}
	if nOK != 1 {
		t.Fatalf("winners = %d, want exactly 1", nOK)
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != id || items[0].DispatchPolicy != QueueDispatchPolicyNow {
		t.Fatalf("post-race items = %+v, want exactly the one escalated now item", items)
	}
}

// --- capability advert ---------------------------------------------------------

// queueDispatchPolicyVersion is advertised ONLY while the policy scheduler
// is active; the key is absent otherwise.
func TestQueuePolicyCapabilityAdvert(t *testing.T) {
	// Off (newQueueTestServer ships daemon dispatch off).
	web, _ := newQueueTestServer(t)
	resp, err := http.Get(web.URL + "/vh/version")
	if err != nil {
		t.Fatal(err)
	}
	var off map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&off); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if v, ok := off["queueDispatchPolicyVersion"]; ok {
		t.Fatalf("queueDispatchPolicyVersion advertised with the scheduler off: %v", v)
	}

	// On (the drain-test server enables the flag — the same enablement that
	// runs the loop).
	f := newFakeOCForDrain(t)
	srv, _ := newDrainTestServer(t, f)
	onURL := srvLocalURL(t, srv)
	resp2, err := http.Get(onURL + "/vh/version")
	if err != nil {
		t.Fatal(err)
	}
	var on map[string]any
	if err := json.NewDecoder(resp2.Body).Decode(&on); err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if v, ok := on["queueDispatchPolicyVersion"].(float64); !ok || v != float64(queueDispatchPolicyVersion) {
		t.Fatalf("queueDispatchPolicyVersion with scheduler on = %v, want %d", on["queueDispatchPolicyVersion"], queueDispatchPolicyVersion)
	}
}

// --- commit-review B-F1/B-F2 regressions -------------------------------------
//
// Two review blockers on this slice, both G3 contract_drift:
//   - B-F1: save() did not advance the in-memory schema floor, so removing
//     the (only) now item rewrote the file as schema 1 while the retained
//     now-bearing receipt stayed inside it.
//   - B-F2: the archive/cleanup deletion path (CleanupSession/deleteStore,
//     including the automatic reconcileOrphanQueues pass) unlinked
//     policy-bearing schema-2 files while daemon dispatch was off.

// B-F1 regression: admit an IDENTIFIED now item, remove it on the SAME live
// store, then require (a) the persisted file version stays 2 — the retained
// receipt is now-bearing, so a schema-1 rewrite would smuggle policy bytes
// past the daemon-off load() refusal — and (b) a daemon-off reopen of that
// file still refuses with the mode-required conflict, including the case
// where ONLY the retained receipt survives (no live items).
func TestQueueSchemaFloorAdvancesOnSaveNoDowngradeAfterNowRemoval(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	s, _ := newTestStore(t, "s1")

	it, _, err := s.EnqueueAdmission("att-now", "", QueueDispatchPolicyNow, "now then removed", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, s.path); v != "2" {
		t.Fatalf("setup: after the now admission version=%s, want 2", v)
	}

	// Remove on the SAME live store: no live now item remains, but the
	// retained admission receipt still carries the now-bearing item.
	if err := s.Remove(it.ID); err != nil {
		t.Fatal(err)
	}
	if v := fileVersionStr(t, s.path); v != "2" {
		t.Fatalf("after removing the now item: version=%s, want 2 (the retained receipt is now-bearing; no downgrade)", v)
	}
	if rec := rawReceiptBytes(t, s.path, "att-now"); !strings.Contains(string(rec), `"dispatchPolicy": "now"`) {
		t.Fatalf("retained receipt lost its now-bearing item: %s", rec)
	}

	// Daemon-off reopen of the receipt-only file: still the mode-required
	// refusal (the restart posture — a fresh store, same bytes).
	SetDaemonDispatchEnabled(false)
	fresh := &sessionQueueStore{path: s.path}
	if _, err := fresh.List(); !errors.Is(err, errQueueSchemaModeRequired) {
		t.Fatalf("daemon-off reopen of the receipt-only file: err=%v, want errQueueSchemaModeRequired", err)
	}
}

// B-F2(a): daemon-off + schema-2 file + direct CleanupSession → the file
// STILL EXISTS with byte-identical content, the mode-required conflict is
// logged, and session archival itself completes (registry entry dropped,
// BLK-1 tombstone set — the bounded leak is the file, not the store).
func TestQueueCleanupSessionPreservesSchema2UnderDaemonOff(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	root := t.TempDir()
	reg := newQueueRegistry()
	st := reg.store(root, "s1")
	if _, _, err := st.EnqueueAdmission("", "", QueueDispatchPolicyNow, "policy-bearing", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	before := mustReadFile(t, st.path)
	SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })

	var mu sync.Mutex
	var buf bytes.Buffer
	prev := vhlog.SetOutput(lockedWriter{&mu, &buf})
	defer vhlog.SetOutput(prev)

	reg.CleanupSession(root, "s1")

	if _, err := os.Stat(st.path); err != nil {
		t.Fatalf("schema-2 queue.json removed under daemon-off: %v", err)
	}
	assertQueueFileUnchanged(t, st.path, before)
	mu.Lock()
	out := buf.String()
	mu.Unlock()
	if !strings.Contains(out, "mode-required") {
		t.Fatalf("mode-required conflict not surfaced by cleanup: log=%q", out)
	}
	// Archival completed: a fresh lookup builds a NEW store, and the
	// retained pointer is tombstoned.
	if st2 := reg.store(root, "s1"); st2 == st {
		t.Fatal("registry still holds the cleaned session's store")
	}
	st.mu.Lock()
	archived := st.archived
	st.mu.Unlock()
	if !archived {
		t.Fatal("cleaned store was not tombstoned — session archival did not complete")
	}
}

// B-F2(b): daemon-off + automatic reconcileOrphanQueues with the session
// absent from the active set → the schema-2 file is preserved. The file here
// is filesystem-only (never loaded through the registry) — exactly the
// orphan posture the automatic pass reconciles.
func TestQueueReconcileOrphansPreserveSchema2UnderDaemonOff(t *testing.T) {
	SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	p := seedQueueFileBody(t, root, "orphan_v2", `{"version":2,"order":1,"items":[`+
		`{"id":"q-o2","order":1,"state":"pending","text":"held now","attachments":[],"createdAt":1700000000000,"dispatchPolicy":"now"}]}`)
	before := mustReadFile(t, p)

	if err := newQueueRegistry().reconcileOrphanQueues(root, map[string]bool{}, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("schema-2 orphan queue.json removed by daemon-off reconciliation: %v", err)
	}
	assertQueueFileUnchanged(t, p, before)
}

// B-F2(c): daemon-ON + the same scenarios → files cleaned exactly as before
// (schema 2 is legally operable when the scheduler is active). A
// behavior-preservation pin for the fix — not reachable red, since the
// defect is the daemon-off deletion only.
func TestQueueCleanupDaemonOnCleansSchema2AsBefore(t *testing.T) {
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	reg := newQueueRegistry()

	// Direct CleanupSession on a live, policy-bearing store.
	st := reg.store(root, "s_direct")
	if _, _, err := st.EnqueueAdmission("", "", QueueDispatchPolicyNow, "policy-bearing", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	reg.CleanupSession(root, "s_direct")
	if _, err := os.Stat(st.path); !os.IsNotExist(err) {
		t.Fatalf("daemon-on CleanupSession left the schema-2 file: %v", err)
	}

	// Automatic reconciliation of a filesystem-only schema-2 orphan.
	p := seedQueueFileBody(t, root, "s_orphan", `{"version":2,"order":0,"items":[]}`)
	if err := reg.reconcileOrphanQueues(root, map[string]bool{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("daemon-on reconciliation left the schema-2 orphan: %v", err)
	}
}

// B-F2(d): daemon-off + schema-1 (and legacy no-version) files → cleaned as
// before; the preservation rule is keyed to POLICY-BEARING files only.
func TestQueueCleanupDaemonOffStillCleansSchema1(t *testing.T) {
	SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	root := t.TempDir()
	reg := newQueueRegistry()
	p1 := seedQueueFileBody(t, root, "s_v1", `{"version":1,"order":0,"items":[]}`)
	p0 := seedQueueFileBody(t, root, "s_legacy", `{"order":0,"items":[]}`)

	reg.CleanupSession(root, "s_v1")
	if _, err := os.Stat(p1); !os.IsNotExist(err) {
		t.Fatalf("daemon-off CleanupSession left a schema-1 file: %v", err)
	}
	if err := reg.reconcileOrphanQueues(root, map[string]bool{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p0); !os.IsNotExist(err) {
		t.Fatalf("daemon-off reconciliation left a legacy no-version file: %v", err)
	}
}
