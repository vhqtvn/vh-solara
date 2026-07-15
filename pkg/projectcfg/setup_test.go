package projectcfg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeCfg writes root/.vh-solara/project.jsonc and returns root + the resolved
// cfg/pref paths. A helper local to setup_test so each case starts from a known
// on-disk state.
func writeCfg(t *testing.T, body string) (root, cfgPath, prefPath string) {
	t.Helper()
	root = t.TempDir()
	cfgDir := filepath.Join(root, ".vh-solara")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath = filepath.Join(cfgDir, "project.jsonc")
	if err := os.WriteFile(cfgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	prefPath = filepath.Join(cfgDir, "preferences.local.jsonc")
	return root, cfgPath, prefPath
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestEnsureLocalSetup_MigratesAgentStyles: a project.jsonc with agentStyles
// (plus comments + siblings) gets the value moved to preferences.local.jsonc and
// removed from project.jsonc (comment-preserving), in one call.
func TestEnsureLocalSetup_MigratesAgentStyles(t *testing.T) {
	root, cfgPath, prefPath := writeCfg(t, `{
  // companion processes (trust-gated — must survive the edit)
  "processes": [{ "id": "p", "command": "echo hi" }],
  "agentStyles": { "build": { "label": "BLD", "color": "warn" } },
  "notes": true
}`)

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}

	// project.jsonc: agentStyles gone, comments + siblings intact.
	cfgAfter := read(t, cfgPath)
	if hasTopLevelKey(cfgAfter, "agentStyles") {
		t.Fatalf("agentStyles still present in project.jsonc:\n%s", cfgAfter)
	}
	if !strings.Contains(string(cfgAfter), "trust-gated — must survive") {
		t.Fatalf("comment lost from project.jsonc:\n%s", cfgAfter)
	}
	if !strings.Contains(string(cfgAfter), `"notes": true`) || !strings.Contains(string(cfgAfter), `"command": "echo hi"`) {
		t.Fatalf("sibling disturbed in project.jsonc:\n%s", cfgAfter)
	}
	// preferences.local.jsonc: created with the migrated agentStyles.
	if _, err := os.Stat(prefPath); os.IsNotExist(err) {
		t.Fatalf("preferences.local.jsonc not created")
	}
	styles, err := ParseAgentStyles(read(t, prefPath))
	if err != nil {
		t.Fatalf("overlay unparseable: %v", err)
	}
	if styles["build"].Label != "BLD" || styles["build"].Color != "warn" {
		t.Fatalf("migrated value wrong: %+v", styles)
	}
	// .vh-solara/.gitignore created with the prefs + runtime globs.
	gi := read(t, filepath.Join(root, ".vh-solara", ".gitignore"))
	for _, want := range []string{"*.local", "*.local.jsonc", "vh-solara local files", "/sessions/", "/run/"} {
		if !strings.Contains(string(gi), want) {
			t.Fatalf("gitignore missing %q:\n%s", want, gi)
		}
	}
}

// TestEnsureLocalSetup_Idempotent: running twice does no extra work — the second
// call is a no-op (no rewrite of either file, no gitignore churn).
func TestEnsureLocalSetup_Idempotent(t *testing.T) {
	root, cfgPath, prefPath := writeCfg(t, `{
  "agentStyles": { "build": { "label": "BLD" } }
}`)

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("first run: %v", err)
	}
	cfgAfter1 := read(t, cfgPath)
	prefAfter1 := read(t, prefPath)

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("second run: %v", err)
	}
	cfgAfter2 := read(t, cfgPath)
	prefAfter2 := read(t, prefPath)

	if string(cfgAfter1) != string(cfgAfter2) {
		t.Fatalf("second run rewrote project.jsonc:\n1: %s\n2: %s", cfgAfter1, cfgAfter2)
	}
	if string(prefAfter1) != string(prefAfter2) {
		t.Fatalf("second run rewrote preferences.local.jsonc:\n1: %s\n2: %s", prefAfter1, prefAfter2)
	}
}

// TestEnsureLocalSetup_OverlayExistsWithAgentStyles: when the overlay already
// declares agentStyles (a local edit), the local value is authoritative — it is
// kept intact and ONLY project.jsonc is cleaned (stale team default removed).
func TestEnsureLocalSetup_OverlayExistsWithAgentStyles(t *testing.T) {
	root, cfgPath, prefPath := writeCfg(t, `{
  "agentStyles": { "build": { "label": "BLD" } }
}`)
	// Pre-existing local overlay with its OWN agentStyles (the user's choice).
	local := `{ "agentStyles": { "supervisor": { "label": "SUP" } } }`
	if err := os.WriteFile(prefPath, []byte(local), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}

	// Overlay untouched (local wins).
	if got := string(read(t, prefPath)); got != local {
		t.Fatalf("local overlay was modified (should be authoritative):\nwant: %s\ngot:  %s", local, got)
	}
	// project.jsonc cleaned of the stale team default.
	if hasTopLevelKey(read(t, cfgPath), "agentStyles") {
		t.Fatalf("agentStyles still in project.jsonc:\n%s", read(t, cfgPath))
	}
}

// TestEnsureLocalSetup_OverlayExistsWithoutAgentStyles: when the overlay exists
// but lacks the key, the migrated value is spliced in.
func TestEnsureLocalSetup_OverlayExistsWithoutAgentStyles(t *testing.T) {
	root, cfgPath, prefPath := writeCfg(t, `{
  "agentStyles": { "build": { "label": "BLD" } }
}`)
	// Pre-existing local overlay WITHOUT agentStyles (e.g. other prefs only).
	if err := os.WriteFile(prefPath, []byte(`{ /* my local stuff */ }`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}

	// Overlay now carries the migrated agentStyles.
	styles, err := ParseAgentStyles(read(t, prefPath))
	if err != nil {
		t.Fatalf("overlay unparseable: %v", err)
	}
	if styles["build"].Label != "BLD" {
		t.Fatalf("migrated value not spliced into overlay: %+v", styles)
	}
	// project.jsonc cleaned.
	if hasTopLevelKey(read(t, cfgPath), "agentStyles") {
		t.Fatalf("agentStyles still in project.jsonc:\n%s", read(t, cfgPath))
	}
}

// TestEnsureLocalSetup_OverlayAbsentCreated: when no overlay exists, it is
// created fresh with the migrated value.
func TestEnsureLocalSetup_OverlayAbsentCreated(t *testing.T) {
	root, _, prefPath := writeCfg(t, `{
  "agentStyles": { "build": { "label": "BLD" } }
}`)

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}
	if _, err := os.Stat(prefPath); err != nil {
		t.Fatalf("overlay not created: %v", err)
	}
	styles, err := ParseAgentStyles(read(t, prefPath))
	if err != nil {
		t.Fatalf("overlay unparseable: %v", err)
	}
	if styles["build"].Label != "BLD" {
		t.Fatalf("migrated value missing: %+v", styles)
	}
}

// TestEnsureLocalSetup_NoAgentStylesIsNoop: a project.jsonc without agentStyles
// must NOT create an overlay or rewrite anything (the fast path).
func TestEnsureLocalSetup_NoAgentStylesIsNoop(t *testing.T) {
	root, cfgPath, prefPath := writeCfg(t, `{
  "processes": [{ "id": "p", "command": "echo hi" }],
  "notes": true
}`)
	before := read(t, cfgPath)

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}
	if got := read(t, cfgPath); string(got) != string(before) {
		t.Fatalf("project.jsonc rewritten despite no agentStyles:\n%s", got)
	}
	// No overlay created (migration has nothing to write).
	if _, err := os.Stat(prefPath); !os.IsNotExist(err) {
		t.Fatalf("overlay should not be created when there is nothing to migrate")
	}
}

// TestEnsureLocalSetup_NoProjectConfigIsNoop: a directory with no project.jsonc
// at all must not error and must not create any files (no config → no migration).
func TestEnsureLocalSetup_NoProjectConfigIsNoop(t *testing.T) {
	root := t.TempDir()
	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup on empty dir errored: %v", err)
	}
	// Nothing should have been created under .vh-solara/.
	if _, err := os.Stat(filepath.Join(root, ".vh-solara")); !os.IsNotExist(err) {
		t.Fatalf(".vh-solara/ created despite no project config")
	}
}

// TestEnsureLocalSetup_GitignoreCreate: the gitignore is created from scratch
// with the exact globs when absent.
func TestEnsureLocalSetup_GitignoreCreate(t *testing.T) {
	root, _, _ := writeCfg(t, `{ "notes": true }`)
	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}
	gi := read(t, filepath.Join(root, ".vh-solara", ".gitignore"))
	want := "# vh-solara local files — not committed (local preferences + runtime data).\n" +
		"*.local\n" +
		"*.local.jsonc\n" +
		"# Runtime data vh-solara writes for any project (attachments, queue,\n" +
		"# adopter-declared sockets/logs):\n" +
		"/sessions/\n" +
		"/run/\n"
	if string(gi) != want {
		t.Fatalf("gitignore content mismatch:\nwant: %q\ngot:  %q", want, string(gi))
	}
}

// TestEnsureLocalSetup_GitignoreAppendMissing: an existing gitignore with user
// comments + one of the globs gets the missing glob appended, preserving content.
func TestEnsureLocalSetup_GitignoreAppendMissing(t *testing.T) {
	root, _, _ := writeCfg(t, `{ "notes": true }`)
	existing := "# my project ignores\nnode_modules/\n*.local\n"
	giPath := filepath.Join(root, ".vh-solara", ".gitignore")
	if err := os.WriteFile(giPath, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}
	got := read(t, giPath)
	if !strings.Contains(string(got), "# my project ignores") {
		t.Fatalf("user comment lost:\n%s", got)
	}
	if !strings.Contains(string(got), "node_modules/") {
		t.Fatalf("user glob lost:\n%s", got)
	}
	if !strings.Contains(string(got), "*.local.jsonc") {
		t.Fatalf("missing glob not appended:\n%s", got)
	}
	// The new runtime-data globs are appended alongside the prefs globs.
	for _, want := range []string{"/sessions/", "/run/"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("runtime glob not appended: %q\n%s", want, got)
		}
	}
	// *.local must not be duplicated.
	if strings.Count(string(got), "*.local\n") != 1 {
		t.Fatalf("*.local duplicated:\n%s", got)
	}
}

// TestEnsureLocalSetup_GitignoreNoDuplicate: when both globs are already present,
// nothing is appended (idempotent).
func TestEnsureLocalSetup_GitignoreNoDuplicate(t *testing.T) {
	root, _, _ := writeCfg(t, `{ "notes": true }`)
	full := "# vh-solara local files — not committed (local preferences + runtime data).\n" +
		"*.local\n" +
		"*.local.jsonc\n" +
		"# Runtime data vh-solara writes for any project (attachments, queue,\n" +
		"# adopter-declared sockets/logs):\n" +
		"/sessions/\n" +
		"/run/\n"
	giPath := filepath.Join(root, ".vh-solara", ".gitignore")
	if err := os.WriteFile(giPath, []byte(full), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}
	got := read(t, giPath)
	if string(got) != full {
		t.Fatalf("gitignore changed despite already-complete content:\nwant: %s\ngot: %s", full, got)
	}
}

// TestEnsureRuntimeGitignore_WorksWithoutProjectConfig: the standalone runtime
// entry point creates .vh-solara/.gitignore for a NON-managed project (no
// project.jsonc present) — the gap EnsureLocalSetup leaves open, since
// EnsureLocalSetup bails on a missing project.jsonc. Ensures the full prefs +
// runtime body, and is idempotent (a second run is byte-identical).
func TestEnsureRuntimeGitignore_WorksWithoutProjectConfig(t *testing.T) {
	root := t.TempDir()
	vhDir := filepath.Join(root, ".vh-solara")
	if err := os.MkdirAll(vhDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Sanity: this is a non-managed project (no project.jsonc).
	if _, err := os.Stat(filepath.Join(vhDir, "project.jsonc")); !os.IsNotExist(err) {
		t.Fatalf("precondition: project.jsonc should not exist")
	}

	if err := EnsureRuntimeGitignore(vhDir); err != nil {
		t.Fatalf("EnsureRuntimeGitignore: %v", err)
	}
	giPath := filepath.Join(vhDir, ".gitignore")
	gi := read(t, giPath)
	want := strings.Join(localGitignoreGlobs, "\n") + "\n"
	if string(gi) != want {
		t.Fatalf("gitignore content mismatch:\nwant: %q\ngot:  %q", want, string(gi))
	}
	// No project.jsonc created as a side effect.
	if _, err := os.Stat(filepath.Join(vhDir, "project.jsonc")); !os.IsNotExist(err) {
		t.Fatalf("EnsureRuntimeGitignore must not create project.jsonc")
	}

	// Idempotent: a second run leaves the file byte-identical.
	if err := EnsureRuntimeGitignore(vhDir); err != nil {
		t.Fatalf("second EnsureRuntimeGitignore: %v", err)
	}
	if gi2 := read(t, giPath); string(gi2) != string(gi) {
		t.Fatalf("second run changed the gitignore:\n1: %s\n2: %s", gi, gi2)
	}
}

// TestEnsureRuntimeGitignore_AppendsMissing: an existing .vh-solara/.gitignore
// with user content + some (but not all) globs gets the missing runtime lines
// appended, preserving everything already there.
func TestEnsureRuntimeGitignore_AppendsMissing(t *testing.T) {
	root := t.TempDir()
	vhDir := filepath.Join(root, ".vh-solara")
	if err := os.MkdirAll(vhDir, 0o755); err != nil {
		t.Fatal(err)
	}
	giPath := filepath.Join(vhDir, ".gitignore")
	existing := "# my stuff\nbuild/\n*.local\n*.local.jsonc\n"
	if err := os.WriteFile(giPath, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureRuntimeGitignore(vhDir); err != nil {
		t.Fatalf("EnsureRuntimeGitignore: %v", err)
	}
	got := read(t, giPath)
	for _, want := range []string{"# my stuff", "build/", "*.local", "*.local.jsonc", "/sessions/", "/run/"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("missing %q:\n%s", want, got)
		}
	}
	if strings.Count(string(got), "*.local\n") != 1 {
		t.Fatalf("*.local duplicated:\n%s", got)
	}
}
