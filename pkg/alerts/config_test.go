package alerts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigRoundTripPreservesHeaderAndUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "alerts.jsonc")
	src := `// my alerts config
// keep this comment
{
  "active_profile": "At desk",
  "custom_future_key": {"keep": true},
  "channels": [],
  "profiles": []
}
`
	if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := s.SetActive("Away"); err != nil {
		t.Fatalf("set active: %v", err)
	}
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, "// my alerts config") || !strings.Contains(got, "// keep this comment") {
		t.Errorf("header comment lost:\n%s", got)
	}
	if !strings.Contains(got, "custom_future_key") {
		t.Errorf("unknown key dropped:\n%s", got)
	}
	if !strings.Contains(got, `"active_profile": "Away"`) {
		t.Errorf("active not updated:\n%s", got)
	}
	// reload to confirm it's still valid + the value stuck
	s2, err := NewStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if s2.Get().Active != "Away" {
		t.Errorf("reloaded active = %q, want Away", s2.Get().Active)
	}
}

func TestResolveEnv(t *testing.T) {
	t.Setenv("VH_ALERT_TEST_URL", "https://hooks.example/abc")
	if got := resolveEnv("${VH_ALERT_TEST_URL}/x"); got != "https://hooks.example/abc/x" {
		t.Errorf("resolveEnv = %q", got)
	}
}

func TestDefaultConfigSeedsProfiles(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	c := s.Get()
	if len(c.Profiles) != 3 {
		t.Errorf("want 3 built-in profiles, got %d", len(c.Profiles))
	}
	if c.ActiveProfile().Name != "At desk" {
		t.Errorf("active profile = %q, want At desk", c.ActiveProfile().Name)
	}
}

// TestConfigNotifyConfigured pins the config-presence half of "notify
// configured?": a nil section and a section without a credentials file are
// unconfigured; a credentials file makes it configured (project/ttl are
// optional — project falls back to the credentials file).
func TestConfigNotifyConfigured(t *testing.T) {
	var c Config
	if c.NotifyConfigured() {
		t.Error("nil notify section must be unconfigured")
	}
	c.Notify = &NotifyConfig{ProjectID: "p", TtlSec: 3600}
	if c.NotifyConfigured() {
		t.Error("notify without credentials_file must be unconfigured")
	}
	c.Notify.CredentialsFile = "/secrets/fcm.json"
	if !c.NotifyConfigured() {
		t.Error("notify with credentials_file must be configured")
	}
	// Value receiver: callable on non-addressable snapshots (Engine.NotifyReady
	// chains it directly on Store.Get()).
	if !c.NotifyConfigured() {
		t.Error("NotifyConfigured must work on a value copy")
	}
}

// TestConfigFreshRenderIncludesNotify pins the fresh-render save path: a
// store whose first write carries a notify section must RENDER it (the
// seeded-file path used to drop the section silently), in topOrder position,
// and reload it intact. A nil section still omits the key entirely.
func TestConfigFreshRenderIncludesNotify(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "alerts.jsonc")

	// Fresh render with a notify section (raw is empty → the fresh path).
	s := &Store{path: path, cfg: DefaultConfig()}
	s.cfg.Notify = &NotifyConfig{CredentialsFile: "/secrets/fcm.json", ProjectID: "proj-1", TtlSec: 3600}
	if err := s.save(); err != nil {
		t.Fatalf("fresh save: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	if !strings.Contains(got, `"notify"`) || !strings.Contains(got, "/secrets/fcm.json") || !strings.Contains(got, `"proj-1"`) {
		t.Fatalf("fresh render dropped the notify section:\n%s", got)
	}
	if strings.Index(got, `"notify"`) < strings.Index(got, `"channels"`) {
		t.Fatalf("notify must render after channels (topOrder):\n%s", got)
	}
	// Reload round-trips the section.
	s2, err := NewStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	n := s2.Get().Notify
	if n == nil || n.CredentialsFile != "/secrets/fcm.json" || n.ProjectID != "proj-1" || n.TtlSec != 3600 {
		t.Fatalf("reloaded notify drift: %+v", n)
	}

	// The default seed (nil notify) must NOT contain the key.
	path2 := filepath.Join(dir, "seed.jsonc")
	if _, err := NewStore(path2); err != nil {
		t.Fatal(err)
	}
	raw2, err := os.ReadFile(path2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw2), "notify") {
		t.Fatalf("default seed must omit notify when nil:\n%s", raw2)
	}
}

// TestConfigSurgicalAppendNotify pins the topOrder half of the fix: saving a
// notify section onto a hand-written file that lacks the key appends it (at
// the topOrder position), instead of dropping it.
func TestConfigSurgicalAppendNotify(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "alerts.jsonc")
	src := `{
  "active_profile": "At desk",
  "channels": [],
  "profiles": []
}
`
	if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(path)
	if err != nil {
		t.Fatal(err)
	}
	c := s.Get()
	c.Notify = &NotifyConfig{CredentialsFile: "/secrets/fcm.json", ProjectID: "proj-1"}
	if err := s.Replace(c); err != nil {
		t.Fatalf("replace: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	if !strings.Contains(got, `"notify"`) || !strings.Contains(got, "/secrets/fcm.json") {
		t.Fatalf("surgical save dropped the notify section:\n%s", got)
	}
	// The untouched keys keep their bytes.
	if !strings.Contains(got, `"active_profile": "At desk"`) {
		t.Fatalf("surgical save disturbed existing keys:\n%s", got)
	}
}
