// Package procmgr is a small supervisor for repo-declared companion processes
// (a board, a docs server, …) that vh-solara owns for the lifetime a project is
// open. It generalizes the detached-spawn/ownership/restart machinery already
// used for OpenCode (see cmd/opencode_detached.go) to arbitrary commands, and
// adds readiness probes + a health loop + a ring-buffered log.
//
// Lifecycle scope (locked): processes start when the project's config is
// trusted+opened, run until the daemon exits (graceful StopAll) or the operator
// stops them, and do NOT auto-start across a daemon restart — they come back
// lazily when the project is re-opened. restart:always is honored WITHIN one
// daemon lifetime (not across daemon restarts). There is no pidfile/reconnect:
// managed procs are torn down on daemon exit by design.
package procmgr

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
	"github.com/vhqtvn/vh-solara/pkg/ringlog"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Tunables (kept as vars so tests can shorten them; hoist to options if ever
// needed at runtime).
var (
	startupTimeout      = 30 * time.Second // max wait for readiness before failed(startup)
	defaultSettle       = 2 * time.Second  // no-probe readiness: alive this long → ready
	healthInterval      = 10 * time.Second
	healthFailThreshold = 2 // consecutive probe failures before kill+restart
	maxBackoff          = 30 * time.Second
	backoffBase         = 1 * time.Second
	// healthyResetAfter is how long a process must STAY ready before its failure
	// streak (which drives backoff) resets. Without this, a process that crashes
	// right after becoming ready would reset backoff every cycle and hammer at
	// backoffBase — the crash loop the backoff exists to dampen.
	healthyResetAfter = 30 * time.Second
	// maxConsecutiveFailures caps restart attempts for on-failure (give up →
	// failed). restart:always is never capped (but still backs off).
	maxConsecutiveFailures = 10
)

var logCap = 256 << 10 // 256 KiB ring per process (var so tests can shrink it)

// Status of a managed process.
type Status string

const (
	StatusStopped   Status = "stopped"   // not running (user-stopped, or clean exit with no restart)
	StatusStarting  Status = "starting"  // spawned, awaiting readiness
	StatusReady     Status = "ready"     // readiness reached, healthy
	StatusUnhealthy Status = "unhealthy" // health probe failing (will restart if policy allows)
	StatusFailed    Status = "failed"    // startup timeout, exec error, or exited with restart exhausted
)

// IsRunning reports whether the status denotes a live (or starting) process.
func (s Status) IsRunning() bool {
	return s == StatusStarting || s == StatusReady || s == StatusUnhealthy
}

// ProcSpec is the resolved declaration for one process (built by the
// orchestrator from a projectcfg.Process, with a derived readiness if the
// author omitted one).
type ProcSpec struct {
	Dir       string // project root (absolute)
	ID        string
	Argv      []string              // resolved argv (sh -c <s> for a string command)
	Cwd       string                // resolved absolute working directory
	Env       map[string]string     // merged over the daemon environment
	Restart   string                // projectcfg.Restart*
	Readiness *projectcfg.Readiness // optional; nil → default settle heuristic
	// OnReady, if set, is called (in its own goroutine) each time the process
	// reaches readiness. The orchestrator uses it to register dependent views
	// only once their backing process is actually up.
	OnReady func()
}

// Manager owns the set of managed processes for one daemon. It is safe for
// concurrent use. One Manager per daemon.
type Manager struct {
	base  context.Context
	mu    sync.Mutex
	procs map[string]*Proc // key = dir + "\x00" + id
}

// NewManager creates a Manager bound to base (the daemon lifetime). Each
// managed process derives a cancellable context from base.
func NewManager(base context.Context) *Manager {
	if base == nil {
		base = context.Background()
	}
	return &Manager{base: base, procs: map[string]*Proc{}}
}

func procKey(dir, id string) string { return dir + "\x00" + id }

// Start launches (or re-launches) the process for (dir,id). Idempotent: if a
// live proc exists for the spec it is left in place; if it exists but is
// stopped, it is restarted.
func (m *Manager) Start(spec ProcSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("procmgr: empty id")
	}
	if len(spec.Argv) == 0 {
		return fmt.Errorf("procmgr: empty argv for %s", spec.ID)
	}
	if spec.Cwd == "" {
		spec.Cwd = spec.Dir
	}
	k := procKey(spec.Dir, spec.ID)
	m.mu.Lock()
	p, ok := m.procs[k]
	if !ok {
		p = newProc(m.base, spec)
		m.procs[k] = p
	}
	m.mu.Unlock()
	if ok {
		// Refresh the declaration on re-arm under p.mu — a live supervisor loop
		// reads p.spec (snapshotSpec/scheduleRestart/snapshot) under p.mu, so the
		// m.mu held above is the wrong lock to guard this write.
		p.mu.Lock()
		p.spec = spec
		p.mu.Unlock()
	}
	return p.arm()
}

// Stop stops the process if running (graceful SIGTERM → SIGKILL). Status
// becomes stopped; the supervisor exits and will not restart.
func (m *Manager) Stop(dir, id string) bool {
	m.mu.Lock()
	p, ok := m.procs[procKey(dir, id)]
	m.mu.Unlock()
	if !ok {
		return false
	}
	p.stop()
	return true
}

// Restart stops then starts the process.
func (m *Manager) Restart(dir, id string) error {
	m.mu.Lock()
	p, ok := m.procs[procKey(dir, id)]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("procmgr: unknown process %s", id)
	}
	p.stop()
	return p.arm()
}

// Status returns a snapshot of one process, or ok=false if unknown.
func (m *Manager) Status(dir, id string) (ProcStatus, bool) {
	m.mu.Lock()
	p, ok := m.procs[procKey(dir, id)]
	m.mu.Unlock()
	if !ok {
		return ProcStatus{}, false
	}
	return p.snapshot(), true
}

// Statuses returns snapshots for all processes under dir (empty id = all in dir).
func (m *Manager) Statuses(dir string) []ProcStatus {
	m.mu.Lock()
	out := make([]ProcStatus, 0)
	for k, p := range m.procs {
		d, _, ok := strings.Cut(k, "\x00")
		if ok && d == dir {
			out = append(out, p.snapshot())
		}
	}
	m.mu.Unlock()
	return out
}

// Logs returns up to the last max bytes of the merged stdout/stderr ring. A
// non-positive max returns the whole ring.
func (m *Manager) Logs(dir, id string, max int) ([]byte, bool) {
	m.mu.Lock()
	p, ok := m.procs[procKey(dir, id)]
	m.mu.Unlock()
	if !ok {
		return nil, false
	}
	return p.logs.Tail(max), true
}

// StopAll gracefully stops every managed process (daemon teardown). Best-effort
// and bounded; it does not return until each supervisor loop has exited.
func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*Proc, 0, len(m.procs))
	for _, p := range m.procs {
		all = append(all, p)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range all {
		wg.Add(1)
		go func(p *Proc) { defer wg.Done(); p.stop() }(p)
	}
	wg.Wait()
}

// --- Proc -------------------------------------------------------------------

type Proc struct {
	base  context.Context
	armMu sync.Mutex // serializes arm() so two callers can't spawn two supervisor loops
	mu    sync.Mutex
	spec  ProcSpec
	logs  *ringlog.Ring
	stopF bool // user-requested stop; suppress restart

	ctx     context.Context
	cancel  context.CancelFunc
	runDone chan struct{} // closed when the supervisor loop has exited

	// runtime (guarded by mu)
	status       Status
	pid          int
	startedAt    time.Time
	readyAt      time.Time
	exitCode     int
	restartCount int // cumulative restarts, monotonic (display)
	failCount    int // consecutive failures since last sustained-ready (backoff + give-up)
}

func newProc(base context.Context, spec ProcSpec) *Proc {
	return &Proc{base: base, spec: spec, logs: ringlog.New(logCap), status: StatusStopped}
}

// arm (re)starts the supervisor loop for this proc. armMu serializes the whole
// arm decision so two concurrent callers (e.g. a config-reload Start racing a
// Restart) can't both pass the IsRunning() check and spawn two supervisor loops
// for one Proc (which would double the child + leak a goroutine).
func (p *Proc) arm() error {
	p.armMu.Lock()
	defer p.armMu.Unlock()

	p.mu.Lock()
	if p.status.IsRunning() {
		p.mu.Unlock()
		return nil // already live
	}
	prevCancel := p.cancel
	prevDone := p.runDone
	p.mu.Unlock()

	// A previous supervisor loop may still be alive but not "running" — parked in
	// backoff after a failed/timed-out attempt (status failed/stopped, ctx NOT
	// cancelled). Cancel it FIRST, then wait for it to exit, before re-arming.
	// Without the cancel, under restart:always that loop would wake from backoff
	// and relaunch, so its runDone would never close and this arm() (holding
	// armMu) would block forever — wedging every later Start/Restart. (stop()
	// uses the same cancel-then-drain.)
	if prevCancel != nil {
		prevCancel()
	}
	if prevDone != nil {
		<-prevDone
	}

	ctx, cancel := context.WithCancel(p.base)
	p.mu.Lock()
	p.ctx = ctx
	p.cancel = cancel
	p.stopF = false
	p.status = StatusStarting
	p.runDone = make(chan struct{})
	runDone := p.runDone
	p.mu.Unlock()
	go func() {
		defer close(runDone)
		p.run(ctx)
	}()
	return nil
}

func (p *Proc) stop() {
	// Hold armMu so stop can't interleave a concurrent arm() — otherwise stop
	// could cancel/drain the OLD generation while arm installs a NEW (uncancelled)
	// ctx, leaving a child running after the user asked to stop it.
	p.armMu.Lock()
	defer p.armMu.Unlock()
	p.mu.Lock()
	p.stopF = true
	cancel := p.cancel
	done := p.runDone
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	p.mu.Lock()
	p.status = StatusStopped
	p.pid = 0
	p.mu.Unlock()
}

// run is the supervisor loop: launch → await readiness → health-watch → on exit
// apply restart policy with backoff. Returns when ctx is cancelled (stop/exit)
// or the restart policy is exhausted.
func (p *Proc) run(ctx context.Context) {
	for ctx.Err() == nil {
		// Clear readyAt for THIS attempt: scheduleRestart's streak-reset keys off
		// "did this run stay ready a while", so a spawn failure (which never
		// reaches launch's own reset) must not inherit a prior generation's
		// readyAt and wrongly reset the failure streak.
		p.mu.Lock()
		p.readyAt = time.Time{}
		id := p.spec.ID // captured under lock; Start may refresh p.spec concurrently
		p.mu.Unlock()
		cmd, waitCh, err := p.launch(ctx)
		if err != nil {
			vhlog.Error("procmgr spawn failed", "id", id, "err", err)
			p.set(StatusFailed)
			if !p.shouldRestartExec() {
				return
			}
			if !p.scheduleRestart(ctx) {
				return
			}
			continue
		}
		reason := p.awaitReady(ctx, waitCh)
		switch reason {
		case readyCancelled:
			p.killCmd(cmd, waitCh)
			<-waitCh
			return
		case readyExited:
			// The process ended during startup — handle as a normal exit, NOT a
			// startup failure (a clean exit 0 with restart:No → stopped).
			<-waitCh
			if ctx.Err() != nil {
				return
			}
			p.mu.Lock()
			stopping := p.stopF
			code := p.exitCode
			p.mu.Unlock()
			if stopping {
				p.set(StatusStopped)
				return
			}
			if !p.shouldRestartExit(code) {
				if code == 0 {
					p.set(StatusStopped)
				} else {
					p.set(StatusFailed)
					vhlog.Warn("procmgr process exited during startup", "id", id, "exit", code)
				}
				return
			}
			if !p.scheduleRestart(ctx) {
				return
			}
			continue
		case readyTimeout:
			p.killCmd(cmd, waitCh)
			<-waitCh
			code := p.cmdExitCode()
			p.set(StatusFailed)
			vhlog.Warn("procmgr process not ready in time", "id", id, "exit", code)
			if !p.shouldRestartExit(code) && !p.shouldRestartExec() {
				return
			}
			if !p.scheduleRestart(ctx) {
				return
			}
			continue
		case readyYes:
			// fall through to health-watch below
		}
		p.mu.Lock()
		p.status = StatusReady
		p.readyAt = time.Now()
		onReady := p.spec.OnReady
		p.mu.Unlock()
		if onReady != nil {
			go onReady() // register dependent views now that the process is up
		}
		// Health-watch until exit or stop.
		p.healthLoop(ctx, waitCh)
		p.killCmd(cmd, waitCh)
		<-waitCh
		if ctx.Err() != nil {
			return
		}
		p.mu.Lock()
		stopping := p.stopF
		code := p.exitCode
		p.mu.Unlock()
		if stopping {
			p.set(StatusStopped)
			return
		}
		if !p.shouldRestartExit(code) {
			if code == 0 {
				p.set(StatusStopped)
			} else {
				p.set(StatusFailed)
			}
			return
		}
		if !p.scheduleRestart(ctx) {
			return
		}
	}
}

// launch spawns the process and a goroutine that reaps it into waitCh + exitCode.
func (p *Proc) launch(ctx context.Context) (*exec.Cmd, chan struct{}, error) {
	spec := p.snapshotSpec()
	cmd := exec.CommandContext(ctx, spec.Argv[0], spec.Argv[1:]...)
	cmd.Dir = spec.Cwd
	cmd.Env = mergedEnv(spec.Env)
	// Put the child in its own process group so a stop can kill the WHOLE group
	// (e.g. `sh -c 'sleep 30'` otherwise orphans sleep holding the stdout pipe,
	// deadlocking cmd.Wait). On unix this makes cmd.Process.Pid the group id; on
	// Windows it is a no-op (see procmgr_{unix,windows}.go).
	setProcGroup(cmd)
	// On ctx cancel (stop/teardown) signal the whole group; WaitDelay bounds how
	// long Wait blocks on the I/O copy goroutines afterwards (belt-and-braces).
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return killGroup(cmd.Process.Pid, syscall.SIGTERM)
	}
	cmd.WaitDelay = 4 * time.Second
	// Merge stdout+stderr into the log ring via a shared writer. exec spins up
	// the copy goroutines and closes them when the process exits.
	w := p.logs.Writer()
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	waitCh := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		p.mu.Lock()
		p.exitCode = p.exitCodeOf(cmd)
		if p.pid == cmd.Process.Pid {
			p.pid = 0
		}
		p.mu.Unlock()
		close(waitCh)
	}()
	p.mu.Lock()
	p.status = StatusStarting
	p.pid = cmd.Process.Pid
	p.startedAt = time.Now()
	p.exitCode = 0
	p.mu.Unlock()
	vhlog.Info("procmgr started", "id", spec.ID, "pid", cmd.Process.Pid, "dir", spec.Dir)
	return cmd, waitCh, nil
}

// readyReason explains why awaitReady returned.
type readyReason int

const (
	readyYes       readyReason = iota // readiness reached
	readyExited                       // the process ended during startup
	readyTimeout                      // alive past the startup deadline without readiness
	readyCancelled                    // ctx cancelled
)

// awaitReady polls the readiness probe (or the default settle) up to
// startupTimeout. It distinguishes three non-ready outcomes so the caller can
// apply the right policy: a process that EXITED during startup is handled as an
// exit (clean exit 0 → stopped), while a TIMEOUT (alive but never ready) is a
// startup failure.
func (p *Proc) awaitReady(ctx context.Context, waitCh chan struct{}) readyReason {
	spec := p.snapshotSpec()
	deadline := time.Now().Add(startupTimeout)
	probe := newProbe(spec.Readiness, p.logs)
	// Default settle path when there is no probe.
	if probe == nil {
		timer := time.NewTimer(defaultSettle)
		defer timer.Stop()
		select {
		case <-timer.C:
			if p.alive() {
				return readyYes
			}
			return readyExited
		case <-waitCh:
			return readyExited
		case <-ctx.Done():
			return readyCancelled
		}
	}
	// Check immediately so a fast unix/http upstream isn't delayed a whole tick.
	if probe.check(ctx) {
		return readyYes
	}
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if probe.check(ctx) {
				return readyYes
			}
			if time.Now().After(deadline) {
				return readyTimeout
			}
		case <-waitCh:
			return readyExited
		case <-ctx.Done():
			return readyCancelled
		}
	}
}

// healthLoop watches a ready process: probes periodically; on sustained failure
// kills it (which closes waitCh → restart per policy). Exits when waitCh closes
// or ctx is cancelled.
func (p *Proc) healthLoop(ctx context.Context, waitCh chan struct{}) {
	spec := p.snapshotSpec()
	probe := newProbe(spec.Readiness, p.logs)
	if probe == nil || probe.oneShot {
		// No recurring probe (none declared, or a one-shot log-readiness signal) →
		// just watch for exit.
		select {
		case <-waitCh:
		case <-ctx.Done():
		}
		return
	}
	fails := 0
	t := time.NewTicker(healthInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if probe.check(ctx) {
				if fails > 0 {
					p.set(StatusReady)
				}
				fails = 0
			} else {
				fails++
				if fails >= healthFailThreshold {
					vhlog.Warn("procmgr health probe failed, restarting", "id", spec.ID)
					p.set(StatusUnhealthy)
					return // caller kills cmd → exit → restart policy
				}
				p.set(StatusUnhealthy)
			}
		case <-waitCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

// --- policies ---

func (p *Proc) shouldRestartExit(code int) bool {
	p.mu.Lock()
	policy := p.spec.Restart
	stopping := p.stopF
	p.mu.Unlock()
	if stopping {
		return false
	}
	switch policy {
	case projectcfg.RestartAlways:
		return true
	case projectcfg.RestartOnFailure, "":
		return code != 0
	default:
		return false
	}
}

// shouldRestartExec covers an exec.Start failure (before any exit code).
func (p *Proc) shouldRestartExec() bool {
	p.mu.Lock()
	policy := p.spec.Restart
	stopping := p.stopF
	p.mu.Unlock()
	if stopping {
		return false
	}
	return policy == projectcfg.RestartAlways || policy == projectcfg.RestartOnFailure || policy == ""
}

// scheduleRestart records a restart attempt, applies the give-up policy, and
// waits the backoff. Returns false if the supervisor should stop (gave up, or
// ctx cancelled during the wait). The failure streak — which drives both backoff
// and give-up — resets only after the process stayed ready for healthyResetAfter,
// so a fast crash-after-ready keeps backing off while a long-healthy run that
// later dies restarts promptly.
func (p *Proc) scheduleRestart(ctx context.Context) bool {
	p.mu.Lock()
	if !p.readyAt.IsZero() && time.Since(p.readyAt) >= healthyResetAfter {
		p.failCount = 0
	}
	p.failCount++
	p.restartCount++
	n := p.failCount
	always := p.spec.Restart == projectcfg.RestartAlways
	id := p.spec.ID
	p.mu.Unlock()

	if !always && n > maxConsecutiveFailures {
		p.set(StatusFailed)
		vhlog.Warn("procmgr giving up after repeated failures", "id", id, "failures", n-1)
		return false
	}
	return p.sleep(ctx, backoffFor(n-1))
}

// backoffFor returns the exponential backoff for the n-th consecutive failure
// (n=0 → backoffBase), capped at maxBackoff and guarded against shift overflow.
func backoffFor(n int) time.Duration {
	if n < 0 {
		n = 0
	}
	if n >= 30 {
		return maxBackoff
	}
	d := backoffBase << uint(n)
	if d <= 0 || d > maxBackoff {
		return maxBackoff
	}
	return d
}

func (p *Proc) sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// --- helpers ---

func (p *Proc) set(s Status) {
	p.mu.Lock()
	p.status = s
	p.mu.Unlock()
}

func (p *Proc) snapshotSpec() ProcSpec {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.spec
}

// alive reports whether the process is currently running (pid set; the reaper
// zeroes it on exit). Takes p.mu — do not call while holding it.
func (p *Proc) alive() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pid != 0
}

// killCmd SIGTERMs the whole process group, then escalates to SIGKILL after a
// grace period UNLESS the process reaps first (done closed). Waiting on done
// both bounds the escalation goroutine to the process lifetime (no leak / no
// pile-up under frequent restarts) and avoids SIGKILLing a recycled pid group
// after the child already exited. Killing the group is essential so a
// shell-launched grandchild (e.g. `sh -c 'sleep 30'`) dies too — otherwise it
// keeps the stdout pipe open and cmd.Wait deadlocks.
func (p *Proc) killCmd(cmd *exec.Cmd, done <-chan struct{}) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	_ = killGroup(pid, syscall.SIGTERM)
	go func() {
		t := time.NewTimer(3 * time.Second)
		defer t.Stop()
		select {
		case <-done: // reaped after SIGTERM — don't SIGKILL a possibly-recycled pid
		case <-t.C:
			_ = killGroup(pid, syscall.SIGKILL)
		}
	}()
}

func (p *Proc) cmdExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCode
}

func (p *Proc) exitCodeOf(cmd *exec.Cmd) int {
	if cmd.ProcessState == nil {
		return -1
	}
	return cmd.ProcessState.ExitCode()
}

// ProcStatus is the JSON-friendly snapshot of one process.
type ProcStatus struct {
	Dir       string    `json:"dir"`
	ID        string    `json:"id"`
	Status    Status    `json:"status"`
	PID       int       `json:"pid"`
	Command   string    `json:"command"` // display form (joined argv)
	Restart   string    `json:"restart"`
	StartedAt time.Time `json:"started_at,omitempty"`
	ReadyAt   time.Time `json:"ready_at,omitempty"`
	ExitCode  int       `json:"exit_code"` // not omitempty: a clean exit 0 must be distinguishable
	Restarts  int       `json:"restarts"`
}

func (p *Proc) snapshot() ProcStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	cmd := strings.Join(p.spec.Argv, " ")
	return ProcStatus{
		Dir:       p.spec.Dir,
		ID:        p.spec.ID,
		Status:    p.status,
		PID:       p.pid,
		Command:   cmd,
		Restart:   p.spec.Restart,
		StartedAt: p.startedAt,
		ReadyAt:   p.readyAt,
		ExitCode:  p.exitCode,
		Restarts:  p.restartCount,
	}
}

// --- environment merge ---

func mergedEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return os.Environ()
	}
	keys := map[string]string{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		keys[k] = kv
	}
	for k, v := range extra {
		keys[k] = k + "=" + v
	}
	out := make([]string, 0, len(keys))
	for _, v := range keys {
		out = append(out, v)
	}
	return out
}

// --- readiness probe ---

type probe struct {
	check   func(context.Context) bool
	oneShot bool // true for log-readiness: a startup-only signal, not a recurring health check
}

func newProbe(r *projectcfg.Readiness, logs *ringlog.Ring) *probe {
	if r == nil {
		return nil
	}
	switch {
	case r.Unix != "":
		sock := r.Unix
		return &probe{check: func(ctx context.Context) bool {
			return dialUnix(ctx, sock)
		}}
	case r.HTTP != "":
		url := r.HTTP
		return &probe{check: func(ctx context.Context) bool {
			return probeHTTP(ctx, url)
		}}
	case r.Log != "":
		re, err := regexp.Compile(r.Log)
		if err != nil {
			vhlog.Error("procmgr bad readiness.log regex", "re", r.Log, "err", err)
			return nil // fall back to settle
		}
		// A log match is a one-shot STARTUP signal: the matched line eventually
		// scrolls out of the bounded log ring, so re-running it as a recurring
		// health check would flap a healthy process to "unhealthy". Mark it
		// oneShot so healthLoop only watches for exit (no re-probing).
		return &probe{oneShot: true, check: func(ctx context.Context) bool {
			return re.Match(logs.Snapshot())
		}}
	}
	return nil
}

func dialUnix(ctx context.Context, sock string) bool {
	d := net.Dialer{}
	c, err := d.DialContext(ctx, "unix", sock)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func probeHTTP(ctx context.Context, url string) bool {
	cl := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := cl.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
