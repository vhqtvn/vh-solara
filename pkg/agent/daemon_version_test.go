package agent

// Worker-side coverage for the fail-safe controller/worker version boundary
// (see pkg/version): the worker refuses a controller that doesn't advertise a
// sufficient X-VH-Controller-Version on the dial response and retries
// (reconnect loop), connects to one that does, and surfaces a real
// controller's HTTP refusal (426 + reason body) in its log.

import (
	"bytes"
	"context"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
	"github.com/vhqtvn/vh-solara/pkg/version"
)

// startDaemonAt boots a worker Daemon pointed at controllerURL and returns it
// with a stop func that cancels the loop AND blocks until the goroutine has
// fully exited (same shape as startFailingDaemon in daemon_rawproxy_test.go).
func startDaemonAt(t *testing.T, controllerURL, workerVersion string) (d *Daemon, stop func()) {
	t.Helper()
	d = NewDaemon(controllerURL, "worker-ver-test", "test-worker", workerVersion, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	d.ctx = ctx
	d.cancel = cancel
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.Start()
	}()
	return d, func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("daemon did not stop within 10s")
		}
	}
}

// lockedBuffer is a concurrency-safe log sink. log.Logger serializes its own
// Output calls, but the test polls String() concurrently with them, so the
// buffer itself must be guarded (race-detector-clean).
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLog swaps the standard logger for a buffer (the log seam the agent
// daemon writes its refusals to) and restores it on cleanup.
func captureLog(t *testing.T) *lockedBuffer {
	t.Helper()
	var buf lockedBuffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

// fakeController upgrades the worker dial like a controller, optionally
// advertising a controller version (advertise "" = header absent = a
// pre-boundary controller). For adequate versions it also runs the minimal
// yamux server sequence (accept + read the Register) so the worker reaches
// its steady state; the register message is captured on the channel. cleanup
// tears the server down AND waits for the yamux session(s) to fully drain,
// so no sendLoop goroutine of THIS test outlives its scope.
func fakeController(t *testing.T, advertise string, registers chan<- tunnel.RegisterMessage) (url string, cleanup func()) {
	t.Helper()
	done := make(chan struct{})
	up := websocket.Upgrader{}
	sessions := make(chan *tunnel.MuxTransport, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The version header must ride Upgrade's responseHeader argument:
		// gorilla hijacks and writes the 101 itself, so w.Header().Set
		// before Upgrade never reaches the wire (same note as the real
		// handleWorkerWS).
		respHdr := http.Header{}
		if advertise != "" {
			respHdr.Set(version.HeaderControllerVersion, advertise)
		}
		conn, err := up.Upgrade(w, r, respHdr)
		if err != nil {
			return
		}
		if registers == nil {
			// Refusal cases: the worker closes right after the version
			// check; drain until then.
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}
		mux, err := tunnel.NewMuxTransportServer(conn)
		if err != nil {
			return
		}
		sessions <- mux
		defer mux.Close()
		stream, err := mux.AcceptStream()
		if err != nil {
			return
		}
		var reg tunnel.RegisterMessage
		if err := stream.ReadJSON(&reg); err == nil && registers != nil {
			select {
			case registers <- reg:
			case <-done:
			}
		}
		stream.Close()
		<-done // hold the session until cleanup
	}))
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/vh-solara/ws"
	return wsURL, func() {
		close(done)
		srv.Close() // waits for handlers (each defers mux.Close)
		// Wait for the yamux sessions' sendLoops to fully exit so the next
		// test's diag interactions can't race them.
		for {
			select {
			case m := <-sessions:
				select {
				case <-m.Session.CloseChan():
				case <-time.After(2 * time.Second):
					return
				}
			default:
				return
			}
		}
	}
}

// waitFor polls until cond() holds or the deadline expires.
func waitFor(t *testing.T, what string, deadline time.Duration, cond func() bool) {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s within %v", what, deadline)
}

// TestWorkerRefusesSilentController proves the worker-side floor: a dial that
// succeeds but whose response carries NO X-VH-Controller-Version (a
// pre-boundary controller) is refused — the tunnel is closed and the
// reconnect loop retries (dial attempts climb past the refusal, the failure
// counter increments, no connection is ever counted).
func TestWorkerRefusesSilentController(t *testing.T) {
	attempts, failures, connected := tunnelCounters()
	url, cleanup := fakeController(t, "", nil) // header absent
	defer cleanup()
	_, stop := startDaemonAt(t, url, "test-build")
	defer stop()

	waitFor(t, "retry attempts against silent controller", 6*time.Second, func() bool {
		return diag.Default.Tunnel.DialAttempts.Load() >= attempts+2
	})
	if got := diag.Default.Tunnel.DialFailures.Load(); got < failures+1 {
		t.Fatalf("DialFailures = %d, want >= %d (refusal must count as a dial failure)", got, failures+1)
	}
	if got := diag.Default.Tunnel.Connected.Load(); got != connected {
		t.Fatalf("Connected = %d, want unchanged at %d (silent controller must never become a tunnel)", got, connected)
	}
}

// TestWorkerRefusesBelowFloorController: same, but the controller advertises
// a parseable version below the worker's floor ("0.1.0").
func TestWorkerRefusesBelowFloorController(t *testing.T) {
	attempts, _, connected := tunnelCounters()
	url, cleanup := fakeController(t, "0.1.0", nil)
	defer cleanup()
	buf := captureLog(t)
	_, stop := startDaemonAt(t, url, "test-build")
	defer stop()

	waitFor(t, "retry attempts against below-floor controller", 6*time.Second, func() bool {
		return diag.Default.Tunnel.DialAttempts.Load() >= attempts+2
	})
	if got := diag.Default.Tunnel.Connected.Load(); got != connected {
		t.Fatalf("Connected = %d, want unchanged at %d (below-floor controller must never become a tunnel)", got, connected)
	}
	if s := buf.String(); !strings.Contains(s, "0.1.0") || !strings.Contains(s, version.MinControllerVersion) {
		t.Errorf("refusal log must name the controller version and the floor %q, got:\n%s",
			version.MinControllerVersion, s)
	}
}

// TestWorkerAllowsDevShapedController pins the fail-open posture from the
// worker side: a non-clean-semver advertised version ("dev") is allowed.
func TestWorkerAllowsDevShapedController(t *testing.T) {
	_, _, connected := tunnelCounters()
	regCh := make(chan tunnel.RegisterMessage, 1)
	url, shutdownFake := fakeController(t, "dev", regCh)
	_, stop := startDaemonAt(t, url, "test-build")
	// Kill the fake controller BEFORE stopping the worker: the worker sits
	// blocked in AcceptStream on the live tunnel and only exits once the
	// tunnel dies (cancel alone doesn't interrupt it).
	defer func() {
		shutdownFake()
		stop()
	}()

	waitFor(t, "connection to dev controller", 6*time.Second, func() bool {
		return diag.Default.Tunnel.Connected.Load() > connected
	})
}

// TestWorkerConnectsToAdequateController: a controller advertising the floor
// version connects, and the RegisterMessage on the wire carries the worker
// Daemon's Version (the plumbing the dashboard's true worker versions rely
// on).
func TestWorkerConnectsToAdequateController(t *testing.T) {
	regCh := make(chan tunnel.RegisterMessage, 1)
	url, shutdownFake := fakeController(t, version.MinControllerVersion, regCh)
	const workerVer = "9.9.9-e2e" // clean-parseable, distinct
	_, stop := startDaemonAt(t, url, workerVer)
	defer func() {
		shutdownFake() // tunnel down first (see note above)
		stop()
	}()

	var reg tunnel.RegisterMessage
	waitFor(t, "registration against adequate controller", 6*time.Second, func() bool {
		select {
		case reg = <-regCh:
			return true
		default:
			return false
		}
	})
	if reg.Version != workerVer {
		t.Errorf("RegisterMessage.Version = %q, want %q (true version must ride the wire)", reg.Version, workerVer)
	}
	if reg.WorkerID != "worker-ver-test" {
		t.Errorf("RegisterMessage.WorkerID = %q, want worker-ver-test", reg.WorkerID)
	}
	if reg.Type != tunnel.TypeRegister {
		t.Errorf("RegisterMessage.Type = %q, want %q", reg.Type, tunnel.TypeRegister)
	}
}

// TestWorkerSurfacesControllerRefusal is the full-path proof of the
// controller-refuses direction at lane 1: a REAL controller Daemon (with the
// real version guard) refuses a below-floor worker ("0.1.0") with 426 + a
// reason body, and the worker surfaces the status and body snippet in its log
// while the reconnect loop retries.
func TestWorkerSurfacesControllerRefusal(t *testing.T) {
	_, _, connected := tunnelCounters()

	// Real controller on a free loopback port (same boot shape as the e2e
	// harness / startS1Daemon, owned by this test).
	userAddr, err := freeAddrAgent()
	if err != nil {
		t.Fatalf("freeAddr: %v", err)
	}
	daemonAddr, err := freeAddrAgent()
	if err != nil {
		t.Fatalf("freeAddr: %v", err)
	}
	ctrl := server.NewDaemon(userAddr, daemonAddr, "")
	go func() { _ = ctrl.Start() }()
	t.Cleanup(func() {
		// Daemon.Start has no stop hook (same as the e2e harness); it dies
		// with the process. Nothing to close here.
	})
	// Wait for the registration listener to actually bind, so the first
	// worker dial reaches the version guard instead of "connection refused".
	waitFor(t, "controller to listen", 5*time.Second, func() bool {
		c, err := net.DialTimeout("tcp", daemonAddr, 200*time.Millisecond)
		if err != nil {
			return false
		}
		c.Close()
		return true
	})

	buf := captureLog(t)
	_, stop := startDaemonAt(t, "ws://"+daemonAddr+"/vh-solara/ws", "0.1.0") // clean, below floor
	defer stop()

	// The evidence is the surfaced refusal itself, not the attempt counter
	// (DialAttempts increments BEFORE the dial completes — waiting on it
	// would race the response).
	waitFor(t, "controller 426 refusal surfaced in worker log", 8*time.Second, func() bool {
		return strings.Contains(buf.String(), "426")
	})
	logs := buf.String()
	if got := diag.Default.Tunnel.DialAttempts.Load(); got < 1 {
		t.Fatalf("DialAttempts = %d, want >= 1", got)
	}
	if got := diag.Default.Tunnel.Connected.Load(); got != connected {
		t.Fatalf("Connected = %d, want unchanged at %d (below-floor worker must never connect)", got, connected)
	}
	if !strings.Contains(logs, version.MinWorkerVersion) {
		t.Errorf("worker log must surface the controller's reason body naming floor %s, got:\n%s",
			version.MinWorkerVersion, logs)
	}
	if !strings.Contains(logs, "controller said") {
		t.Errorf("worker log must surface the controller's reason body snippet, got:\n%s", logs)
	}
}

// tunnelCounters snapshots the tunnel diag counters as a baseline. These
// tests assert DELTAS instead of calling diag.ResetForTest: the reset swaps
// the registry slots, which races any yamux sendLoop goroutine still draining
// from a previous test's tunnel (the race detector flags it).
func tunnelCounters() (attempts, failures, connected uint64) {
	return diag.Default.Tunnel.DialAttempts.Load(),
		diag.Default.Tunnel.DialFailures.Load(),
		diag.Default.Tunnel.Connected.Load()
}

// freeAddrAgent mirrors the e2e harness's freeAddr (an OS-assigned free
// loopback host:port) without importing the e2e package.
func freeAddrAgent() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	return l.Addr().String(), nil
}
