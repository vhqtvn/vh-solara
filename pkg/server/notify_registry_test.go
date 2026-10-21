package server

// notify_registry_test.go — lane-1 tests for the controller's enrolled
// notify-source registry (notify controller-hub S2 / v4 §2 step 2, §9.7):
// record/reject/remove semantics, the one-source-per-worker binding, the
// mixed-version downgrade path, persisted-anchor reload discipline, and the
// secret-hygiene rule that Describe never carries tokens.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

func goodEnroll(sourceID, token string) *tunnel.NotifyEnrollment {
	wm := int64(7)
	return &tunnel.NotifyEnrollment{
		SourceID:  sourceID,
		Epoch:     "0123456789abcdef0123456789abcdef",
		NotifyCap: 1,
		Mode:      "controller",
		Fenced:    true,
		Watermark: &wm,
		Token:     token,
	}
}

func token64() string { return strings.Repeat("ab", 32) }

func TestNotifyRegistryRecordsAndUpdates(t *testing.T) {
	r := newNotifySourceRegistry()
	if !r.RecordNotifyEnrollment(goodEnroll("bason", token64()), "bason", "bason-name") {
		t.Fatal("valid enrollment must be recorded")
	}
	e, ok := r.Get("bason")
	if !ok {
		t.Fatal("entry missing after enrollment")
	}
	if e.SourceID != "bason" || e.WorkerID != "bason" || e.WorkerName != "bason-name" ||
		e.Epoch != "0123456789abcdef0123456789abcdef" || e.NotifyCap != 1 ||
		e.Mode != "controller" || !e.Fenced || e.Watermark == nil || *e.Watermark != 7 {
		t.Fatalf("entry mismatch: %+v", e)
	}
	if e.Token != token64() {
		t.Fatal("Get (the internal pull path) must expose the token")
	}
	if e.LastSeen == 0 || time.Now().UnixMilli()-e.LastSeen > 5000 {
		t.Fatalf("lastSeen must stamp the carrying registration, got %d", e.LastSeen)
	}

	// Re-enrollment (reconnect) refreshes the entry — a NEW epoch tracks a
	// genuine source rotation, and the token rotates with the process.
	e2 := goodEnroll("bason", strings.Repeat("cd", 32))
	e2.Epoch = "ffffffffffffffffffffffffffffffff"
	if !r.RecordNotifyEnrollment(e2, "bason", "bason-name") {
		t.Fatal("re-enrollment must be recorded")
	}
	got, _ := r.Get("bason")
	if got.Epoch != "ffffffffffffffffffffffffffffffff" || got.Token != strings.Repeat("cd", 32) {
		t.Fatalf("re-enrollment must refresh epoch+token, got %+v", got)
	}
}

func TestNotifyRegistryRejectsMalformedAndMismatched(t *testing.T) {
	r := newNotifySourceRegistry()

	// Malformed block (failed tunnel.Validate): rejected, never recorded —
	// but the caller (handleWorkerWS) still registers the tunnel.
	bad := goodEnroll("bason", token64())
	bad.Epoch = ""
	if r.RecordNotifyEnrollment(bad, "bason", "b") {
		t.Fatal("invalid enrollment must not be recorded")
	}
	if _, ok := r.Get("bason"); ok {
		t.Fatal("rejected enrollment must leave no entry")
	}

	// One-source-per-worker: a self-asserted source_id != worker id is a
	// rejected binding, never a record ("a self-asserted worker ID is not
	// sufficient security evidence").
	if r.RecordNotifyEnrollment(goodEnroll("not-bason", token64()), "bason", "b") {
		t.Fatal("mismatched source_id must be rejected")
	}
	if _, ok := r.Get("not-bason"); ok {
		t.Fatal("mismatched enrollment must not create an entry under the asserted id")
	}
}

func TestNotifyRegistryNilBlockRemovesEntry(t *testing.T) {
	// v4 §9.7 mixed-version downgrade: a re-registration WITHOUT the notify
	// block means the capability disappeared — central eligibility stops.
	r := newNotifySourceRegistry()
	if !r.RecordNotifyEnrollment(goodEnroll("bason", token64()), "bason", "b") {
		t.Fatal("seed enrollment failed")
	}
	if r.RecordNotifyEnrollment(nil, "bason", "b") {
		t.Fatal("nil enrollment must not report an eligible entry")
	}
	if _, ok := r.Get("bason"); ok {
		t.Fatal("nil enrollment must REMOVE the entry (capability disappeared)")
	}
	// Removing an absent entry is a calm no-op.
	if r.RecordNotifyEnrollment(nil, "ghost", "g") {
		t.Fatal("nil enrollment on an unknown worker reports ineligible")
	}
}

func TestNotifyRegistryPersistedAnchor(t *testing.T) {
	dir := t.TempDir()
	anchor := filepath.Join(dir, "notify.json.sources")

	r := newNotifySourceRegistry()
	if err := r.armNotifySources(anchor); err != nil {
		t.Fatalf("arm on a missing anchor must start empty: %v", err)
	}
	if !r.RecordNotifyEnrollment(goodEnroll("bason", token64()), "bason", "bason") {
		t.Fatal("enrollment failed")
	}
	// One worker WITHOUT capability, then another with: only the capable
	// one persists.
	if r.RecordNotifyEnrollment(nil, "legacy", "legacy") {
		t.Fatal("nil block must report ineligible")
	}
	if !r.RecordNotifyEnrollment(goodEnroll("kilo", strings.Repeat("ef", 32)), "kilo", "kilo") {
		t.Fatal("second enrollment failed")
	}
	if _, err := os.Stat(anchor); err != nil {
		t.Fatalf("anchor must be written: %v", err)
	}

	// Reload: the enrolled sources survive a controller restart.
	r2 := newNotifySourceRegistry()
	if err := r2.armNotifySources(anchor); err != nil {
		t.Fatalf("reload: %v", err)
	}
	for _, id := range []string{"bason", "kilo"} {
		e, ok := r2.Get(id)
		if !ok {
			t.Fatalf("%s must survive the reload", id)
		}
		if e.Token == "" {
			t.Fatal("the persisted entry carries the pull-path token")
		}
	}
	if _, ok := r2.Get("legacy"); ok {
		t.Fatal("the downgrade-removed worker must not persist")
	}

	// Malformed anchor: load error, never a silent reset.
	if err := os.WriteFile(anchor, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r3 := newNotifySourceRegistry()
	if err := r3.armNotifySources(anchor); err == nil {
		t.Fatal("malformed anchor must fail loudly")
	}
	// Wrong schema: same discipline.
	bad := []byte(`{"schema":99,"sources":[]}`)
	if err := os.WriteFile(anchor, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := newNotifySourceRegistry().armNotifySources(anchor); err == nil {
		t.Fatal("schema mismatch must fail loudly")
	}
}

func TestNotifyRegistryDescribeNeverCarriesTokens(t *testing.T) {
	r := newNotifySourceRegistry()
	if !r.RecordNotifyEnrollment(goodEnroll("bason", token64()), "bason", "b") {
		t.Fatal("enrollment failed")
	}
	for _, e := range r.Describe() {
		if e.Token != "" {
			t.Fatalf("Describe must strip tokens, got %q", e.Token)
		}
	}
	// The zero-value Daemon posture: no registry, no panic, empty report.
	var d Daemon
	if got := d.DescribeNotifySources(); len(got) != 0 {
		t.Fatalf("zero-value Daemon must describe empty, got %+v", got)
	}
}

// --- B2: enrollment is recorded only from an AUTHENTICATED registration ---

// TestDaemonNotifyEnrollmentGatedOnAuthenticatedRegistration pins the B2
// gate at the daemon decision seam (handleWorkerWS delegates here): a
// carried notify block is recorded as an eligible enrollment ONLY when the
// registration posture is authenticated (RegSecret configured — the
// constant-time check upstream already verified the dial). In the open
// posture the SAME structurally valid block is refused and the worker is
// explicitly marked notify-ineligible instead.
func TestDaemonNotifyEnrollmentGatedOnAuthenticatedRegistration(t *testing.T) {
	regFrom := func(workerID string, notify *tunnel.NotifyEnrollment) *tunnel.RegisterMessage {
		return &tunnel.RegisterMessage{
			BaseMessage: tunnel.BaseMessage{WorkerID: workerID},
			WorkerName:  workerID + "-name",
			Notify:      notify,
		}
	}

	// Open posture (RegSecret unset — the historical default): a valid
	// block must NOT enroll; the explicit ineligible marker appears.
	open := &Daemon{RegSecret: "", notifySources: newNotifySourceRegistry()}
	open.recordNotifyEnrollment(regFrom("bason", goodEnroll("bason", token64())))
	if e, ok := open.notifySources.Get("bason"); !ok || !e.Ineligible {
		t.Fatalf("open-posture block must be explicitly notify-ineligible, got %+v ok=%v", e, ok)
	}
	if e, _ := open.notifySources.Get("bason"); e.Token != "" || e.Epoch != "" || e.NotifyCap != 0 {
		t.Fatalf("ineligible marker must carry no enrolled state, got %+v", e)
	}

	// Authenticated posture (RegSecret configured): the same block records
	// the eligible enrollment.
	authed := &Daemon{RegSecret: "s3cret", notifySources: newNotifySourceRegistry()}
	authed.recordNotifyEnrollment(regFrom("bason", goodEnroll("bason", token64())))
	if e, ok := authed.notifySources.Get("bason"); !ok || e.Ineligible || e.Token != token64() {
		t.Fatalf("authenticated registration must record the eligible enrollment, got %+v ok=%v", e, ok)
	}

	// A nil block takes the ordinary capability-disappeared path in BOTH
	// postures (the legacy wire shape — no marker for a never-advertised
	// capability; an existing entry is removed).
	for _, d := range []*Daemon{open, authed} {
		d.recordNotifyEnrollment(regFrom("bason", nil))
		if _, ok := d.notifySources.Get("bason"); ok {
			t.Fatalf("nil block must remove the entry (posture secret=%q)", d.RegSecret)
		}
	}

	// Zero-value Daemon (no registry): calm no-op, never a panic.
	var bare Daemon
	bare.recordNotifyEnrollment(regFrom("x", goodEnroll("x", token64())))
}

// TestNotifyRegistryMarkIneligibleSemantics pins the marker's lifecycle: a
// later AUTHENTICATED enrollment of the same source overwrites it; the
// marker persists across a controller restart until then; and a nil-block
// re-registration removes it (capability disappeared).
func TestNotifyRegistryMarkIneligibleSemantics(t *testing.T) {
	dir := t.TempDir()
	anchor := filepath.Join(dir, "notify.json.sources")
	r := newNotifySourceRegistry()
	if err := r.armNotifySources(anchor); err != nil {
		t.Fatal(err)
	}

	// Refused → marker; refresh is calm (still exactly one entry).
	r.MarkNotifyIneligible("bason", "bason-name")
	r.MarkNotifyIneligible("bason", "bason-name")
	if got := len(r.Describe()); got != 1 {
		t.Fatalf("repeated refusal must not duplicate entries, got %d", got)
	}
	e, ok := r.Get("bason")
	if !ok || !e.Ineligible || e.WorkerName != "bason-name" || e.LastSeen == 0 {
		t.Fatalf("marker mismatch: %+v ok=%v", e, ok)
	}

	// The marker survives a restart (an operator sees the refusal).
	r2 := newNotifySourceRegistry()
	if err := r2.armNotifySources(anchor); err != nil {
		t.Fatal(err)
	}
	if e, ok := r2.Get("bason"); !ok || !e.Ineligible || e.Token != "" {
		t.Fatalf("marker must survive reload, got %+v ok=%v", e, ok)
	}

	// A later authenticated enrollment overwrites the marker.
	if !r2.RecordNotifyEnrollment(goodEnroll("bason", token64()), "bason", "bason-name") {
		t.Fatal("authenticated enrollment after the marker must be recorded")
	}
	if e, _ := r2.Get("bason"); e.Ineligible || e.Token != token64() {
		t.Fatalf("eligible enrollment must overwrite the marker, got %+v", e)
	}

	// And a nil-block re-registration removes it again.
	if r2.RecordNotifyEnrollment(nil, "bason", "bason-name") {
		t.Fatal("nil block must not report eligible")
	}
	if _, ok := r2.Get("bason"); ok {
		t.Fatal("nil block must remove the marker")
	}
}
