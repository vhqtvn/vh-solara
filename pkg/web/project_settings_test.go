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

// putProjectSettings issues a PUT (with the required CSRF header) and returns
// the raw response body bytes.
func putProjectSettings(t *testing.T, ws *httptest.Server, dir string, payload map[string]any) []byte {
	t.Helper()
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPut, ws.URL+"/vh/project-settings?dir="+dir, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put status: %d body: %s", resp.StatusCode, body)
	}
	return body
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

// --- nameReplacements (display-only session-title replacement layer) ---

// TestProjectSettingsGET_NameReplacementsBaseWhenOverlayAbsent: with no overlay,
// the base nameReplacements array stands on its own.
func TestProjectSettingsGET_NameReplacementsBaseWhenOverlayAbsent(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "nameReplacements": [{ "pattern": "base", "replacement": "B", "flags": "g" }]
}`)

	body := getProjectSettings(t, ws, root)
	repls, ok := body["nameReplacements"].([]any)
	if !ok || len(repls) != 1 {
		t.Fatalf("base nameReplacements not surfaced: %+v", body)
	}
	r := repls[0].(map[string]any)
	if r["pattern"] != "base" || r["replacement"] != "B" || r["flags"] != "g" {
		t.Fatalf("base nameReplacements fields wrong: %+v", r)
	}
}

// TestProjectSettingsGET_OverlayNameReplacementsWinsOverBase: when both files
// declare nameReplacements, the overlay FULLY REPLACES the base array.
func TestProjectSettingsGET_OverlayNameReplacementsWinsOverBase(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "nameReplacements": [{ "pattern": "base", "replacement": "B" }]
}`)
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "nameReplacements": [{ "pattern": "overlay", "replacement": "O", "flags": "g" }] }`), 0o644); err != nil {
		t.Fatal(err)
	}

	body := getProjectSettings(t, ws, root)
	repls, ok := body["nameReplacements"].([]any)
	if !ok {
		t.Fatalf("nameReplacements missing: %+v", body)
	}
	if len(repls) != 1 {
		t.Fatalf("overlay should fully replace base array, got len=%d: %+v", len(repls), repls)
	}
	r := repls[0].(map[string]any)
	if r["pattern"] != "overlay" {
		t.Fatalf("overlay nameReplacements not surfaced (base should be gone): %+v", r)
	}
}

// TestProjectSettingsGET_OverlayEmptyArrayClearsBase: a present `[]` in the
// overlay explicitly clears the base array (overlay presence wins, even empty).
func TestProjectSettingsGET_OverlayEmptyArrayClearsBase(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "nameReplacements": [{ "pattern": "base", "replacement": "B" }]
}`)
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "nameReplacements": [] }`), 0o644); err != nil {
		t.Fatal(err)
	}

	body := getProjectSettings(t, ws, root)
	repls, ok := body["nameReplacements"].([]any)
	if !ok {
		t.Fatalf("nameReplacements key should be present (explicit clear): %+v", body)
	}
	if len(repls) != 0 {
		t.Fatalf("explicit [] should clear, got %+v", repls)
	}
}

// TestProjectSettingsGET_IndependentMergeOfTwoKeys: agentStyles and
// nameReplacements merge independently — base agentStyles + overlay
// nameReplacements both surface (and vice versa).
func TestProjectSettingsGET_IndependentMergeOfTwoKeys(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// Case 1: base carries agentStyles; overlay carries nameReplacements.
	root := writeProjectFile(t, "project.jsonc", `{
  "agentStyles": { "build": { "label": "BLD" } }
}`)
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "nameReplacements": [{ "pattern": "x", "replacement": "y" }] }`), 0o644); err != nil {
		t.Fatal(err)
	}
	body := getProjectSettings(t, ws, root)
	if _, ok := body["agentStyles"].(map[string]any); !ok {
		t.Fatalf("base agentStyles should surface alongside overlay nameReplacements: %+v", body)
	}
	if _, ok := body["nameReplacements"].([]any); !ok {
		t.Fatalf("overlay nameReplacements should surface alongside base agentStyles: %+v", body)
	}

	// Case 2: base carries nameReplacements; overlay carries agentStyles.
	root2 := writeProjectFile(t, "project.jsonc", `{
  "nameReplacements": [{ "pattern": "x", "replacement": "y" }]
}`)
	if err := os.WriteFile(filepath.Join(root2, ".vh-solara", "preferences.local.jsonc"),
		[]byte(`{ "agentStyles": { "supervisor": { "label": "SUP" } } }`), 0o644); err != nil {
		t.Fatal(err)
	}
	body2 := getProjectSettings(t, ws, root2)
	if _, ok := body2["agentStyles"].(map[string]any); !ok {
		t.Fatalf("overlay agentStyles should surface alongside base nameReplacements: %+v", body2)
	}
	if _, ok := body2["nameReplacements"].([]any); !ok {
		t.Fatalf("base nameReplacements should surface alongside overlay agentStyles: %+v", body2)
	}
}

// TestProjectSettingsPUT_NameReplacementsOnlyLeavesAgentStylesIntact: a PUT with
// ONLY nameReplacements must leave an existing agentStyles key byte-intact in
// the overlay (the splice is key-presence-aware: omitted keys are no-ops, never
// written null).
func TestProjectSettingsPUT_NameReplacementsOnlyLeavesAgentStylesIntact(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{}`)
	prefPath := filepath.Join(root, ".vh-solara", "preferences.local.jsonc")
	seeded := `{
  "agentStyles": { "supervisor": { "label": "SUP", "color": "danger" } }
}`
	if err := os.WriteFile(prefPath, []byte(seeded), 0o644); err != nil {
		t.Fatal(err)
	}

	putProjectSettings(t, ws, root, map[string]any{
		"nameReplacements": []map[string]any{
			{"pattern": "x", "replacement": "y"},
		},
	})

	pref, err := os.ReadFile(prefPath)
	if err != nil {
		t.Fatal(err)
	}
	styles, err := projectcfg.ParseAgentStyles(pref)
	if err != nil {
		t.Fatalf("preferences unparseable: %v\n%s", err, pref)
	}
	if styles["supervisor"].Label != "SUP" || styles["supervisor"].Color != "danger" {
		t.Fatalf("agentStyles should be byte-intact when only nameReplacements supplied: %+v\n%s", styles, pref)
	}
	repls, err := projectcfg.ParseNameReplacements(pref)
	if err != nil {
		t.Fatalf("preferences unparseable: %v\n%s", err, pref)
	}
	if len(repls) != 1 || repls[0].Pattern != "x" || repls[0].Replacement != "y" {
		t.Fatalf("nameReplacements not written: %+v\n%s", repls, pref)
	}
}

// TestProjectSettingsPUT_AgentStylesOnlyLeavesNameReplacementsIntact: the
// converse — agentStyles-only PUT must not disturb an existing nameReplacements
// key.
func TestProjectSettingsPUT_AgentStylesOnlyLeavesNameReplacementsIntact(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{}`)
	prefPath := filepath.Join(root, ".vh-solara", "preferences.local.jsonc")
	seeded := `{
  "nameReplacements": [{ "pattern": "x", "replacement": "y" }]
}`
	if err := os.WriteFile(prefPath, []byte(seeded), 0o644); err != nil {
		t.Fatal(err)
	}

	putProjectSettings(t, ws, root, map[string]any{
		"agentStyles": map[string]any{
			"supervisor": map[string]any{"label": "SUP"},
		},
	})

	pref, err := os.ReadFile(prefPath)
	if err != nil {
		t.Fatal(err)
	}
	repls, err := projectcfg.ParseNameReplacements(pref)
	if err != nil {
		t.Fatalf("preferences unparseable: %v\n%s", err, pref)
	}
	if len(repls) != 1 || repls[0].Pattern != "x" || repls[0].Replacement != "y" {
		t.Fatalf("nameReplacements should be intact when only agentStyles supplied: %+v\n%s", repls, pref)
	}
}

// TestProjectSettingsPUT_CombinedUpdatesBothKeys: supplying both keys splices
// both into one evolving overlay, in deterministic order (agentStyles, then
// nameReplacements).
func TestProjectSettingsPUT_CombinedUpdatesBothKeys(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{}`)

	putProjectSettings(t, ws, root, map[string]any{
		"agentStyles": map[string]any{
			"supervisor": map[string]any{"label": "SUP"},
		},
		"nameReplacements": []map[string]any{
			{"pattern": "x", "replacement": "y", "flags": "g"},
		},
	})

	pref, err := os.ReadFile(filepath.Join(root, ".vh-solara", "preferences.local.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	styles, err := projectcfg.ParseAgentStyles(pref)
	if err != nil {
		t.Fatal(err)
	}
	if styles["supervisor"].Label != "SUP" {
		t.Fatalf("agentStyles not written in combined save: %+v", styles)
	}
	repls, err := projectcfg.ParseNameReplacements(pref)
	if err != nil {
		t.Fatal(err)
	}
	if len(repls) != 1 || repls[0].Pattern != "x" || repls[0].Flags != "g" {
		t.Fatalf("nameReplacements not written in combined save: %+v", repls)
	}
	// Determinism: re-running the identical PUT on a fresh fixture produces the
	// exact same overlay text (the splice is a pure function; calling the two
	// keys in fixed order yields a stable result regardless of textual layout).
	root2 := writeProjectFile(t, "project.jsonc", `{}`)
	putProjectSettings(t, ws, root2, map[string]any{
		"agentStyles":      map[string]any{"supervisor": map[string]any{"label": "SUP"}},
		"nameReplacements": []map[string]any{{"pattern": "x", "replacement": "y", "flags": "g"}},
	})
	pref2, err := os.ReadFile(filepath.Join(root2, ".vh-solara", "preferences.local.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pref, pref2) {
		t.Fatalf("combined PUT is not deterministic:\nfirst:  %s\nsecond: %s", pref, pref2)
	}
}

// TestProjectSettingsPUT_DryRunCombinedDoesNotWrite: a combined dryRun returns
// the old+new overlay text WITHOUT writing either file.
func TestProjectSettingsPUT_DryRunCombinedDoesNotWrite(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{}`)
	prefPath := filepath.Join(root, ".vh-solara", "preferences.local.jsonc")

	b := putProjectSettings(t, ws, root, map[string]any{
		"agentStyles":      map[string]any{"supervisor": map[string]any{"label": "SUP"}},
		"nameReplacements": []map[string]any{{"pattern": "x", "replacement": "y"}},
		"dryRun":           true,
	})
	var out struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("decode dryRun: %v\n%s", err, b)
	}
	if out.New == "" {
		t.Fatal("dryRun new should contain the would-be overlay text")
	}
	if !bytes.Contains([]byte(out.New), []byte(`"agentStyles"`)) || !bytes.Contains([]byte(out.New), []byte(`"nameReplacements"`)) {
		t.Fatalf("dryRun new should contain both keys:\n%s", out.New)
	}
	if _, err := os.Stat(prefPath); !os.IsNotExist(err) {
		t.Fatalf("dryRun created preferences.local.jsonc: %v", err)
	}
}

// TestProjectSettingsPUT_TrustHashUnchanged: a real PUT must not touch
// project.jsonc — re-Loading it yields the same trust hash as before. This is
// the fixture-level guarantee (project.jsonc / trust hash never modified).
func TestProjectSettingsPUT_TrustHashUnchanged(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	root := writeProjectFile(t, "project.jsonc", `{
  "processes": [{ "id": "p", "command": "echo hi" }]
}`)
	before, err := projectcfg.Load(root, "")
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := before.Hash
	beforeBytes, err := os.ReadFile(filepath.Join(root, ".vh-solara", "project.jsonc"))
	if err != nil {
		t.Fatal(err)
	}

	putProjectSettings(t, ws, root, map[string]any{
		"nameReplacements": []map[string]any{{"pattern": "x", "replacement": "y"}},
	})

	afterBytes, err := os.ReadFile(filepath.Join(root, ".vh-solara", "project.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeBytes, afterBytes) {
		t.Fatalf("project.jsonc bytes changed across PUT:\nbefore: %s\nafter:  %s", beforeBytes, afterBytes)
	}
	after, err := projectcfg.Load(root, "")
	if err != nil {
		t.Fatal(err)
	}
	if after.Hash != beforeHash {
		t.Fatalf("trust hash changed across PUT: %s -> %s", beforeHash, after.Hash)
	}
}

// TestProjectSettingsPUT_OmittedKeyNotWrittenNull: when a key is omitted, the
// overlay must NOT contain a `null` for it (the splice is a no-op for omitted
// keys). Checks both directions.
func TestProjectSettingsPUT_OmittedKeyNotWrittenNull(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// nameReplacements only — no agentStyles null.
	root1 := writeProjectFile(t, "project.jsonc", `{}`)
	putProjectSettings(t, ws, root1, map[string]any{
		"nameReplacements": []map[string]any{{"pattern": "x", "replacement": "y"}},
	})
	pref1, err := os.ReadFile(filepath.Join(root1, ".vh-solara", "preferences.local.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(pref1, []byte(`"agentStyles"`)) {
		t.Fatalf("omitted agentStyles should not appear at all:\n%s", pref1)
	}

	// agentStyles only — no nameReplacements null.
	root2 := writeProjectFile(t, "project.jsonc", `{}`)
	putProjectSettings(t, ws, root2, map[string]any{
		"agentStyles": map[string]any{"supervisor": map[string]any{"label": "SUP"}},
	})
	pref2, err := os.ReadFile(filepath.Join(root2, ".vh-solara", "preferences.local.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(pref2, []byte(`"nameReplacements"`)) {
		t.Fatalf("omitted nameReplacements should not appear at all:\n%s", pref2)
	}
}
