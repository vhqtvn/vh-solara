//go:build linux

package cmd

// Boot-glue test (oc-death-watch S2 fallout): the DEFER asked whether the
// FULL production boot — rt.setupVHMode(), the exact function the
// client-daemon --web=vh cobra arm calls — actually wires the death
// watcher's "OpenCode down" notification all the way to a browser-visible
// /vh/stream notice. The watcher tests (opencode_watch_test.go) prove the
// watcher in isolation; the alerts tests prove the engine in isolation.
// This test proves the GLUE between them:
//
//	setupVHMode → InitAlerts → SetAggHook
//	           → ocWatcher.SetAlert(alertEngine.EmitDaemonNotice)
//	           → engine.Attach (fired by aggFor("") on first project open)
//	           → store.EmitNotice → live /vh/stream subscriber
//
// plus the retry-storm gating input (S2): the upstream-down probe
// setupVHMode installs reads life.Snapshot().DownSince, so the observable
// contract is that DownSince is exposed non-nil exactly while the watcher
// knows OpenCode is down (pkg/web has no probe getter to assert closure
// identity — we assert the predicate's input over the SAME lifecycle the
// real setupVHMode closed over, served by the real /vh/opencode/status).
//
// This is "the incident test": if OpenCode dies under the real daemon, the
// user watching the stream gets a notice and the status endpoint reports
// down — then self-heals. A failure here means production wiring broke.
//
// Linux-only like the other ocLockScenario tests (flock, /proc, zombie
// semantics). Serial like the whole package (knob/env swaps).

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// killPidTerm signals pid with SIGTERM (the graceful death the watcher
// must report as "signal TERM/15"). Mirrors killPid9's shape.
func killPidTerm(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
}

// streamRecorder is a mutex-guarded accumulation of everything an SSE
// endpoint writes — the test greps it for notice frames.
type streamRecorder struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (s *streamRecorder) write(p string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf.WriteString(p)
}

func (s *streamRecorder) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// bootGlueStatus fetches /vh/opencode/status off the REAL setupVHMode
// listener and returns the raw body. A non-200 fails the test: the
// lifecycle must be wired (the nil-lifecycle 503 path is the unwired
// posture this test exists to rule out).
func bootGlueStatus(t *testing.T, rt *clientDaemonRuntime) string {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/vh/opencode/status", rt.webPort))
	if err != nil {
		t.Fatalf("status request: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: want 200 with wired lifecycle, got %d: %s", resp.StatusCode, b)
	}
	return string(b)
}

// TestOCBootGlueDeathNoticeReachesStream drives the REAL setupVHMode boot
// (only the binary and timing knobs stubbed, exactly like the watch tests),
// kills the live OpenCode child with SIGTERM, and asserts the full chain:
// watcher detects → lifecycle flips failed/down → ONE "OpenCode down"
// notice lands on the live /vh/stream subscription → auto-restart heals →
// status back to ready with a NEW pid and no down_since.
func TestOCBootGlueDeathNoticeReachesStream(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, true)
	withWatchKnobs(t, 5*time.Millisecond, 700*time.Millisecond, 1*time.Second, time.Hour, time.Hour, 5)

	// setupVHMode captures the running version via `<bin> --version` with
	// a Background context (no deadline). The scenario's stock fake treats
	// ANY argv as serve-and-sleep-forever, so a plain sc.bin would hang the
	// boot. Overwrite the wrapper with one that answers --version and
	// forwards everything else to the fake — still the real code path.
	verScript := "#!/bin/sh\ncase \"$1\" in --version) echo \"opencode 99.0.0-bootglue-fixture\"; exit 0;; esac\nexport VH_OC_LOCK_HELPER=fake\nexec \"$VH_OC_TESTBIN\" -test.run='^TestOCLockHelperProcess$' -- opencode \"$@\"\n"
	if err := os.WriteFile(sc.bin, []byte(verScript), 0o755); err != nil {
		t.Fatal(err)
	}

	rt := &clientDaemonRuntime{cwd: sc.dir}

	// Daemon-shaped teardown (mirrors the KillFunc / SetRestartServer
	// shutdown order). Registered BEFORE the stream cleanup below, so LIFO
	// runs it AFTER the stream is cancelled (an open SSE conn would
	// otherwise hold Shutdown open). The scenario's leftover sweep was
	// registered first and runs last, as designed.
	t.Cleanup(func() {
		if rt.vhCancel != nil {
			rt.vhCancel()
		}
		if rt.vhHTTP != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = rt.vhHTTP.Shutdown(ctx)
			cancel()
		}
		if rt.vhSrv != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = rt.vhSrv.Shutdown(ctx)
			cancel()
		}
		if rt.procCtxCancel != nil {
			rt.procCtxCancel()
		}
	})

	// THE production boot under test.
	rt.setupVHMode()

	// Boot reached ready through the real listener.
	watchWaitFor(t, 15*time.Second, func() bool {
		return strings.Contains(bootGlueStatus(t, rt), `"state":"ready"`)
	}, "boot reaches ready over /vh/opencode/status")

	first := rtChildCmd(rt)
	if first == nil {
		t.Fatal("boot did not retain the spawned child cmd")
	}
	pid := first.Process.Pid
	t.Cleanup(func() { _ = first.Wait() }) // reap the SIGTERM'd zombie

	// Subscribe BEFORE the kill: a plain GET /vh/stream with no dir opens
	// the default project (aggFor("") fires the aggHook the alerts engine
	// installed — engine.Attach, the "OPENED projects only" fan-out rule)
	// and subscribes the connection. Notices are live-only, so this
	// ordering is the production shape: browser open → death → notice.
	streamCtx, streamCancel := context.WithCancel(context.Background())
	rec := &streamRecorder{}
	req, err := http.NewRequestWithContext(streamCtx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/vh/stream?cursor=0", rt.webPort), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream connect: %v", err)
	}
	t.Cleanup(func() {
		streamCancel()
		_ = resp.Body.Close()
	})
	go func() {
		r := bufio.NewReader(resp.Body)
		for {
			line, err := r.ReadString('\n')
			if line != "" {
				rec.write(line)
			}
			if err != nil {
				return
			}
		}
	}()

	// ": hello" is flushed at handler entry; SubscribeWith happens shortly
	// after, before the snapshot frames. Wait for the hello then give the
	// handler a generous beat to register the subscription.
	watchWaitFor(t, 10*time.Second, func() bool {
		return strings.Contains(rec.String(), ": hello")
	}, "stream handshake")
	time.Sleep(250 * time.Millisecond)

	// ——— the incident ———
	killPidTerm(pid)

	// The notice the daemon owes the user: a live SSE "notice" frame whose
	// payload is the watcher's summary for THIS pid (title "OpenCode",
	// detail "opencode serve pid <pid> exited (signal TERM/15) after …").
	wantDetail := fmt.Sprintf("opencode serve pid %d exited (signal TERM/15)", pid)
	watchWaitFor(t, 10*time.Second, func() bool {
		s := rec.String()
		return strings.Contains(s, "event: notice") &&
			strings.Contains(s, `"type":"stalled"`) &&
			strings.Contains(s, `"title":"OpenCode"`) &&
			strings.Contains(s, wantDetail)
	}, `"OpenCode down" notice on /vh/stream`)

	// Lifecycle posture while down: failed + down_since + the same summary,
	// served by the real endpoint over the real lifecycle. down_since is
	// also the exact input the !external upstream-down probe reads — its
	// presence here is the gating engaging (input-level; see file header).
	watchWaitFor(t, 5*time.Second, func() bool {
		body := bootGlueStatus(t, rt)
		return strings.Contains(body, `"state":"failed"`) &&
			strings.Contains(body, `"down_since"`) &&
			strings.Contains(body, wantDetail)
	}, "status failed + down_since + failure summary while down")

	// ——— self-heal ———
	// Auto-restart (700ms backoff with the test knobs) respawns a fresh
	// child: ready again, down_since GONE (the probe input de-asserts —
	// aggregator reconnect gating disengages), and a NEW pid under watch.
	watchWaitFor(t, 15*time.Second, func() bool {
		body := bootGlueStatus(t, rt)
		return strings.Contains(body, `"state":"ready"`) &&
			!strings.Contains(body, `"down_since"`)
	}, "status heals to ready with down_since cleared")
	if newPid := rtChildPID(rt); newPid == 0 || newPid == pid {
		t.Fatalf("replacement child pid: want a new pid != %d, got %d", pid, newPid)
	}
	if n := fakeTotal(sc); n < 2 {
		t.Fatalf("respawn: want >=2 fake spawns (boot + restart), got %d", n)
	}
}
