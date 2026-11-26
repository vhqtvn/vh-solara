//go:build linux

package cmd

// Regression for the cross-project detached-restart kill — the mid-request
// 502 "upstream error: EOF" flake of TestLocalServerDetachedRestartFansChild
// OutputIntoLogs and TestRestartRetargetsRunningServerToFreshPort.
//
// restartDetachedOpenCode resolves the recorded state, the log and both lock
// files at CALL TIME from the ambient VH_STATE_DIR and the process cwd — not
// from its `workspace` parameter. A death watcher that outlives its project
// (its daemon keeps running after the scenario that started it has ended)
// keeps restarting with ITS workspace while another project's namespace is
// current, so it read THAT project's recorded state and SIGTERMed a foreign
// `opencode serve` — in the victim's 200ms request-drain window.
//
// The stale watcher is modeled directly, with no timing involved: scenario A
// boots and records a detached fake the normal way and its fake then dies; a
// second scenario B has a live fake and a published state file; the restart
// is invoked for A's workspace while B's namespace is current. It must refuse
// before touching anything: B's instance alive with its cmdline unchanged,
// B's state file byte-identical, no child spawned.
//
// Linux-only like the scenario scaffolding it reuses (flock, /proc).

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// switchOCNamespace makes dir the process cwd and stateDir the VH_STATE_DIR —
// the two ambient inputs every detached-OpenCode path, log and lock file is
// resolved from — and restores the namespace that was current at the call in
// cleanup. Hand-rolled rather than t.Chdir/t.Setenv because the scenario
// helper already claimed those once-per-test seams for scenario A.
func switchOCNamespace(t *testing.T, dir, stateDir string) {
	t.Helper()
	prevDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	prevState, hadState := os.LookupEnv("VH_STATE_DIR")
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir %s: %v", dir, err)
	}
	if err := os.Setenv("VH_STATE_DIR", stateDir); err != nil {
		t.Fatalf("setenv VH_STATE_DIR: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(prevDir); err != nil {
			t.Errorf("restore cwd %s: %v", prevDir, err)
		}
		if hadState {
			_ = os.Setenv("VH_STATE_DIR", prevState)
		} else {
			_ = os.Unsetenv("VH_STATE_DIR")
		}
	})
}

// TestRestartDetachedRefusesForeignWorkspace — a restart issued for project
// A while project B's namespace is ambient must refuse: no signal, no state
// write, no spawn. Pre-fix it fails on the crux (B's instance was signalled).
func TestRestartDetachedRefusesForeignWorkspace(t *testing.T) {
	// Scenario A: its own workspace + VH_STATE_DIR (the scenario helper), a
	// detached fake `opencode serve` booted and recorded the normal way.
	sc := newOCLockScenario(t)
	resA := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if resA.Verdict != DetachedStartSpawned {
		t.Fatalf("A boot: %v (%s)", resA.Verdict, resA.Reason)
	}
	// Reap at cleanup so no zombie is left behind (the fake is this test
	// process's child; until reaped its pid cannot be recycled).
	t.Cleanup(func() { _ = resA.Cmd.Process.Kill(); _, _ = resA.Cmd.Process.Wait() })

	// Scenario B: a second workspace and state dir, its namespace made
	// current, with a live fake and a published state file.
	bBase := t.TempDir()
	bDir := filepath.Join(bBase, "ws")
	bState := filepath.Join(bBase, "state")
	if err := os.MkdirAll(bDir, 0o755); err != nil {
		t.Fatal(err)
	}
	switchOCNamespace(t, bDir, bState)
	resB := EnsureDetachedOpenCode(sc.bin, bDir)
	if resB.Verdict != DetachedStartSpawned {
		t.Fatalf("B boot: %v (%s)", resB.Verdict, resB.Reason)
	}
	t.Cleanup(func() { _ = resB.Cmd.Process.Kill(); _, _ = resB.Cmd.Process.Wait() })
	bPID, bPort := resB.PID, resB.Port

	// Preconditions: B is the ambient project, its instance is live, and its
	// state file is published exactly where the restart would read it.
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if OCProjectKey(sc.dir) == OCProjectKey(cwd) {
		t.Fatalf("precondition: scenario A (%s) and the ambient cwd (%s) must be different projects", sc.dir, cwd)
	}
	if st, ok := readOCState(); !ok || st.PID != bPID || st.Port != bPort {
		t.Fatalf("precondition: ambient recorded state=%+v ok=%v, want B's pid=%d port=%d", st, ok, bPID, bPort)
	}
	bStatePath := ocStatePath()
	bStateBefore, err := os.ReadFile(bStatePath)
	if err != nil {
		t.Fatalf("precondition: read B's state file %s: %v", bStatePath, err)
	}
	bCmdline := ocProcCmdlineArgs(bPID)
	if !ocProcessRunning(bPID) || bCmdline == "" {
		t.Fatalf("precondition: B's fake pid %d must be live with a readable cmdline (running=%v cmdline=%q)", bPID, ocProcessRunning(bPID), bCmdline)
	}
	spawnsBefore := fakeSpawnCount(t, sc)
	if spawnsBefore != 2 {
		t.Fatalf("precondition: want exactly 2 recorded fakes (A's and B's), got %d", spawnsBefore)
	}

	// A's scenario ends: the sweep SIGKILLs its fake. What outlives it is A's
	// daemon and its death watcher — modeled by the direct call below with
	// exactly what the watcher's arm holds: A's workspace, A's port, and A's
	// retained child pid (dead, still an unreaped zombie of this process).
	killPid9(resA.PID)
	if !waitPidDead(resA.PID, 5*time.Second) {
		t.Fatalf("A's fake pid %d did not die", resA.PID)
	}

	// ACT: A's stale death watcher restarts ITS workspace while B's
	// namespace is ambient.
	cmd, effPort, err := restartDetachedOpenCode(sc.bin, resA.Port, sc.dir, resA.PID)
	if cmd != nil && cmd.Process != nil {
		// Reachable only on a regressed tree: reap what must never have been
		// spawned, so the red run leaks nothing either.
		t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	}

	// THE CRUX — asserted first, so a regression fails on the kill itself
	// and not on a downstream consequence of it. Zombie-aware: a SIGTERMed
	// fake stays an un-reaped zombie of this process (signal-0 existence
	// alone would still hold).
	if !ocProcessRunning(bPID) || ocProcCmdlineArgs(bPID) != bCmdline {
		t.Fatalf("CROSS-PROJECT KILL: B's `opencode serve` (pid %d, port %d) did not survive a restart issued for ANOTHER workspace %q while %q was the current project — running=%v cmdline=%q, want running with cmdline %q. The restart resolved B's recorded state from the ambient namespace and signalled B's instance — the mid-request 502 \"upstream error: EOF\" of the Fans/retarget flake",
			bPID, bPort, sc.dir, cwd, ocProcessRunning(bPID), ocProcCmdlineArgs(bPID), bCmdline)
	}

	if err == nil {
		t.Fatalf("restart for workspace %q must refuse while %q is the current project; got err=nil (cmd=%v effectivePort=%d)", sc.dir, cwd, cmd, effPort)
	}
	if cmd != nil || effPort != 0 {
		t.Fatalf("a refused restart must return (nil, 0, err); got cmd=%v effectivePort=%d err=%v", cmd, effPort, err)
	}
	// The refusal names both projects: the one given and the one that is current.
	for _, want := range []string{sc.dir, cwd} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("refusal must name the given workspace %q and the current one %q: %v", sc.dir, cwd, err)
		}
	}

	// B's state file is byte-identical.
	bStateAfter, err := os.ReadFile(bStatePath)
	if err != nil {
		t.Fatalf("re-read B's state file %s: %v", bStatePath, err)
	}
	if string(bStateAfter) != string(bStateBefore) {
		t.Fatalf("B's state file changed under a refused restart: %q → %q", bStateBefore, bStateAfter)
	}

	// No child was spawned: no new pid marker, and B's is the only live fake.
	if n := fakeSpawnCount(t, sc); n != spawnsBefore {
		t.Fatalf("the restart spawned a child: %d fake pid files before, %d after", spawnsBefore, n)
	}
	if live := sc.aliveMatchingPids(".fake"); len(live) != 1 || live[0] != bPID {
		t.Fatalf("live fakes after the refused restart = %v, want exactly B's pid %d", live, bPID)
	}
}

// TestOCWorkspaceMismatch pins the guard's classification with no process
// involved: the cwd string, and any other spelling of that same directory
// (relative — also the "." fallback for an unreadable cwd — or through a
// symlink), identify the ambient project; a different directory is refused
// with a message naming both directories.
func TestOCWorkspaceMismatch(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	other := filepath.Join(base, "other")
	for _, d := range []string{real, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	t.Chdir(real)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name      string
		workspace string
	}{
		{"the cwd string", cwd},
		{"relative", "."},
		{"through a symlink", link},
	} {
		if why := ocWorkspaceMismatch(tc.workspace); why != "" {
			t.Errorf("%s: workspace %q (cwd %q) must be admitted, refused with: %s", tc.name, tc.workspace, cwd, why)
		}
	}
	want := fmt.Sprintf("workspace %q is not the current project directory %q", other, cwd)
	if why := ocWorkspaceMismatch(other); why != want {
		t.Errorf("another directory: refusal = %q, want %q", why, want)
	}
}
