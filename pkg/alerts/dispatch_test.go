package alerts

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSendTestCommandChannelPassesEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "out.txt")
	s, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := s.Get()
	cfg.Channels = []Channel{{
		ID:      "c1",
		Type:    ChannelCommand,
		Command: "sh",
		// Echo two notice env vars into a file so we can assert delivery.
		Args:    []string{"-c", `printf '%s|%s' "$VH_ALERT_TYPE" "$VH_ALERT_DETAIL" > ` + out},
		Enabled: true,
	}}
	if err := s.Replace(cfg); err != nil {
		t.Fatal(err)
	}

	d := NewDispatcher(s, NewPresence())
	code, err := d.SendTest("c1")
	if err != nil || code != 0 {
		t.Fatalf("SendTest: code=%d err=%v", code, err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("command did not write output: %v", err)
	}
	if got := string(b); got != "finished|Test notification from vh-solara" {
		t.Errorf("env not passed to command: %q", got)
	}
}

func TestSendTestCommandReportsExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := s.Get()
	cfg.Channels = []Channel{{
		ID: "bad", Type: ChannelCommand, Command: "sh",
		Args: []string{"-c", "echo nope >&2; exit 3"}, Enabled: true,
	}}
	if err := s.Replace(cfg); err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher(s, NewPresence())
	code, err := d.SendTest("bad")
	if code != 3 || err == nil {
		t.Fatalf("want exit 3 + error, got code=%d err=%v", code, err)
	}
}
