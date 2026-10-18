package alerts

// tokens_test.go — lane-1 co-located unit tests for the FCM token registry
// (pkg/alerts/tokens.go): upsert idempotency, the cap, label truncation, and
// persistence round-trips.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotifyTokenUpsertIdempotent(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	if err := r.Upsert("tokA", "phone", ""); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := r.Upsert("tokA", "tablet", ""); err != nil {
		t.Fatalf("second upsert (same token): %v", err)
	}
	if got := r.Count(); got != 1 {
		t.Fatalf("count = %d, want 1 (idempotent by token)", got)
	}
	// The label is refreshed in place (verify through the persisted file, which
	// also proves the upsert persisted).
	r2 := NewTokenRegistry(t.TempDir()) // different dir: sanity empty
	if r2.Count() != 0 {
		t.Fatalf("fresh registry count = %d, want 0", r2.Count())
	}
	r.mu.Lock()
	stored, ok := r.tokens["tokA"]
	r.mu.Unlock()
	if !ok || stored.Label != "tablet" {
		t.Fatalf("stored entry = %+v, want label refreshed to \"tablet\"", stored)
	}
}

func TestNotifyTokenRequired(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	err := r.Upsert("", "label", "")
	if err != ErrNotifyTokenRequired {
		t.Fatalf("empty token error = %v, want ErrNotifyTokenRequired", err)
	}
	if err.Error() != "token required" {
		t.Fatalf("error text = %q, want the contract string \"token required\"", err.Error())
	}
}

func TestNotifyTokenCap(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	for i := 0; i < NotifyTokenCap; i++ {
		if err := r.Upsert(fmt.Sprintf("tok-%02d", i), "d", ""); err != nil {
			t.Fatalf("fill %d: %v", i, err)
		}
	}
	if got := r.Count(); got != NotifyTokenCap {
		t.Fatalf("count = %d, want %d", got, NotifyTokenCap)
	}
	// A NEW token at cap is rejected.
	if err := r.Upsert("tok-new", "d", ""); err != ErrNotifyTokenCap {
		t.Fatalf("cap error = %v, want ErrNotifyTokenCap", err)
	}
	// An ALREADY-REGISTERED token at cap still succeeds (idempotent upsert).
	if err := r.Upsert("tok-00", "refreshed", ""); err != nil {
		t.Fatalf("re-upsert of registered token at cap: %v", err)
	}
	if got := r.Count(); got != NotifyTokenCap {
		t.Fatalf("count after re-upsert = %d, want %d", got, NotifyTokenCap)
	}
}

func TestNotifyTokenLabelTruncated(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	long := strings.Repeat("x", 200)
	if err := r.Upsert("tokA", long, ""); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	stored := r.tokens["tokA"]
	r.mu.Unlock()
	if got := len([]rune(stored.Label)); got != NotifyLabelMax {
		t.Fatalf("stored label len = %d, want %d", got, NotifyLabelMax)
	}
}

func TestNotifyTokenPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	r := NewTokenRegistry(dir)
	if err := r.Upsert("tokB", "pixel", ""); err != nil {
		t.Fatal(err)
	}
	if err := r.Upsert("tokA", "iphone", ""); err != nil {
		t.Fatal(err)
	}

	// File shape: 0600, deterministic (sorted), values reloadable.
	path := filepath.Join(dir, "notify-tokens.json")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("registry file not written: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("registry file mode = %v, want 0600", fi.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"tokA"`) || strings.Index(string(raw), `"tokA"`) > strings.Index(string(raw), `"tokB"`) {
		t.Fatalf("registry file not sorted by token: %s", raw)
	}

	r2 := NewTokenRegistry(dir)
	if got := r2.Count(); got != 2 {
		t.Fatalf("reloaded count = %d, want 2", got)
	}
	r2.mu.Lock()
	a, aok := r2.tokens["tokA"]
	b, bok := r2.tokens["tokB"]
	r2.mu.Unlock()
	if !aok || a.Label != "iphone" || !bok || b.Label != "pixel" {
		t.Fatalf("reloaded entries drift: a=%+v ok=%v b=%+v ok=%v", a, aok, b, bok)
	}

	// Prune removes exactly the named tokens and persists the removal.
	if err := r2.Prune("tokA", "tok-ghost"); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if got := r2.Count(); got != 1 {
		t.Fatalf("post-prune count = %d, want 1", got)
	}
	r3 := NewTokenRegistry(dir)
	if got := r3.Count(); got != 1 {
		t.Fatalf("post-prune reload count = %d, want 1 (prune persisted)", got)
	}
}

// --- push policy (v3: per-token attendance exemption) ---

// TestNotifyTokenPolicyValidation pins the policy vocabulary: empty is the
// backward-compatible when_unattended default, when_unattended/always are
// accepted (canonicalized), and anything else — including "never" (removal =
// unsubscribe, there is no never policy) — is ErrNotifyTokenPolicy with the
// contract error text.
func TestNotifyTokenPolicyValidation(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	if err := r.Upsert("tok-default", "", ""); err != nil {
		t.Fatalf("empty policy (legacy POST body): %v", err)
	}
	if err := r.Upsert("tok-wu", "", "when_unattended"); err != nil {
		t.Fatalf("when_unattended: %v", err)
	}
	if err := r.Upsert("tok-always", "", "always"); err != nil {
		t.Fatalf("always: %v", err)
	}
	for _, bad := range []string{"never", "sometimes", "ALWAYS", "Always", "always ", "unattended"} {
		err := r.Upsert("tok-bad", "", bad)
		if err != ErrNotifyTokenPolicy {
			t.Fatalf("policy %q error = %v, want ErrNotifyTokenPolicy", bad, err)
		}
	}
	if err := ErrNotifyTokenPolicy.Error(); err != "invalid push_policy" {
		t.Fatalf("error text = %q, want the contract string \"invalid push_policy\"", err)
	}
	// The rejected upserts must not have registered anything.
	if got := r.Count(); got != 3 {
		t.Fatalf("count after rejected upserts = %d, want 3", got)
	}
}

// TestNotifyTokenUpsertRefreshesPolicy pins the upsert semantics: a re-POST
// of the same token refreshes label AND policy (the POST body is the full
// desired state — a re-POST without push_policy resets an always token to
// when_unattended), and the first-seen ts is kept.
func TestNotifyTokenUpsertRefreshesPolicy(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	if err := r.Upsert("tokA", "phone", "always"); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	ts1 := r.tokens["tokA"].Ts
	r.mu.Unlock()

	if err := r.Upsert("tokA", "tablet", ""); err != nil { // policy reset to default
		t.Fatal(err)
	}
	r.mu.Lock()
	stored := r.tokens["tokA"]
	r.mu.Unlock()
	if stored.Label != "tablet" || stored.PushPolicy != PolicyWhenUnattended {
		t.Fatalf("stored = %+v, want label tablet + when_unattended (re-POST resets policy)", stored)
	}
	if stored.Ts != ts1 {
		t.Fatalf("re-upsert must keep first-seen ts: %d != %d", stored.Ts, ts1)
	}

	// And back to always through the same path.
	if err := r.Upsert("tokA", "tablet", "always"); err != nil {
		t.Fatal(err)
	}
	if got := r.PolicyCounts()[PolicyAlways]; got != 1 {
		t.Fatalf("always count = %d, want 1", got)
	}
}

// TestNotifyTokenPolicyPersistence pins the persistence round-trip incl.
// legacy-file compat: push_policy=always persists as "push_policy":"always";
// the default omits the field (a pre-v3 file shape); a hand-written legacy
// file WITHOUT the field (and even with a garbage value) reloads as
// when_unattended.
func TestNotifyTokenPolicyPersistence(t *testing.T) {
	dir := t.TempDir()
	r := NewTokenRegistry(dir)
	if err := r.Upsert("tok-always", "pixel", "always"); err != nil {
		t.Fatal(err)
	}
	if err := r.Upsert("tok-default", "iphone", ""); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "notify-tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"push_policy": "always"`) {
		t.Fatalf("always policy must persist explicitly: %s", raw)
	}
	if strings.Contains(strings.Replace(string(raw), `"push_policy": "always"`, "", 1), "push_policy") {
		t.Fatalf("default (when_unattended) must omit push_policy (legacy file shape): %s", raw)
	}

	r2 := NewTokenRegistry(dir)
	r2.mu.Lock()
	a, aok := r2.tokens["tok-always"]
	d, dok := r2.tokens["tok-default"]
	r2.mu.Unlock()
	if !aok || a.PushPolicy != PolicyAlways {
		t.Fatalf("reloaded always entry = %+v ok=%v", a, aok)
	}
	if !dok || d.PushPolicy != PolicyWhenUnattended {
		t.Fatalf("reloaded default entry = %+v ok=%v (absent field → when_unattended)", d, dok)
	}
	if got := r2.PolicyCounts(); got[PolicyAlways] != 1 || got[PolicyWhenUnattended] != 1 {
		t.Fatalf("reloaded counts = %v, want 1/1", got)
	}
}

// TestNotifyTokenLegacyFileReload writes a pre-v3 notify-tokens.json by hand
// (no push_policy key at all — exactly what Slice 1/2 daemons persist) plus a
// hand-edited garbage policy, and proves the reload normalizes both to
// when_unattended (fail-closed: a file entry never widens delivery).
func TestNotifyTokenLegacyFileReload(t *testing.T) {
	dir := t.TempDir()
	legacy := `[
  {"token":"tok-legacy","label":"old-phone","ts":1700000000000},
  {"token":"tok-garbage","label":"","push_policy":"yolo","ts":1700000000001}
]`
	if err := os.WriteFile(filepath.Join(dir, "notify-tokens.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	r := NewTokenRegistry(dir)
	if got := r.Count(); got != 2 {
		t.Fatalf("legacy reload count = %d, want 2", got)
	}
	r.mu.Lock()
	l := r.tokens["tok-legacy"]
	g := r.tokens["tok-garbage"]
	r.mu.Unlock()
	if l.PushPolicy != PolicyWhenUnattended || g.PushPolicy != PolicyWhenUnattended {
		t.Fatalf("legacy=%q garbage=%q, both want when_unattended", l.PushPolicy, g.PushPolicy)
	}
	if l.Label != "old-phone" || l.Ts != 1700000000000 {
		t.Fatalf("legacy entry drift: %+v", l)
	}
	if got := r.PolicyCounts(); got[PolicyAlways] != 0 || got[PolicyWhenUnattended] != 2 {
		t.Fatalf("legacy counts = %v, want 0 always / 2 when_unattended", got)
	}
}
