// oc-death-watch (S1): detect the detached `opencode serve` child's death
// within seconds WITHOUT reaping it, and self-heal through the SAME
// serialized restart arm the UI restart hook uses.
//
// Motivating incident (2026-10-03 21:00:42 +07): `pkill -x opencode` killed
// the shared detached `opencode serve`; it stayed a zombie under the daemon
// for 60 minutes, everything downstream (aggregator, rehydrate, /oc/* proxy)
// got connection-refused, and recovery needed a manual
// `systemctl --user restart vh-opencode.service`.
//
// The no-reap invariant: the detached child is DELIBERATELY never Wait()ed
// (see opencode_start.go) so its PID stays unreusable while the zombie exists
// — curPID signaling in restartDetachedOpenCode can never hit a recycled pid.
// The watcher must therefore observe the exit WITHOUT consuming the zombie:
// on Linux the parent case polls waitid(WNOHANG|WNOWAIT), which reports the
// exit while leaving the child reapable-but-unreaped (opencode_watch_linux.go);
// every other case (reattached instance — we are not its parent — and
// non-Linux builds) polls process identity (alive + /proc cmdline + start
// time), where a zombie reads as an empty cmdline → dead.
//
// Auto-restart policy (detached serve ONLY): on an unexpected death the
// watcher routes through the SAME serialized arm as the UI restart hook
// (SetStarting → restartDetachedOpenCode → applyFreshPortRetarget → SetReady)
// with exponential backoff and a crash-loop cap. Deliberate stops —
// lifecycle `stopped`, a restart already in flight (`starting`), daemon
// teardown (ctx cancelled) — never auto-restart.

package cmd

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// Watcher timing knobs. Package vars so tests can shrink them (mirroring
// ocOwnerReleaseWait).
var (
	// ocWatchTick is the poll interval. Sub-second by design — the incident
	// class this watcher exists for must be detected "within seconds".
	ocWatchTick = 250 * time.Millisecond
	// ocWatchBackoffBase / ocWatchBackoffMax bound the exponential restart
	// backoff (1s ×2, cap 30s — mirrors pkg/aggregator/lifecycle.go).
	ocWatchBackoffBase = time.Second
	ocWatchBackoffMax  = 30 * time.Second
	// ocWatchHealthyReset: a child that stayed up at least this long before
	// dying resets the backoff and the crash-window attempt count.
	ocWatchHealthyReset = 30 * time.Second
	// ocWatchCrashMax auto-restart attempts allowed within ocWatchCrashWindow
	// before the watcher gives up and records a visible failed state.
	ocWatchCrashMax    = 5
	ocWatchCrashWindow = 10 * time.Minute
)

// ocDetachedRestartArm is the serialized detached restart shared by
// client-daemon's restartOpencode and local-server's restartOpencodeLocked
// (the two arms were verbatim duplicates except for log noun and access
// path). The UI restart hook and the death watcher BOTH route through it, so
// a watcher-driven restart is indistinguishable from a user-driven one —
// same starter-lock serialization, same pid revalidation, same port
// retarget wiring.
//
// Caller must hold the runtime's opencodeMu (the run() bodies did).
type ocDetachedRestartArm struct {
	Bin  string
	Cwd  string
	Life *oclife.Lifecycle
	// Noun names the running daemon in the fresh-port log line
	// ("daemon" | "local-server").
	Noun string
	// Srv returns the running web server (may be nil early / in tests).
	Srv func() *web.Server
	// Cmd returns the retained child (nil when the daemon reattached).
	Cmd func() *exec.Cmd
	// SetCmd records the retained child (called only when a child exists).
	SetCmd func(*exec.Cmd)
	// Port returns the port the daemon currently targets.
	Port func() int
	// SetPort records a retargeted port + URL.
	SetPort func(port int, url string)
	// OnDone fires after the attempt settles (error path included) with the
	// effective port. The death watcher re-arms itself here: a readiness
	// failure's retained child is still worth watching — its pid feeds the
	// next restart's curPID, and this watcher is what notices if it dies.
	OnDone func(cmd *exec.Cmd, effectivePort int, err error)
}

// Run performs ONE serialized detached restart. Semantics preserved exactly
// from the two inlined arms it replaces (client-daemon-vh.go /
// local-server.go): SetStarting → curPID from the retained child →
// restartDetachedOpenCode → retain a returned child even on error → on error
// SetFailed + return → applyFreshPortRetarget BEFORE the readiness flip →
// SetReady.
func (a *ocDetachedRestartArm) Run() error {
	a.Life.SetStarting()
	curPID := 0
	if c := a.Cmd(); c != nil && c.Process != nil {
		curPID = c.Process.Pid
	}
	oldPort := a.Port()
	c, effectivePort, err := restartDetachedOpenCode(a.Bin, oldPort, a.Cwd, curPID, a.Life.Ring().Writer())
	if c != nil {
		a.SetCmd(c)
	}
	if a.OnDone != nil {
		defer func() { a.OnDone(c, effectivePort, err) }()
	}
	if err != nil {
		a.Life.SetFailed(fmt.Sprintf("detached opencode restart failed: %v", err), nil)
		return err
	}
	// Port propagation happens BEFORE the readiness flip so a readiness
	// observer never sees ready state served through the old port.
	if p, u, retargeted := applyFreshPortRetarget(effectivePort, oldPort, a.Life, a.Srv()); retargeted {
		a.SetPort(p, u)
		log.Printf("detached opencode restart landed on a fresh port %d — retargeted the running %s (was port %d)", p, a.Noun, oldPort)
	}
	a.Life.SetReady()
	return nil
}

// ocWatchTarget is the child currently being watched.
type ocWatchTarget struct {
	gen  uint64 // watcher generation this target belongs to
	pid  int
	port int
	// startTime is the /proc/<pid>/stat starttime captured at arm time
	// (jiffies after boot; 0 = unknown). Pins the target against pid
	// recycling on the identity-poll path.
	startTime int64
	// startedAt is used for the death log's uptime. For a spawned child it
	// is arm time ≈ spawn time; for a reattached instance it is derived
	// from /proc starttime + boot time when both were readable (the
	// instance's true age), else arm time.
	startedAt time.Time
}

// ocExitReport carries what the watcher could observe about the exit.
type ocExitReport struct {
	// Code is the exit code observed without reaping (waitid WNOWAIT),
	// when observable.
	Code *int
	// Signal is the terminating signal, when observable.
	Signal *int
	// Unobserved is set when neither is observable (identity-poll path).
	Unobserved    bool
	UnobservedWhy string
}

func (r ocExitReport) describe() string {
	switch {
	case r.Code != nil:
		return fmt.Sprintf("exit code %d", *r.Code)
	case r.Signal != nil:
		return fmt.Sprintf("signal %s/%d", ocSignalShort(*r.Signal), *r.Signal)
	default:
		return fmt.Sprintf("exit status unobserved (%s)", r.UnobservedWhy)
	}
}

// ocSignalShort renders SIGTERM as "TERM" etc. for the stable, greppable
// death log line. Unknown signals fall back to SIG<n>.
func ocSignalShort(s int) string {
	names := map[int]string{
		1: "HUP", 2: "INT", 3: "QUIT", 6: "ABRT", 9: "KILL",
		10: "USR1", 11: "SEGV", 12: "USR2", 13: "PIPE", 15: "TERM",
	}
	if n, ok := names[s]; ok {
		return n
	}
	return fmt.Sprintf("SIG%d", s)
}

// ocDeathWatcher watches ONE OpenCode child at a time and applies the
// death policy. Construct with newOCDeathWatcher; Start launches the loop;
// Arm points it at each new child (boot verdict, restart OnDone).
//
// Concurrency shape: a single loop goroutine owns detection + policy + the
// restart attempts (executed synchronously through the restart callback, so
// at most one attempt is ever in flight). Arm is non-blocking (buffered
// channel — a newer arm always supersedes a queued one). The restart
// callback takes the daemon's opencodeMu and re-checks the generation under
// it, so a user restart winning the race leaves the auto attempt a no-op.
type ocDeathWatcher struct {
	life *oclife.Lifecycle
	// restart executes ONE serialized restart attempt for the given
	// generation. nil ⇒ detection-only mode (web mode): deaths are logged
	// and exposed, never restarted.
	restart func(gen uint64)
	// Reap is called once after a death in detection-only mode (web mode's
	// sole Wait() — populates cmd.ProcessState so the teardown HealthCheck
	// observes the exit). Never called in restart mode: reaping the
	// detached serve child would break the no-reap PID-reuse invariant.
	Reap func()

	// onAlert (oc-death-watch S2), when set, receives death-policy events
	// for the daemon's notifications engine: event "down" (detail = the
	// death summary) fires ONCE PER DOWN-SPELL — only the first death
	// observed while DownSince is unset; replacement children dying inside
	// the same spell stay silent — and event "capped" (detail = the
	// crash-loop give-up summary) fires once per give-up. Guarded by mu:
	// the daemon wires it after Start from another goroutine.
	onAlert func(event, detail string)

	mu       sync.Mutex
	gen      uint64
	started  bool
	armCh    chan *ocWatchTarget
	fireCh   chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once
}

// newOCDeathWatcher builds a watcher. life may be nil (web mode has no
// lifecycle); restart may be nil (detection-only).
func newOCDeathWatcher(life *oclife.Lifecycle, restart func(gen uint64)) *ocDeathWatcher {
	return &ocDeathWatcher{
		life:    life,
		restart: restart,
		armCh:   make(chan *ocWatchTarget, 8),
		fireCh:  make(chan struct{}, 1),
		stopCh:  make(chan struct{}),
	}
}

// Start launches the watcher loop; ctx cancellation (daemon teardown /
// KillFunc) stops it. Idempotent. A nil ctx (never happens in the wired
// daemon paths) degrades to an uncancellable watcher rather than panicking.
func (w *ocDeathWatcher) Start(ctx context.Context) *ocDeathWatcher {
	if ctx == nil {
		ctx = context.Background()
	}
	w.mu.Lock()
	already := w.started
	w.started = true
	w.mu.Unlock()
	if !already {
		go w.run(ctx)
	}
	return w
}

// Arm points the watcher at a child. parent=true when THIS process spawned
// the child (the Linux waitid fast path applies); false when we only know
// the pid from recorded state (reattached — we are not its parent). The
// flag is intentionally INFORMATIONAL: detection behavior is parent-agnostic
// because waitid's ECHILD on a non-child gives the same automatic fallback
// to the identity poll, so a mislabeled arm still detects honestly. Zero
// pid arms nothing. Non-blocking.
func (w *ocDeathWatcher) Arm(pid, port int, parent bool) {
	if pid <= 0 {
		return
	}
	w.mu.Lock()
	w.gen++
	gen := w.gen
	w.mu.Unlock()
	st := ocProcStartTime(pid)
	startedAt := time.Now()
	if st > 0 {
		if boot := ocProcBootTime(); boot > 0 {
			// True process age: boot time + starttime jiffies (USER_HZ=100
			// on Linux). Gives the honest uptime for a reattached instance.
			startedAt = time.Unix(boot+st/100, 0)
		}
	}
	select {
	case w.armCh <- &ocWatchTarget{gen: gen, pid: pid, port: port, startTime: st, startedAt: startedAt}:
	default:
		// Full: a newer arm is queued and supersedes this one. Dropping is
		// safe, but never silent.
		log.Printf("opencode watch: arm queue full — dropping watch for pid %d (a newer arm supersedes it)", pid)
	}
}

// Generation returns the arm counter; the restart callback uses it to detect
// that a newer child (e.g. a user restart's spawn) superseded its attempt.
func (w *ocDeathWatcher) Generation() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.gen
}

// SetAlert wires the death-policy alert sink (see onAlert). Optional — a
// watcher without one (web mode, local-server, boot-seam tests) just skips
// notification delivery. Safe to call before or after Start: the field is
// mu-guarded and the loop reads it per-event via fireAlert.
func (w *ocDeathWatcher) SetAlert(fn func(event, detail string)) {
	w.mu.Lock()
	w.onAlert = fn
	w.mu.Unlock()
}

// fireAlert invokes the alert sink, if wired, with the hook read under mu
// (the daemon may wire it after Start's loop goroutine is already running).
func (w *ocDeathWatcher) fireAlert(event, detail string) {
	w.mu.Lock()
	fn := w.onAlert
	w.mu.Unlock()
	if fn != nil {
		fn(event, detail)
	}
}

// Stop halts the loop (ctx cancellation covers the production teardown path).
func (w *ocDeathWatcher) Stop() {
	w.stopOnce.Do(func() { close(w.stopCh) })
}

// run is the watcher loop: poll for death, apply policy, schedule/execute
// restart attempts. All state below is loop-local — no locks needed.
func (w *ocDeathWatcher) run(ctx context.Context) {
	tick := time.NewTicker(ocWatchTick)
	defer tick.Stop()

	var (
		target     *ocWatchTarget
		attempts   []time.Time // restart attempts inside the crash window
		backoff    = ocWatchBackoffBase
		retryTimer *time.Timer
		retryGen   uint64
		retryPend  bool
	)

	prune := func() {
		cut := time.Now().Add(-ocWatchCrashWindow)
		live := attempts[:0]
		for _, t := range attempts {
			if t.After(cut) {
				live = append(live, t)
			}
		}
		attempts = live
	}
	stopTimer := func() {
		if retryTimer != nil {
			retryTimer.Stop()
			retryTimer = nil
		}
		retryPend = false
	}
	schedule := func(gen uint64) {
		delay := backoff
		backoff *= 2
		if backoff > ocWatchBackoffMax {
			backoff = ocWatchBackoffMax
		}
		retryGen = gen
		retryPend = true
		retryTimer = time.AfterFunc(delay, func() {
			select {
			case w.fireCh <- struct{}{}:
			default:
			}
		})
	}
	// giveUp records the terminal crash-loop state. deathLine, when
	// non-empty, is the already-formatted death context to prepend.
	giveUp := func(deathLine string) {
		summary := fmt.Sprintf("opencode crash-loop: %d restarts in %s — giving up", len(attempts), ocWatchCrashWindow)
		if w.life != nil {
			w.life.SetRestartProgress(len(attempts), true)
			w.life.SetFailed(summary, nil)
		}
		// S2: exactly one notification per give-up — the cap is terminal
		// (no further attempts fire), so no dedup is needed beyond the
		// sink's own cooldowns.
		w.fireAlert("capped", summary)
		if deathLine != "" {
			log.Printf("%s — crash-loop cap reached: %d restarts in %s — giving up", deathLine, len(attempts), ocWatchCrashWindow)
		} else {
			log.Printf("opencode watch: crash-loop cap reached: %d restarts in %s — giving up", len(attempts), ocWatchCrashWindow)
		}
	}

	for {
		select {
		case <-ctx.Done():
			// Daemon teardown: never restart; leave state as-is.
			stopTimer()
			return
		case <-w.stopCh:
			stopTimer()
			return

		case t := <-w.armCh:
			// A new child supersedes any pending retry for the old one.
			stopTimer()
			target = t

		case <-tick.C:
			if target == nil || retryPend {
				continue
			}
			rep, dead := ocDetectExit(target)
			if !dead {
				continue
			}
			pid, uptime, gen := target.pid, time.Since(target.startedAt), target.gen
			target = nil // disarm; re-armed by the next Arm (OnDone / boot)

			// ——— death observed ———
			// S2 alert dedup: MarkDown keeps the FIRST DownSince of a
			// down-spell, so "was this death already announced?" reduces to
			// "was the spell already open when we got here?". A replacement
			// child dying inside the same spell (restart attempt #2, #3, …
			// of a crash loop) does NOT re-alert — one "down" notice per
			// spell; the spell ends at SetReady, which clears DownSince.
			// The fire itself waits for the disposition below: deliberate
			// stops and in-flight restarts are EXPECTED deaths and stay
			// silent.
			wasDown := w.life != nil && w.life.Snapshot().DownSince != nil
			if w.life != nil {
				w.life.MarkDown()
			}
			line := fmt.Sprintf("opencode watch: pid %d exited (%s) after %s", pid, rep.describe(), uptime.Round(time.Second))
			summary := fmt.Sprintf("opencode serve pid %d exited (%s) after %s", pid, rep.describe(), uptime.Round(time.Second))

			if w.restart == nil {
				// Detection-only (web mode): log + expose + reap. The death
				// is unexpected by definition here (nothing deliberate is in
				// flight in this mode), so it alerts like the restart path.
				log.Printf("%s — unexpected; not restarting (detection-only)", line)
				if w.life != nil {
					w.life.SetFailed(summary, rep.Code)
				}
				if !wasDown {
					w.fireAlert("down", summary)
				}
				if w.Reap != nil {
					w.Reap()
				}
				continue
			}

			state := oclife.StateReady
			if w.life != nil {
				state = w.life.Snapshot().State
			}
			switch state {
			case oclife.StateStopped:
				// Deliberate stop (user stop / teardown): never auto-restart.
				log.Printf("%s — deliberate stop — not restarting", line)
				continue
			case oclife.StateStarting:
				// A restart is already in flight (user restart arm or the
				// external restart cmd) — its SetStarting preceded the kill
				// by construction. Do not double-spawn; do not count it.
				log.Printf("%s — restart already in progress — not auto-restarting", line)
				continue
			}

			// Unexpected death (first of its spell): raise the ONE
			// per-spell "down" notification. Later deaths inside the same
			// spell (crash-loop attempts) were filtered above by wasDown.
			if !wasDown {
				w.fireAlert("down", summary)
			}

			// A child that stayed healthy long enough resets the crash
			// accounting — this death starts a fresh spell.
			if uptime >= ocWatchHealthyReset {
				attempts = nil
				backoff = ocWatchBackoffBase
			}
			prune()
			if len(attempts) >= ocWatchCrashMax {
				giveUp(line)
				continue
			}
			log.Printf("%s — unexpected; restart %d/%d in %s", line, len(attempts)+1, ocWatchCrashMax, backoff)
			if w.life != nil {
				w.life.SetFailed(summary, rep.Code)
				w.life.SetRestartProgress(len(attempts)+1, false)
			}
			schedule(gen)

		case <-w.fireCh:
			if !retryPend {
				continue
			}
			retryPend = false
			retryTimer = nil
			prune()
			if len(attempts) >= ocWatchCrashMax {
				giveUp("")
				continue
			}
			attempts = append(attempts, time.Now())
			if w.life != nil {
				w.life.SetRestartProgress(len(attempts), false)
			}
			gen := retryGen
			w.restart(gen) // synchronous; serializes on the daemon's opencodeMu

			// Drain an arm the restart's OnDone may have posted.
			select {
			case t := <-w.armCh:
				target = t
			default:
			}
			if w.Generation() > gen {
				continue // a replacement child is being watched
			}
			// The attempt produced no child (spawn error / lock
			// contention): keep retrying under the same policy.
			prune()
			if len(attempts) >= ocWatchCrashMax {
				giveUp("")
				continue
			}
			log.Printf("opencode watch: restart attempt produced no replacement child — retry %d/%d in %s", len(attempts)+1, ocWatchCrashMax, backoff)
			if w.life != nil {
				w.life.SetRestartProgress(len(attempts)+1, false)
			}
			schedule(gen)
		}
	}
}

// ocDetectExit reports whether the target is dead and what was observable
// about the exit. Parent case: waitid(WNOWAIT) — the zombie is NOT reaped.
// Otherwise: identity poll (alive + cmdline + starttime).
func ocDetectExit(t *ocWatchTarget) (ocExitReport, bool) {
	if exited, code, sig, ourChild := ocPollParentExit(t.pid); ourChild {
		if exited {
			return ocExitReport{Code: code, Signal: sig}, true
		}
		return ocExitReport{}, false
	}
	// Not our child (reattached instance — waitid returns ECHILD) or a
	// platform without the wait fast path: poll identity. A zombie reads an
	// empty /proc cmdline → dead; a recycled pid fails starttime/cmdline.
	if ocWatchTargetAlive(t) {
		return ocExitReport{}, false
	}
	why := "reattached, not our child"
	if ocWatchNoWaitid {
		why = "exit status not waitable on this platform"
	}
	return ocExitReport{Unobserved: true, UnobservedWhy: why}, true
}

// ocWatchTargetAlive is the identity-poll liveness check for a process we
// did NOT spawn (or cannot wait on).
func ocWatchTargetAlive(t *ocWatchTarget) bool {
	if !ocProcessAlive(t.pid) {
		return false // gone entirely
	}
	if t.startTime > 0 {
		if st := ocProcStartTime(t.pid); st > 0 && st != t.startTime {
			return false // pid recycled into a different process
		}
	}
	// Zombie ⇒ /proc cmdline reads empty ⇒ no match; a live foreign
	// process on the same pid ⇒ cmdline mismatch.
	return ocCmdlineMatches(t.pid, t.port)
}

// ocProcStartTime reads /proc/<pid>/stat's starttime field (field 22,
// jiffies after boot). Returns 0 when unreadable (non-Linux, gone process).
func ocProcStartTime(pid int) int64 {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0
	}
	// The comm field can contain spaces and parentheses — parse after the
	// LAST ')'.
	s := string(b)
	if i := strings.LastIndexByte(s, ')'); i >= 0 && i+2 <= len(s) {
		s = s[i+2:]
		fields := strings.Fields(s)
		// fields[0] is state (field 3); starttime is field 22 → index 19.
		if len(fields) > 19 {
			if v, err := strconv.ParseInt(fields[19], 10, 64); err == nil {
				return v
			}
		}
	}
	return 0
}

// ocProcBootTime reads the boot time (epoch seconds) from /proc/stat.
// Returns 0 when unreadable.
func ocProcBootTime() int64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64); err == nil {
				return v
			}
		}
	}
	return 0
}
