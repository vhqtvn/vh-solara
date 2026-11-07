package web

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// runMaterialize executes the shared materialize script
// (web/scripts/materialize.sh) with VH_MATERIALIZE_* env overrides pointing
// dest/staging at test-owned temp dirs, so the real embed dirs
// (pkg/web/dist, web/dist-build) are never touched by these tests.
func runMaterialize(t *testing.T, env ...string) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", filepath.Join(root, "web", "scripts", "materialize.sh"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("materialize.sh %v: %v\n%s", env, err, out)
	}
}

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustGone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("%s survived (stat err=%v); want removed", path, err)
	}
}

func mustExistWith(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Errorf("%s missing: %v", path, err)
		return
	}
	if string(got) != want {
		t.Errorf("%s = %q; want %q", path, got, want)
	}
}

// TestMaterializeCleansGhostsAndPreservesFallback pins the shared materialize
// contract (web/scripts/materialize.sh): EVERY top-level generated dest entry
// is removed — including files whose extension the old fixed rm-list never
// covered (e.g. *.txt) and entire subdirectories (e.g. a deleted
// web/public/screenshots/) — while the tracked placeholder fallback survives
// and the staged bundle is copied in. Regression test for the "ghost files"
// defect: against the old extension-allowlist cleanup both ghosts survive and
// this test goes red.
func TestMaterializeCleansGhostsAndPreservesFallback(t *testing.T) {
	dest := t.TempDir()
	staging := t.TempDir()

	// Dest ghosts: an unlisted-extension top-level file AND a subdirectory
	// holding a file — both invisible to the old cleanup allowlist.
	writeFileT(t, filepath.Join(dest, "slice5-probe.txt"), "ghost")
	if err := os.MkdirAll(filepath.Join(dest, "screenshots"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(dest, "screenshots", "narrow.png"), "ghost-png")
	// Stale generated artifact the staged build must REPLACE.
	writeFileT(t, filepath.Join(dest, "index.html"), "STALE")
	// Tracked cold-build fallback must survive the clean verbatim.
	writeFileT(t, filepath.Join(dest, "placeholder.html"), "cold-fallback banner\n")

	// Staged bundle: fresh content.
	writeFileT(t, filepath.Join(staging, "index.html"), "<html>fresh</html>")
	if err := os.MkdirAll(filepath.Join(staging, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(staging, "assets", "app-D4R7QK7E.js"), "console.log('fresh')")

	runMaterialize(t,
		"VH_MATERIALIZE_DEST="+dest,
		"VH_MATERIALIZE_STAGING="+staging,
	)

	// Ghosts gone — the unlisted-extension file AND the subdirectory.
	mustGone(t, filepath.Join(dest, "slice5-probe.txt"))
	mustGone(t, filepath.Join(dest, "screenshots", "narrow.png"))
	// Staged content present, replacing the stale artifact.
	mustExistWith(t, filepath.Join(dest, "index.html"), "<html>fresh</html>")
	mustExistWith(t, filepath.Join(dest, "assets", "app-D4R7QK7E.js"), "console.log('fresh')")
	// Preserved fallback intact — content untouched.
	mustExistWith(t, filepath.Join(dest, "placeholder.html"), "cold-fallback banner\n")
}

// TestMaterializePreserveOverride pins the VH_MATERIALIZE_PRESERVE parameter
// (per-caller preserve sets — the host-web twin passes its own value): a
// non-default name survives the clean while everything else is removed.
func TestMaterializePreserveOverride(t *testing.T) {
	dest := t.TempDir()
	staging := t.TempDir()
	writeFileT(t, filepath.Join(dest, "host-placeholder.html"), "keep")
	writeFileT(t, filepath.Join(dest, "legacy.txt"), "drop")
	writeFileT(t, filepath.Join(staging, "index.html"), "staged")

	runMaterialize(t,
		"VH_MATERIALIZE_DEST="+dest,
		"VH_MATERIALIZE_STAGING="+staging,
		"VH_MATERIALIZE_PRESERVE=host-placeholder.html",
	)

	mustGone(t, filepath.Join(dest, "legacy.txt"))
	mustExistWith(t, filepath.Join(dest, "host-placeholder.html"), "keep")
	mustExistWith(t, filepath.Join(dest, "index.html"), "staged")
}

// TestMaterializeCleanMode pins the clean-only mode the Makefile
// clean-web-embed / clean-host-web-embed targets route through
// (VH_MATERIALIZE_CLEAN=1): generated entries removed — subdirectories and
// unlisted extensions included — no staging copy needed, fallback preserved.
// This is the same defect the old Makefile rm-lists carried: "clean" could
// not remove a screenshots/ ghost.
func TestMaterializeCleanMode(t *testing.T) {
	dest := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dest, "screenshots"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(dest, "screenshots", "wide.png"), "ghost")
	writeFileT(t, filepath.Join(dest, "ghost.txt"), "ghost")
	writeFileT(t, filepath.Join(dest, "placeholder.html"), "cold-fallback banner\n")

	runMaterialize(t,
		"VH_MATERIALIZE_DEST="+dest,
		"VH_MATERIALIZE_CLEAN=1",
	)

	mustGone(t, filepath.Join(dest, "screenshots", "wide.png"))
	mustGone(t, filepath.Join(dest, "screenshots"))
	mustGone(t, filepath.Join(dest, "ghost.txt"))
	mustExistWith(t, filepath.Join(dest, "placeholder.html"), "cold-fallback banner\n")
}
