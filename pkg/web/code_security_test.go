package web

import (
	"os"
	"path/filepath"
	"testing"
)

// safeJoin is the path-confinement guard for every code-view endpoint, so its
// rejection of traversal and escaping symlinks is security-critical — cover it.
func TestSafeJoinConfinement(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		rel    string
		wantOK bool
	}{
		{"sub/a.txt", true},
		{"sub", true},
		{"", true},
		{"/sub/a.txt", true},        // leading slash is stripped, stays under root
		{"../a.txt", false},         // parent traversal
		{"sub/../../a.txt", false},  // climbs out after cleaning
		{"../../etc/passwd", false}, // deep traversal
	}
	for _, c := range cases {
		if _, ok := safeJoin(root, c.rel); ok != c.wantOK {
			t.Errorf("safeJoin(root, %q) ok=%v, want %v", c.rel, ok, c.wantOK)
		}
	}
}

func TestSafeJoinRejectsEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	// root/escape -> outside (a symlink that leaves the project dir)
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, ok := safeJoin(root, "escape/secret"); ok {
		t.Error("safeJoin allowed a path through a symlink escaping the root")
	}

	// An in-root symlink must still be allowed.
	if err := os.MkdirAll(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "real", "f"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "inlink")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, ok := safeJoin(root, "inlink/f"); !ok {
		t.Error("safeJoin rejected an in-root symlink")
	}
}

// ssrfControl is the dial-time guard for view-proxy upstreams; it must block
// link-local (incl. cloud-metadata) but allow loopback/LAN.
func TestSSRFControlBlocksLinkLocal(t *testing.T) {
	blocked := []string{"169.254.169.254:80", "169.254.0.1:8080", "[fe80::1]:80"}
	for _, a := range blocked {
		if err := ssrfControl("tcp", a, nil); err == nil {
			t.Errorf("ssrfControl(%q) allowed a link-local dial; want blocked", a)
		}
	}
	allowed := []string{"127.0.0.1:8080", "192.168.1.10:80", "10.0.0.5:3000", "[::1]:80"}
	for _, a := range allowed {
		if err := ssrfControl("tcp", a, nil); err != nil {
			t.Errorf("ssrfControl(%q) blocked an allowed dial: %v", a, err)
		}
	}
}
