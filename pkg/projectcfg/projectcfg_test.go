package projectcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".vh-solara"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".vh-solara", "project.jsonc"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadNotFound(t *testing.T) {
	dir := t.TempDir()
	_, err := Load(dir, "")
	if !IsNotFound(err) {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestLoadJSONCAndResolution(t *testing.T) {
	dir := t.TempDir()
	// cwd "." + a subdir cwd; relative unix socket upstream.
	subdir := filepath.Join(dir, "work")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{
  // a board process
  "processes": [
    {
      "id": "board",
      "command": "board serve --socket run/board.sock", // string → sh -c
      "cwd": ".",
      "restart": "on-failure",
      "readiness": { "unix": "run/board.sock" }
    },
    {
      "id": "docs",
      "command": ["mkdocs", "serve"],   // array form
      "cwd": "work",
      "env": { "FOO": "bar" },
      "restart": "always",
    },
  ],
  "views": [
    { "id": "board", "path_prefix": "/board", "upstream": "unix:run/board.sock", "depends_on": "board" }
  ],
}
`
	writeConfig(t, dir, body)
	res, err := Load(dir, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	c := res.Config

	if got, want := len(c.Processes), 2; got != want {
		t.Fatalf("processes: got %d want %d", got, want)
	}
	board := c.Processes[0]
	if !strings.Contains(board.DisplayCommand, "board serve --socket") {
		t.Fatalf("board display = %q", board.DisplayCommand)
	}
	if board.ShellCommand == "" {
		t.Fatal("expected shell string command resolved")
	}
	if board.Argv[0] != "/bin/sh" || board.Argv[1] != "-c" {
		t.Fatalf("board argv = %v", board.Argv)
	}
	if board.AbsCwd != dir {
		t.Fatalf("board cwd = %q want %q", board.AbsCwd, dir)
	}
	if board.Readiness.Unix != filepath.Join(dir, "run", "board.sock") {
		t.Fatalf("readiness unix resolved = %q", board.Readiness.Unix)
	}

	docs := c.Processes[1]
	if len(docs.Argv) != 2 || docs.Argv[0] != "mkdocs" {
		t.Fatalf("docs argv = %v", docs.Argv)
	}
	if docs.AbsCwd != subdir {
		t.Fatalf("docs cwd = %q want %q", docs.AbsCwd, subdir)
	}
	if docs.ShellCommand != "" {
		t.Fatalf("array command should have empty shell string, got %q", docs.ShellCommand)
	}

	v := c.Views[0]
	if v.Upstream != "unix:"+filepath.Join(dir, "run", "board.sock") {
		t.Fatalf("view upstream resolved = %q", v.Upstream)
	}
	if v.DependsOn != "board" {
		t.Fatalf("depends_on = %q", v.DependsOn)
	}
}

func TestHashStabilityAndChange(t *testing.T) {
	dir := t.TempDir()
	a := `{"processes":[{"id":"p","command":"echo hi"}]}`
	b := strings.Repeat("\n// comment\n", 3) + `{"processes":[{"id":"p","command":"echo hi"}]}` // same semantics + comments
	changed := `{"processes":[{"id":"p","command":"echo BYE"}]}`

	writeConfig(t, dir, a)
	ra, err := Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	writeConfig(t, dir, b)
	rb, err := Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	writeConfig(t, dir, changed)
	rc, err := Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}

	if ra.Hash != rb.Hash {
		t.Fatalf("hash changed across comments/whitespace: %s vs %s", ra.Hash, rb.Hash)
	}
	if ra.Hash == rc.Hash {
		t.Fatalf("hash did not change across command edit")
	}
	if string(ra.Config.CanonicalJSON()) != string(rb.Config.CanonicalJSON()) {
		t.Fatalf("canonical JSON not stable across comments")
	}
}

// TestHashLocationIndependent verifies the trust hash is computed over the
// as-authored declarations (relative paths), so the SAME config under two
// different checkout paths hashes identically — a clone/move keeps trust.
func TestHashLocationIndependent(t *testing.T) {
	body := `{
  "processes": [{ "id": "board", "command": "board serve --socket .vh-solara/run/b.sock",
    "readiness": { "unix": ".vh-solara/run/b.sock" } }],
  "views": [{ "id": "board", "path_prefix": "/board", "upstream": "unix:.vh-solara/run/b.sock", "depends_on": "board" }]
}`
	dirA, dirB := t.TempDir(), t.TempDir()
	writeConfig(t, dirA, body)
	writeConfig(t, dirB, body)
	ra, err := Load(dirA, "")
	if err != nil {
		t.Fatal(err)
	}
	rb, err := Load(dirB, "")
	if err != nil {
		t.Fatal(err)
	}
	if ra.Hash != rb.Hash {
		t.Fatalf("hash is location-dependent: %s (%s) != %s (%s)", ra.Hash, dirA, rb.Hash, dirB)
	}
	// Resolution still happened (paths absolute under each root).
	if ra.Config.Views[0].Upstream == rb.Config.Views[0].Upstream {
		t.Fatalf("expected resolved upstreams to differ by root, both = %s", ra.Config.Views[0].Upstream)
	}
}

// TestNotesNotInTrustHash verifies the display-only `notes` flag is parsed but
// excluded from the trust hash — toggling it must not re-gate the project's
// processes.
func TestNotesNotInTrustHash(t *testing.T) {
	base := `{"processes":[{"id":"p","command":"echo hi"}]}`
	withNotes := `{"notes":true,"processes":[{"id":"p","command":"echo hi"}]}`
	dir := t.TempDir()
	writeConfig(t, dir, base)
	ra, err := Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	writeConfig(t, dir, withNotes)
	rb, err := Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if ra.Hash != rb.Hash {
		t.Fatalf("notes changed the trust hash: %s vs %s", ra.Hash, rb.Hash)
	}
	if rb.Config.Notes == nil || !*rb.Config.Notes {
		t.Fatalf("notes not parsed: %+v", rb.Config.Notes)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"dup proc id", `{"processes":[{"id":"x","command":"a"},{"id":"x","command":"b"}]}`, "not unique"},
		{"bad depends_on", `{"views":[{"id":"v","path_prefix":"/v","upstream":"unix:x","depends_on":"nope"}]}`, "does not match"},
		{"bad restart", `{"processes":[{"id":"x","command":"a","restart":"forever"}]}`, "restart must be"},
		{"empty command", `{"processes":[{"id":"x","command":""}]}`, "empty"},
		{"empty array token", `{"processes":[{"id":"x","command":["echo","  "]}]}`, "is empty"},
		{"bad id char", `{"processes":[{"id":"x y","command":"a"}]}`, "must be"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeConfig(t, dir, tc.body)
			_, err := Load(dir, "")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestOverridePath(t *testing.T) {
	dir := t.TempDir()
	alt := filepath.Join(dir, "alt.jsonc")
	if err := os.WriteFile(alt, []byte(`{"processes":[{"id":"p","command":"a"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Load(dir, alt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Config.Processes) != 1 {
		t.Fatalf("override not loaded")
	}
	if res.Config.Path != alt {
		t.Fatalf("path = %q", res.Config.Path)
	}
}

func TestStripJSONC(t *testing.T) {
	in := []byte(`{
  // line
  "a": "value // not a comment",
  "b": 1, /* block */
  "c": "esc\"//",
}`)
	out := stripJSONC(in)
	// Must round-trip through encoding/json.
	got := map[string]any{}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("invalid json after strip: %v\n%s", err, out)
	}
	if got["a"] != "value // not a comment" {
		t.Fatalf("a = %v", got["a"])
	}
	if got["b"] != float64(1) {
		t.Fatalf("b = %v", got["b"])
	}
}
