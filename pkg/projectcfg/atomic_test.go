package projectcfg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// findTmpArtifacts walks root and returns any file whose name looks like a
// writeFileAtomic temp artifact (the temp is named `.<base>.tmp-<rand>`). On a
// clean success or a clean failure, none should linger.
func findTmpArtifacts(t *testing.T, root string) []string {
	t.Helper()
	var hits []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if strings.Contains(d.Name(), ".tmp-") {
			hits = append(hits, path)
		}
		return nil
	})
	return hits
}

// TestWriteFileAtomic_SuccessContract pins the atomic-write contract for the
// success path: the target ends up byte-identical to the data, the perm is
// honored, replacing the content does not leave partials, and — critically —
// no temp artifact lingers in the target's directory tree (the temp is created
// in the SAME directory as the target via os.CreateTemp(filepath.Dir(path), …),
// so the final rename is a same-directory atomic rename on POSIX).
func TestWriteFileAtomic_SuccessContract(t *testing.T) {
	// Nest the target one level deep so a leaked temp in a parent dir is caught.
	dir := filepath.Join(t.TempDir(), "nested")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "project.jsonc")

	data := []byte("{\n  // a comment that must round-trip byte-for-byte\n  \"processes\": [],\n  \"notes\": true\n}\n")

	if err := writeFileAtomic(target, data, 0o644); err != nil {
		t.Fatalf("writeFileAtomic: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("target content mismatch:\nwant: %q\ngot:  %q", data, got)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("perm not honored: got %#o want 0o644", fi.Mode().Perm())
	}

	if hits := findTmpArtifacts(t, filepath.Dir(target)); len(hits) != 0 {
		t.Fatalf("temp artifact lingered after success: %v", hits)
	}

	// Replace with different content: must land exactly, no partial, no temp.
	data2 := []byte("{\n  \"processes\": [{ \"id\": \"x\" }],\n  \"notes\": false\n}\n")
	if err := writeFileAtomic(target, data2, 0o644); err != nil {
		t.Fatalf("writeFileAtomic replace: %v", err)
	}
	got2, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target after replace: %v", err)
	}
	if string(got2) != string(data2) {
		t.Fatalf("target content mismatch after replace:\nwant: %q\ngot:  %q", data2, got2)
	}
	// No temp artifact may linger anywhere under the target's parent dir.
	if hits := findTmpArtifacts(t, filepath.Dir(target)); len(hits) != 0 {
		t.Fatalf("temp artifact lingered after replace: %v", hits)
	}
}

// TestWriteFileAtomic_FailureLeavesOriginalIntact pins the crash-safety
// contract: when the atomic write fails at any step, the pre-existing target
// file is left byte-intact (never truncated/partial) and no temp lingers. We
// force a failure by making the target's directory read-only so the temp cannot
// be created; the already-present original must survive untouched and the error
// must name the target path.
func TestWriteFileAtomic_FailureLeavesOriginalIntact(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "project.jsonc")
	original := []byte("{\n  // original — must survive a failed atomic write\n  \"processes\": [{ \"id\": \"p\" }],\n  \"agentStyles\": { \"build\": { \"label\": \"BLD\" } }\n}\n")
	if err := os.WriteFile(target, original, 0o644); err != nil {
		t.Fatal(err)
	}

	// Lock the directory: CreateTemp cannot place the temp → the write fails
	// before touching `target`. The file itself stays readable (dir is r-x).
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	err := writeFileAtomic(target, []byte("would-be-replacement"), 0o644)
	if err == nil {
		t.Fatal("writeFileAtomic unexpectedly succeeded against a read-only dir")
	}
	if !strings.Contains(err.Error(), target) {
		t.Fatalf("error does not name the target path %q: %v", target, err)
	}

	// Restore search/write so cleanup works and we can re-read.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read original after failure: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("original target mutated by a failed write:\nwant: %q\ngot:  %q", original, got)
	}
	if hits := findTmpArtifacts(t, dir); len(hits) != 0 {
		t.Fatalf("temp artifact lingered after failure: %v", hits)
	}
}

// TestEnsureLocalSetup_MigratesAtomically re-runs the comment-preserving
// migration scenario from TestEnsureLocalSetup_MigratesAgentStyles and, on top
// of the existing behavioral assertions, asserts the atomic-write post-
// conditions on the daemon's first-ever write to checked-in project.jsonc:
// after a successful migrate, project.jsonc is parseable via Load (so processes
// survived and the file is valid JSONC), agentStyles is gone, the on-disk bytes
// equal exactly the cleaned bytes (no partial/truncation), and no temp artifact
// lingers in the project's config directory.
func TestEnsureLocalSetup_MigratesAtomically(t *testing.T) {
	const body = `{
  // companion processes (trust-gated — must survive the edit)
  "processes": [{ "id": "p", "command": "echo hi" }],
  "agentStyles": { "build": { "label": "BLD", "color": "warn" } },
  "notes": true
}`
	root, cfgPath, prefPath := writeCfg(t, body)

	// Compute the exact cleaned bytes the migration must land, independent of
	// the migration path itself, so we can assert byte-identity afterward.
	cleaned := RemoveTopLevelKey([]byte(body), "agentStyles")

	if err := EnsureLocalSetup(root, ""); err != nil {
		t.Fatalf("EnsureLocalSetup: %v", err)
	}

	// (1) project.jsonc parses via the package's own loader → valid JSONC, and
	// the trust-gated process survived the rewrite.
	lr, err := Load(root, "")
	if err != nil {
		t.Fatalf("Load after migrate (project.jsonc must be parseable): %v\n%s", err, read(t, cfgPath))
	}
	if len(lr.Config.Processes) != 1 || lr.Config.Processes[0].ID != "p" {
		t.Fatalf("process lost across atomic rewrite: %+v", lr.Config.Processes)
	}
	if len(lr.Config.AgentStyles) != 0 {
		t.Fatalf("agentStyles present in loaded config after migrate: %+v", lr.Config.AgentStyles)
	}

	// (2) agentStyles physically removed from project.jsonc.
	cfgAfter := read(t, cfgPath)
	if hasTopLevelKey(cfgAfter, "agentStyles") {
		t.Fatalf("agentStyles still present in project.jsonc:\n%s", cfgAfter)
	}

	// (3) On-disk bytes equal exactly the cleaned bytes — the atomic write did
	// not truncate, reorder, or partially flush project.jsonc.
	if string(cfgAfter) != string(cleaned) {
		t.Fatalf("project.jsonc bytes diverge from cleaned expectation:\nwant: %q\ngot:  %q", cleaned, cfgAfter)
	}

	// (4) overlay created with the migrated value.
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

	// (5) No temp artifact lingered in the project's config directory.
	if hits := findTmpArtifacts(t, filepath.Dir(cfgPath)); len(hits) != 0 {
		t.Fatalf("temp artifact lingered after migrate: %v", hits)
	}
}
