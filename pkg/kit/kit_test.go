package kit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleKit = "testdata/sample"

func TestInstallSubstitutesAndLayers(t *testing.T) {
	repo := t.TempDir()
	rep, err := Install(sampleKit, repo, map[string]string{
		"controller_url": "https://ctrl.example",
		"api_token":      "secret123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Kit != "sample" || rep.Version != "1.0.0" {
		t.Fatalf("report kit/version wrong: %+v", rep)
	}
	// Engine file substituted (incl. default worker_id and provided values).
	cfg := readFile(t, filepath.Join(repo, "config.json"))
	if !strings.Contains(cfg, `"https://ctrl.example"`) || !strings.Contains(cfg, `"w1"`) || !strings.Contains(cfg, `"secret123"`) {
		t.Fatalf("config substitution wrong: %s", cfg)
	}
	// Nested engine path created.
	if !strings.Contains(readFile(t, filepath.Join(repo, ".opencode/agent.md")), "engine agent for w1") {
		t.Fatal("nested engine file not written/substituted")
	}
	// Overlay file written on first install.
	if !strings.Contains(readFile(t, filepath.Join(repo, "policy.md")), "consumer policy") {
		t.Fatal("overlay file not written")
	}
	// Lockfile records the install, excludes the secret param.
	lock, err := Status(repo)
	if err != nil || lock == nil {
		t.Fatalf("status/lockfile missing: %v", err)
	}
	if _, hasSecret := lock.Parameters["api_token"]; hasSecret {
		t.Fatal("secret parameter must not be recorded in the lockfile")
	}
	if lock.Parameters["controller_url"] != "https://ctrl.example" {
		t.Fatalf("lockfile param wrong: %v", lock.Parameters)
	}
}

func TestReinstallPreservesOverlayOverwritesEngine(t *testing.T) {
	repo := t.TempDir()
	params := map[string]string{"controller_url": "https://a"}
	if _, err := Install(sampleKit, repo, params); err != nil {
		t.Fatal(err)
	}
	// Consumer edits the overlay AND the engine file.
	overlay := filepath.Join(repo, "policy.md")
	engine := filepath.Join(repo, "config.json")
	writeFile(t, overlay, "MY CUSTOM POLICY")
	writeFile(t, engine, "MY EDIT")

	// Re-install with a changed engine-affecting param.
	rep, err := Install(sampleKit, repo, map[string]string{"controller_url": "https://b"})
	if err != nil {
		t.Fatal(err)
	}
	// Overlay preserved (consumer edit intact).
	if got := readFile(t, overlay); got != "MY CUSTOM POLICY" {
		t.Fatalf("overlay must be preserved on re-install, got %q", got)
	}
	if !contains(rep.Preserved, "policy.md") {
		t.Fatalf("policy.md should be reported preserved: %+v", rep.Preserved)
	}
	// Engine overwritten with the new param value.
	if got := readFile(t, engine); !strings.Contains(got, "https://b") {
		t.Fatalf("engine file must be overwritten on update, got %q", got)
	}
}

func TestEngineKeepMarkerNotClobbered(t *testing.T) {
	repo := t.TempDir()
	if _, err := Install(sampleKit, repo, map[string]string{"controller_url": "https://a"}); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(repo, "config.json")
	writeFile(t, engine, "pinned by me // vh:keep")
	rep, err := Install(sampleKit, repo, map[string]string{"controller_url": "https://b"})
	if err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, engine); got != "pinned by me // vh:keep" {
		t.Fatalf("engine file with vh:keep must not be clobbered, got %q", got)
	}
	if !contains(rep.Kept, "config.json") {
		t.Fatalf("config.json should be reported kept: %+v", rep.Kept)
	}
}

func TestMissingRequiredParam(t *testing.T) {
	repo := t.TempDir()
	_, err := Install(sampleKit, repo, map[string]string{}) // controller_url missing
	if err == nil || !strings.Contains(err.Error(), "controller_url") {
		t.Fatalf("want missing-required error mentioning controller_url, got %v", err)
	}
}

func TestUnknownParamRejected(t *testing.T) {
	repo := t.TempDir()
	_, err := Install(sampleKit, repo, map[string]string{"controller_url": "x", "bogus": "y"})
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("want unknown-param error mentioning bogus, got %v", err)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
