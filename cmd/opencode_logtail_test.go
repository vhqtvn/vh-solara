package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/ringlog"
)

type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func shrinkLogTailPoll(t *testing.T) {
	t.Helper()
	ocLogTails.mu.Lock()
	old := ocLogTailPoll
	ocLogTailPoll = 10 * time.Millisecond
	ocLogTails.mu.Unlock()
	t.Cleanup(func() {
		ocLogTails.mu.Lock()
		ocLogTailPoll = old
		ocLogTails.mu.Unlock()
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

// sleeper starts a live process whose pid the follower can watch.
func sleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	c := exec.Command("sleep", "30")
	if err := c.Start(); err != nil {
		t.Skipf("sleep unavailable: %v", err)
	}
	t.Cleanup(func() { _ = c.Process.Kill(); _, _ = c.Process.Wait() })
	return c
}

// The follower delivers only bytes appended after `from`, and drains the final
// output once the watched pid exits, then stops.
func TestFollowDetachedLogFromOffsetAndFinalDrain(t *testing.T) {
	shrinkLogTailPoll(t)
	path := filepath.Join(t.TempDir(), "oc.log")
	appendFile(t, path, "old-history\n")
	proc := sleeper(t)

	var got syncBuf
	followDetachedLog(path, proc.Process.Pid, logSize(path), &got)
	appendFile(t, path, "live-1\n")
	waitFor(t, "live-1", func() bool { return strings.Contains(got.String(), "live-1") })
	if strings.Contains(got.String(), "old-history") {
		t.Fatalf("follower re-delivered bytes before its offset: %q", got.String())
	}

	appendFile(t, path, "final\n")
	_ = proc.Process.Kill()
	_, _ = proc.Process.Wait()
	waitFor(t, "follower to stop", func() bool {
		ocLogTails.mu.Lock()
		defer ocLogTails.mu.Unlock()
		return ocLogTails.cur[path] == nil
	})
	if g := got.String(); g != "live-1\nfinal\n" {
		t.Fatalf("got %q, want live-1 + final drain exactly once", g)
	}
}

// A superseding follow (restart respawn / reattach) resumes at the previous
// follower's offset: no byte delivered twice, none skipped.
func TestFollowDetachedLogTakeoverNoDupNoGap(t *testing.T) {
	shrinkLogTailPoll(t)
	path := filepath.Join(t.TempDir(), "oc.log")
	a, b := sleeper(t), sleeper(t)

	var got syncBuf
	followDetachedLog(path, a.Process.Pid, 0, &got)
	appendFile(t, path, "one\n")
	waitFor(t, "one", func() bool { return strings.Contains(got.String(), "one") })
	appendFile(t, path, "two\n")
	// `from` is deliberately stale (0): the takeover offset must win.
	followDetachedLog(path, b.Process.Pid, 0, &got)
	appendFile(t, path, "three\n")
	waitFor(t, "three", func() bool { return strings.Contains(got.String(), "three") })
	if g := got.String(); g != "one\ntwo\nthree\n" {
		t.Fatalf("got %q, want each line exactly once", g)
	}
}

// Regression (2026-10-02): the detached child's stdout/stderr must be the
// disk log FILE, not a pipe into the daemon — a pipe's reader dies with the
// daemon and freezes the log for the rest of the child's life. The ring is
// still fed, via the follower.
func TestStartOpenCodeServeDetachedWritesLogFileDirectly(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("inspects /proc/<pid>/fd")
	}
	shrinkLogTailPoll(t)
	t.Setenv("VH_STATE_DIR", t.TempDir())
	bin := filepath.Join(t.TempDir(), "opencode")
	script := "#!/bin/sh\necho boot-line\nsleep 0.3\necho late-line >&2\nexec sleep 30\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	ring := ringlog.New(ringlog.DefaultCap)
	cmd, err := startOpenCodeServeDetached(bin, 1, "", nil, ring.Writer())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	for _, fd := range []string{"1", "2"} {
		target, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(cmd.Process.Pid), "fd", fd))
		if err != nil {
			t.Fatal(err)
		}
		if target != ocLogPath() {
			t.Fatalf("child fd %s → %q, want the disk log %q (a pipe dies with the daemon)", fd, target, ocLogPath())
		}
	}
	waitFor(t, "ring to receive both lines", func() bool {
		s := string(ring.Tail(0))
		return strings.Contains(s, "boot-line") && strings.Contains(s, "late-line")
	})
}
