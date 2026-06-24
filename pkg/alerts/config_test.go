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
		t.Errorf("active profile = %q", c.ActiveProfile().Name)
	}
}
