package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
)

// writeProjectFile writes a named file under root/.vh-solara and returns root.
func writeProjectFile(t *testing.T, name, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".vh-solara"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// getProjectSettings hits the real handler for dir and returns the parsed body.
func getProjectSettings(t *testing.T, ws *httptest.Server, dir string) map[string]any {
	t.Helper()
	resp, err := http.Get(ws.URL + "/vh/project-settings?dir=" + dir)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get status: %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("decode: %v\n%s", err, b)
	}
	return out
}

// TestProjectSettingsGET_OverlayAgentStylesWinsOverBase: when both project.jsonc
// and preferences.local.jsonc declare agentStyles, the overlay FULLY REPLACES the
// base (whole-map overwrite), while notes still comes from project.jsonc.
func TestProjectSettingsGET_OverlayAgentStylesWinsOverBase(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "notes": true,
  "agentStyles": { "build": { "label": "BLD", "color": "warn" } }
}`)
	// Overlay declares a DIFFERENT agentStyles — it must fully replace the base.
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "agentStyles": { "supervisor": { "label": "SUP", "color": "danger" } } }`), 0o644); err != nil {
		t.Fatal(err)
	}

	body := getProjectSettings(t, ws, root)
	// notes still comes from project.jsonc.
	if v, ok := body["notes"].(bool); !ok || !v {
		t.Fatalf("notes not surfaced from base: %+v", body)
	}
	// overlay's agentStyles fully replaces the base; "build" must be gone and
	// "supervisor" present.
	styles, ok := body["agentStyles"].(map[string]any)
	if !ok {
		t.Fatalf("agentStyles missing: %+v", body)
	}
	if _, stillThere := styles["build"]; stillThere {
		t.Fatalf("base agentStyles not replaced by overlay (whole-map overwrite): %+v", styles)
	}
	sup, ok := styles["supervisor"].(map[string]any)
	if !ok || sup["label"] != "SUP" {
		t.Fatalf("overlay agentStyles not merged in: %+v", styles)
	}
}

// TestProjectSettingsGET_OverlayAbsentReturnsBase: with no
// preferences.local.jsonc, the base notes + agentStyles from project.jsonc stand
// on their own.
func TestProjectSettingsGET_OverlayAbsentReturnsBase(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "notes": true,
  "agentStyles": { "build": { "label": "BLD", "color": "warn" } }
}`)
	// No preferences.local.jsonc — the base must stand on its own.

	body := getProjectSettings(t, ws, root)
	if v, ok := body["notes"].(bool); !ok || !v {
		t.Fatalf("notes not surfaced: %+v", body)
	}
	styles, ok := body["agentStyles"].(map[string]any)
	if !ok {
		t.Fatalf("agentStyles missing: %+v", body)
	}
	if styles["build"] == nil {
		t.Fatalf("base agentStyles missing: %+v", styles)
	}
}

// TestProjectSettingsGET_OverlayPresentButNoAgentStyles_BaseWins: a preferences
// overlay that exists but declares NO agentStyles key must NOT clear the base —
// the base agentStyles win (overlay absence-of-key == file-absence).
func TestProjectSettingsGET_OverlayPresentButNoAgentStyles_BaseWins(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "notes": true,
  "agentStyles": { "build": { "label": "BLD", "color": "warn" } }
}`)
	// Overlay exists but declares NO agentStyles — base agentStyles must win.
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ /* nothing here yet */ }`), 0o644); err != nil {
		t.Fatal(err)
	}

	body := getProjectSettings(t, ws, root)
	styles, ok := body["agentStyles"].(map[string]any)
	if !ok {
		t.Fatalf("agentStyles missing: %+v", body)
	}
	if styles["build"] == nil {
		t.Fatalf("base agentStyles should win when overlay has no agentStyles key: %+v", styles)
	}
}

// TestProjectSettingsPUT_WritesOnlyPreferences: the PUT must write ONLY the
// gitignored preferences.local.jsonc overlay — project.jsonc must be byte-identical
// before and after. This is the load-bearing invariant of the overlay split.
func TestProjectSettingsPUT_WritesOnlyPreferences(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	baseJSON := `{
  "processes": [{ "id": "p", "command": "echo hi" }],
  "agentStyles": { "build": { "label": "BLD" } }
}`
	root := writeProjectFile(t, "project.jsonc", baseJSON)
	cfgPath := filepath.Join(root, ".vh-solara", "project.jsonc")
	before, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}

	payload, _ := json.Marshal(map[string]any{
		"agentStyles": map[string]any{
			"supervisor": map[string]any{"label": "SUP", "color": "danger"},
		},
	})
	req, _ := http.NewRequest(http.MethodPut, ws.URL+"/vh/project-settings?dir="+root, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("put status: %d body: %s", resp.StatusCode, b)
	}

	// (1) project.jsonc must be byte-identical — the PUT never touches it.
	after, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("project.jsonc was mutated by the PUT:\nbefore: %s\nafter: %s", before, after)
	}
	// (2) preferences.local.jsonc was created and carries the new agentStyles.
	pref, err := os.ReadFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"))
	if err != nil {
		t.Fatalf("preferences.local.jsonc not created: %v", err)
	}
	styles, err := projectcfg.ParseAgentStyles(pref)
	if err != nil {
		t.Fatalf("preferences.local.jsonc unparseable: %v\n%s", err, pref)
	}
	if styles["supervisor"].Label != "SUP" {
		t.Fatalf("agentStyles not written to preferences.local.jsonc: %+v\n%s", styles, pref)
	}
	// (3) project.jsonc still carries its ORIGINAL base agentStyles (unchanged).
	baseStyles, err := projectcfg.ParseAgentStyles(before)
	if err != nil {
		t.Fatal(err)
	}
	if baseStyles["build"].Label != "BLD" {
		t.Fatalf("base agentStyles disturbed: %+v", baseStyles)
	}
}

// TestProjectSettingsPUT_DryRunDoesNotWrite: a dryRun preview must not create or
// modify either file — it only returns the would-be overlay text.
func TestProjectSettingsPUT_DryRunDoesNotWrite(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{ "agentStyles": { "build": { "label": "BLD" } } }`)
	prefPath := filepath.Join(root, ".vh-solara", "preferences.local.jsonc")

	payload, _ := json.Marshal(map[string]any{
		"agentStyles": map[string]any{"supervisor": map[string]any{"label": "SUP"}},
		"dryRun":      true,
	})
	req, _ := http.NewRequest(http.MethodPut, ws.URL+"/vh/project-settings?dir="+root, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dryRun status: %d", resp.StatusCode)
	}
	var out struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	// dryRun on a missing overlay: old is empty, new is the fresh document.
	if out.Old != "" {
		t.Fatalf("dryRun old should be empty for a missing overlay: %q", out.Old)
	}
	if out.New == "" {
		t.Fatal("dryRun new should contain the would-be overlay text")
	}
	// Neither file should have been created/modified.
	if _, err := os.Stat(prefPath); !os.IsNotExist(err) {
		t.Fatalf("dryRun created preferences.local.jsonc: %v", err)
	}
}

// TestProjectSettingsGET_PostMigrationBaseHasNoAgentStyles: after the one-time
// migration, project.jsonc carries NO agentStyles (it was moved out) and the
// overlay is the SOLE source. GET must still surface the overlay's agentStyles —
// the base-absent path is the normal post-migration steady state, not a degenerate
// case. notes still comes from project.jsonc (it is never migrated).
func TestProjectSettingsGET_PostMigrationBaseHasNoAgentStyles(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// Base declares notes but NO agentStyles (the post-migration steady state).
	root := writeProjectFile(t, "project.jsonc", `{
  "notes": false
}`)
	// Overlay carries the migrated agentStyles — the sole source now.
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "agentStyles": { "supervisor": { "label": "SUP", "color": "danger" } } }`), 0o644); err != nil {
		t.Fatal(err)
	}

	body := getProjectSettings(t, ws, root)
	// notes still surfaces from the base.
	if v, ok := body["notes"].(bool); !ok || v {
		t.Fatalf("notes not surfaced from base: %+v", body)
	}
	// agentStyles comes from the overlay (base has none).
	styles, ok := body["agentStyles"].(map[string]any)
	if !ok {
		t.Fatalf("agentStyles missing: %+v", body)
	}
	sup, ok := styles["supervisor"].(map[string]any)
	if !ok || sup["label"] != "SUP" {
		t.Fatalf("overlay agentStyles not surfaced when base has no agentStyles: %+v", styles)
	}
}
