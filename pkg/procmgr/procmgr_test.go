package procmgr

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
	"github.com/vhqtvn/vh-solara/pkg/ringlog"
)

func TestMain(m *testing.M) {
	// `go test` builds+runs the testdata helper as a real binary so the unix
	// readiness path exercises a live socket served by a managed child.
	os.Exit(m.Run())
}

// buildSockServer compiles testdata/sockserver into a temp binary and returns
// its path. Skips the test if the toolchain is unavailable.
func buildSockServer(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH")
	}
	out := filepath.Join(t.TempDir(), "sockserver")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", out, "./testdata/sockserver")
	cmd.Env = append(os.Environ(), "GO111MODULE=on")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("go build sockserver: %v\n%s", err, b)
	}
	return out
}

func TestManager_UnixReadiness_BecomesReady(t *testing.T) {
	bin := buildSockServer(t)
	sock := filepath.Join(t.TempDir(), "s.sock")
	_ = os.Remove(sock)
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir:       "/proj",
		ID:        "board",
		Argv:      []string{bin, sock},
		Cwd:       ".",
		Restart:   projectcfg.RestartNo,
		Readiness: &projectcfg.Readiness{Unix: sock},
	}); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopAll()

	if !waitFor(t, 8*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "board")
		return st.Status == StatusReady
	}) {
		st, _ := mgr.Status("/proj", "board")
		logs, _ := mgr.Logs("/proj", "board", 4096)
		t.Fatalf("never reached ready; status=%s logs=%s", st.Status, logs)
	}

	// The view can now dial the socket the process serves.
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial socket after ready: %v", err)
	}
	c.Close()
}

func TestManager_DefaultSettleReady(t *testing.T) {
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir:     "/proj",
		ID:      "sleeper",
		Argv:    []string{"/bin/sh", "-c", "sleep 30"},
		Cwd:     t.TempDir(),
		Restart: projectcfg.RestartNo,
	}); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopAll()
	if !waitFor(t, 8*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "sleeper")
		return st.Status == StatusReady
	}) {
		t.Fatal("default-settle never reached ready")
	}
}

func TestManager_LogReadinessProbe(t *testing.T) {
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir:       "/proj",
		ID:        "logger",
		Argv:      []string{"/bin/sh", "-c", "echo starting; sleep 0.3; echo LISTENING; sleep 30"},
		Cwd:       t.TempDir(),
		Restart:   projectcfg.RestartNo,
		Readiness: &projectcfg.Readiness{Log: "LISTENING"},
	}); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopAll()
	if !waitFor(t, 8*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "logger")
		return st.Status == StatusReady
	}) {
		logs, _ := mgr.Logs("/proj", "logger", 4096)
		t.Fatalf("log-readiness never reached ready\nLOGS:\n%s", string(logs))
	}
}

// TestManager_LogReadinessDoesNotFlap guards the one-shot semantics: a log probe
// is a STARTUP signal, not a recurring health check. The matched line is flooded
// out of the (shrunk) log ring AFTER readiness, while the process stays alive;
// with a recurring log health check this would flap to unhealthy/restart. It
// must stay ready.
func TestManager_LogReadinessDoesNotFlap(t *testing.T) {
	prevCap, prevHI := logCap, healthInterval
	logCap, healthInterval = 256, 20*time.Millisecond
	t.Cleanup(func() { logCap, healthInterval = prevCap, prevHI })

	mgr := NewManager(mgrCtx())
	defer mgr.StopAll()
	// READY stays alone in the ring ~0.6s (so the readiness probe detects it),
	// then a flood evicts it from the 256-byte ring while the process stays alive.
	if err := mgr.Start(ProcSpec{
		Dir: "/proj", ID: "logger", Cwd: t.TempDir(),
		Argv:      []string{"/bin/sh", "-c", "echo READY; sleep 0.6; i=0; while [ $i -lt 200 ]; do echo XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX; i=$((i+1)); done; sleep 10"},
		Restart:   projectcfg.RestartNo,
		Readiness: &projectcfg.Readiness{Log: "READY"},
	}); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 5*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "logger")
		return st.Status == StatusReady
	}) {
		t.Fatal("never reached ready")
	}
	// Wait until READY has been evicted from the ring (flood ran).
	if !waitFor(t, 5*time.Second, func() bool {
		b, _ := mgr.Logs("/proj", "logger", 0)
		return !strings.Contains(string(b), "READY")
	}) {
		t.Fatal("READY never evicted from the log ring")
	}
	// Now, across several health intervals with READY gone, it must NOT flap.
	for i := 0; i < 10; i++ {
		time.Sleep(20 * time.Millisecond)
		st, _ := mgr.Status("/proj", "logger")
		if st.Status != StatusReady {
			t.Fatalf("log-readiness flapped to %s (restarts=%d) — health re-probed a one-shot signal", st.Status, st.Restarts)
		}
	}
}

func TestManager_StartupTimeoutFailed(t *testing.T) {
	prev := startupTimeout
	startupTimeout = 800 * time.Millisecond
	t.Cleanup(func() { startupTimeout = prev })
	mgr := NewManager(mgrCtx())
	// A readiness socket that never appears → must hit startupTimeout → failed.
	// restart:No so it stays failed (no retry loop).
	if err := mgr.Start(ProcSpec{
		Dir:       "/proj",
		ID:        "never",
		Argv:      []string{"/bin/sh", "-c", "sleep 120"},
		Cwd:       ".",
		Restart:   projectcfg.RestartNo,
		Readiness: &projectcfg.Readiness{Unix: "/does/not/exist.sock"},
	}); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopAll()
	if !waitFor(t, startupTimeout+5*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "never")
		return st.Status == StatusFailed
	}) {
		t.Fatal("expected failed(startup) after timeout")
	}
}

func TestManager_OnFailureRestarts(t *testing.T) {
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir:     "/proj",
		ID:      "crash",
		Argv:    []string{"/bin/sh", "-c", "exit 7"},
		Cwd:     ".",
		Restart: projectcfg.RestartOnFailure,
	}); err != nil {
		t.Fatal(err)
	}
	defer mgr.StopAll()
	if !waitFor(t, 15*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "crash")
		return st.Restarts >= 2
	}) {
		st, _ := mgr.Status("/proj", "crash")
		t.Fatalf("expected on-failure restarts; restarts=%d status=%s", st.Restarts, st.Status)
	}
}

func TestManager_OnFailureGivesUp(t *testing.T) {
	prevN, prevB, prevMax := maxConsecutiveFailures, backoffBase, maxBackoff
	maxConsecutiveFailures, backoffBase, maxBackoff = 3, 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { maxConsecutiveFailures, backoffBase, maxBackoff = prevN, prevB, prevMax })

	mgr := NewManager(mgrCtx())
	defer mgr.StopAll()
	if err := mgr.Start(ProcSpec{
		Dir: "/proj", ID: "boom", Cwd: ".",
		Argv: []string{"/bin/sh", "-c", "exit 1"}, Restart: projectcfg.RestartOnFailure,
	}); err != nil {
		t.Fatal(err)
	}
	// A process that always fails must eventually give up (→ failed), not retry
	// forever.
	if !waitFor(t, 5*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "boom")
		return st.Status == StatusFailed
	}) {
		st, _ := mgr.Status("/proj", "boom")
		t.Fatalf("expected failed (gave up); status=%s restarts=%d", st.Status, st.Restarts)
	}
}

// TestManager_ConcurrentArmNoDeadlock hammers Start/Restart on a never-ready
// restart:always process. Every attempt hits readyTimeout → failed → backoff
// sleep, the window where the supervisor loop is alive but not "running". A
// concurrent arm() that waited on that loop WITHOUT cancelling it first would
// wedge forever (the loop relaunches under restart:always). The test fails (by
// timing out) if arm() ever deadlocks.
func TestManager_ConcurrentArmNoDeadlock(t *testing.T) {
	prevTO, prevB, prevMax := startupTimeout, backoffBase, maxBackoff
	startupTimeout, backoffBase, maxBackoff = 150*time.Millisecond, 10*time.Millisecond, 30*time.Millisecond
	t.Cleanup(func() { startupTimeout, backoffBase, maxBackoff = prevTO, prevB, prevMax })

	mgr := NewManager(mgrCtx())
	defer mgr.StopAll()
	dir := t.TempDir()
	spec := ProcSpec{
		Dir: "/proj", ID: "stuck", Cwd: dir,
		Argv:      []string{"/bin/sh", "-c", "sleep 60"},
		Restart:   projectcfg.RestartAlways,
		Readiness: &projectcfg.Readiness{Unix: filepath.Join(dir, "never.sock")},
	}
	if err := mgr.Start(spec); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 30; j++ {
					if j%2 == 0 {
						_ = mgr.Start(spec)
					} else {
						_ = mgr.Restart("/proj", "stuck")
					}
					time.Sleep(5 * time.Millisecond)
				}
			}()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(25 * time.Second):
		t.Fatal("Start/Restart wedged — arm() deadlock regression")
	}
}

// TestManager_ConcurrentStartSpawnFailNoRace hammers Start (which refreshes
// p.spec) on a proc whose supervisor loop is repeatedly hitting the spawn-fail
// path (which logs the id). It catches any unsynchronized p.spec read in run().
func TestManager_ConcurrentStartSpawnFailNoRace(t *testing.T) {
	prevB, prevMax := backoffBase, maxBackoff
	backoffBase, maxBackoff = 2*time.Millisecond, 2*time.Millisecond
	t.Cleanup(func() { backoffBase, maxBackoff = prevB, prevMax })

	mgr := NewManager(mgrCtx())
	defer mgr.StopAll()
	spec := ProcSpec{
		Dir: "/proj", ID: "nope", Cwd: t.TempDir(),
		Argv:    []string{"/nonexistent/definitely-not-here"},
		Restart: projectcfg.RestartAlways, // never gives up → keeps looping the spawn-fail log
	}
	if err := mgr.Start(spec); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 50; j++ {
					_ = mgr.Start(spec)
					_, _ = mgr.Status("/proj", "nope")
					time.Sleep(time.Millisecond)
				}
			}()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("Start wedged")
	}
}

func TestManager_NoRestartCleanExit(t *testing.T) {
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir:     "/proj",
		ID:      "ok",
		Argv:    []string{"/bin/sh", "-c", "exit 0"},
		Cwd:     ".",
		Restart: projectcfg.RestartNo,
	}); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 5*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "ok")
		return st.Status == StatusStopped
	}) {
		st, _ := mgr.Status("/proj", "ok")
		t.Fatalf("expected stopped after clean exit; status=%s", st.Status)
	}
}

func TestManager_StopSetsStopped(t *testing.T) {
	mgr := NewManager(mgrCtx())
	if err := mgr.Start(ProcSpec{
		Dir: "/proj", ID: "long", Cwd: t.TempDir(),
		Argv: []string{"/bin/sh", "-c", "sleep 120"}, Restart: projectcfg.RestartAlways,
	}); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 6*time.Second, func() bool {
		st, _ := mgr.Status("/proj", "long")
		return st.Status == StatusReady
	}) {
		t.Fatal("not ready before stop")
	}
	mgr.Stop("/proj", "long")
	st, _ := mgr.Status("/proj", "long")
	if st.Status != StatusStopped {
		t.Fatalf("expected stopped, got %s", st.Status)
	}
}

func TestManager_StatusesScopedToDir(t *testing.T) {
	mgr := NewManager(mgrCtx())
	cwd := t.TempDir()
	mgr.Start(ProcSpec{Dir: "/a", ID: "p1", Cwd: cwd, Argv: []string{"/bin/sh", "-c", "sleep 30"}, Restart: projectcfg.RestartNo})
	mgr.Start(ProcSpec{Dir: "/b", ID: "p2", Cwd: cwd, Argv: []string{"/bin/sh", "-c", "sleep 30"}, Restart: projectcfg.RestartNo})
	defer mgr.StopAll()
	if got := len(mgr.Statuses("/a")); got != 1 {
		t.Fatalf("dir /a: got %d procs", got)
	}
	if got := len(mgr.Statuses("/b")); got != 1 {
		t.Fatalf("dir /b: got %d procs", got)
	}
}

// --- probe helper unit tests ---

func TestProbeUnixAndHTTP(t *testing.T) {
	// unix probe true once listening.
	dir := t.TempDir()
	sock := filepath.Join(dir, "x.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !dialUnix(mgrCtx(), sock) {
		t.Fatal("dialUnix should succeed on live socket")
	}
	if dialUnix(mgrCtx(), filepath.Join(dir, "nope.sock")) {
		t.Fatal("dialUnix should fail on absent socket")
	}

	// http probe.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if !probeHTTP(mgrCtx(), srv.URL) {
		t.Fatal("probeHTTP should pass on 2xx")
	}
	if probeHTTP(mgrCtx(), "http://127.0.0.1:1") {
		t.Fatal("probeHTTP should fail on unreachable")
	}
}

func TestLogsTail(t *testing.T) {
	r := ringlog.New(16)
	r.Append("hello world\n")
	b := r.Tail(5)
	if string(b) != "orld\n" {
		t.Fatalf("tail = %q", b)
	}
	if strings.Contains(string(r.Tail(0)), "hello world") == false {
		t.Fatal("tail(0) should return whole ring")
	}
}

// --- test helpers ---

// mgrCtx returns a context for a manager whose lifetime is bounded by the test
// (the manager is always StopAll'd via t.Cleanup by each test). Background is
// fine because the per-proc contexts derive from it and Stop/StopAll cancel.
func mgrCtx() context.Context { return context.Background() }

// waitFor polls cond every 50ms up to timeout; returns true once cond is true.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cond()
}
