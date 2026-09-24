package tunnel

// Q4c experiment tests: negotiated permessage-deflate on the tunnel
// WebSocket carrier.
//
// Coverage (per the open-questions brief Q4(c)):
//   - policy parsing / per-message decision boundaries (exact ≥1KiB/≥4KiB)
//   - negotiation matrix: all four endpoint on/off combinations over a REAL
//     TCP socket with wire-byte counters — proving (a) compression only
//     activates when BOTH sides offer (old↔new rolling deploy stays
//     uncompressed), (b) a negotiated link actually shrinks on the wire, and
//     (c) every combination round-trips payload bytes intact.
//   - payload classes: raw JSON, part.append-style suffix fragments, gzip64
//     snapshot envelopes, incompressible base64 bulk (the fixture bulk
//     class), and small frames.
//   - threshold policies discriminating on the WIRE (1k compresses a 2KiB
//     message, 4k passes it through).
//   - concurrent stream traffic and direct wsRWC write hammering (run under
//     -race: EnableWriteCompression must be strictly ordered before
//     WriteMessage under the adapter write mutex).

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"io"
	"math/rand"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// ---------------------------------------------------------------- policy ---

func TestDeflatePolicyParse(t *testing.T) {
	cases := []struct {
		in      string
		want    DeflatePolicy
		wantErr bool
	}{
		{"", DeflateOff, false},
		{"off", DeflateOff, false},
		{"OFF", DeflateOff, false},
		{" Off ", DeflateOff, false},
		{"all", DeflateAll, false},
		{"ALL", DeflateAll, false},
		{"1k", Deflate1KiB, false},
		{"4k", Deflate4KiB, false},
		{"1K", Deflate1KiB, false},
		{"bogus", DeflateOff, true},
		{"2k", DeflateOff, true},
		{"0", DeflateOff, true},
	}
	for _, c := range cases {
		got, err := ParseDeflatePolicy(c.in)
		if (err != nil) != c.wantErr {
			t.Errorf("ParseDeflatePolicy(%q) err=%v wantErr=%v", c.in, err, c.wantErr)
			continue
		}
		if got != c.want {
			t.Errorf("ParseDeflatePolicy(%q)=%v want %v", c.in, got, c.want)
		}
	}
}

func TestDeflatePolicyFromEnv(t *testing.T) {
	t.Setenv(EnvTunnelDeflate, "all")
	if p, err := DeflatePolicyFromEnv(); p != DeflateAll || err != nil {
		t.Fatalf("env all: got %v err=%v", p, err)
	}
	t.Setenv(EnvTunnelDeflate, "")
	if p, err := DeflatePolicyFromEnv(); p != DeflateOff || err != nil {
		t.Fatalf("env empty: got %v err=%v", p, err)
	}
	t.Setenv(EnvTunnelDeflate, "nope")
	p, err := DeflatePolicyFromEnv()
	if p != DeflateOff || err == nil {
		t.Fatalf("env invalid: got %v err=%v want off+error", p, err)
	}
}

func TestDeflatePolicyCompressMessageBoundaries(t *testing.T) {
	cases := []struct {
		policy DeflatePolicy
		off    bool // OfferCompression
		// compress[ size ] expectations at the exact boundaries (inclusive >=)
		at0, at1023, at1024, at1025, at4095, at4096, at4097, at65536 bool
	}{
		{DeflateOff, false, false, false, false, false, false, false, false, false},
		{DeflateAll, true, true, true, true, true, true, true, true, true},
		{Deflate1KiB, true, false, false, true, true, true, true, true, true},
		{Deflate4KiB, true, false, false, false, false, false, true, true, true},
	}
	sizes := []int{0, 1023, 1024, 1025, 4095, 4096, 4097, 65536}
	for _, c := range cases {
		if got := c.policy.OfferCompression(); got != c.off {
			t.Errorf("%v.OfferCompression()=%v want %v", c.policy, got, c.off)
		}
		want := map[int]bool{0: c.at0, 1023: c.at1023, 1024: c.at1024, 1025: c.at1025,
			4095: c.at4095, 4096: c.at4096, 4097: c.at4097, 65536: c.at65536}
		for _, n := range sizes {
			if got := c.policy.CompressMessage(n); got != want[n] {
				t.Errorf("%v.CompressMessage(%d)=%v want %v", c.policy, n, got, want[n])
			}
		}
	}
}

// -------------------------------------------------- wire-count test infra ---

// countingConn wraps a TCP conn and atomically counts the bytes crossing the
// wire in each direction — TRUE wire bytes, including the HTTP handshake and
// WS framing, so negotiated compression shows up as a real delta.
type countingConn struct {
	net.Conn
	rx atomic.Int64
	tx atomic.Int64
}

func (c *countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.rx.Add(int64(n))
	return n, err
}

func (c *countingConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	c.tx.Add(int64(n))
	return n, err
}

type countListener struct {
	net.Listener
	mu    sync.Mutex
	conns []*countingConn
}

func newCountListener(ln net.Listener) *countListener { return &countListener{Listener: ln} }

func (l *countListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	cc := &countingConn{Conn: c}
	l.mu.Lock()
	l.conns = append(l.conns, cc)
	l.mu.Unlock()
	return cc, nil
}

// totals returns (server-read, server-written) wire bytes across all
// accepted connections.
func (l *countListener) totals() (rx, tx int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.conns {
		rx += c.rx.Load()
		tx += c.tx.Load()
	}
	return rx, tx
}

// writeFrame / readFrame: a tiny length-prefixed protocol over a yamux
// stream so one stream can carry one payload request cleanly.
func writeFrame(w io.Writer, payload []byte) error {
	hdr := make([]byte, 4)
	binary.BigEndian.PutUint32(hdr, uint32(len(payload)))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	buf := make([]byte, binary.BigEndian.Uint32(hdr[:]))
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// deflatePair is a real worker↔controller tunnel pair over a counted TCP
// link: controller = yamux server echoing every stream payload, worker =
// yamux client opening streams.
type deflatePair struct {
	worker   *MuxTransport
	listener *countListener
	srv      *http.Server
	ln       net.Listener
	// negotiated holds the dial response's Sec-Websocket-Extensions header
	// ("" when no extension was negotiated).
	negotiated string
}

func startDeflatePair(t *testing.T, workerPolicy, ctrlPolicy DeflatePolicy) *deflatePair {
	t.Helper()

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cl := newCountListener(base)

	up := websocket.Upgrader{EnableCompression: ctrlPolicy.OfferCompression()}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		mt, err := NewMuxTransportServerWithDeflate(conn, ctrlPolicy)
		if err != nil {
			return
		}
		defer mt.Close()
		for {
			stream, err := mt.AcceptStream()
			if err != nil {
				return
			}
			stream.Raw().SetDeadline(time.Now().Add(20 * time.Second))
			payload, err := readFrame(stream.Raw())
			if err != nil {
				stream.Close()
				return
			}
			if err := writeFrame(stream.Raw(), payload); err != nil {
				stream.Close()
				return
			}
			stream.Close()
		}
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(cl)

	dial := websocket.Dialer{EnableCompression: workerPolicy.OfferCompression()}
	conn, resp, err := dial.Dial("ws://"+base.Addr().String()+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	worker, err := NewMuxTransportClientWithDeflate(conn, workerPolicy)
	if err != nil {
		t.Fatalf("mux client: %v", err)
	}

	p := &deflatePair{
		worker:     worker,
		listener:   cl,
		srv:        srv,
		ln:         base,
		negotiated: resp.Header.Get("Sec-Websocket-Extensions"),
	}
	t.Cleanup(func() { p.shutdown() })
	return p
}

func (p *deflatePair) shutdown() {
	p.worker.Close()
	time.Sleep(150 * time.Millisecond) // let in-flight TCP bytes land in the counters
	p.srv.Close()
	p.ln.Close()
}

// echoOnce opens a fresh stream, sends payload, and returns the echoed copy.
func (p *deflatePair) echoOnce(t *testing.T, payload []byte) []byte {
	t.Helper()
	stream, err := p.worker.OpenStream()
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer stream.Close()
	stream.Raw().SetDeadline(time.Now().Add(20 * time.Second))
	if err := writeFrame(stream.Raw(), payload); err != nil {
		t.Fatalf("write frame: %v", err)
	}
	got, err := readFrame(stream.Raw())
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return got
}

// wireDelta returns the (rx, tx) wire-byte delta across an echoOnce call.
// The echo having returned proves both directions crossed the wire.
func (p *deflatePair) wireDelta(t *testing.T, payload []byte) (rx, tx int64, got []byte) {
	t.Helper()
	// Measure between two quiet points. yamux sends window updates / FIN acks
	// asynchronously, so an unsettled sample attributed ~24 B frames to
	// whichever window they happened to land in (locally part-append-suffix
	// flipped between 185 and 209 B; CI saw small-frame-40b at 188 B).
	rx0, tx0 := p.settledTotals()
	got = p.echoOnce(t, payload)
	// Settle the end too: this echo's own stream shutdown (yamux FIN / window
	// update) can arrive just after echoOnce returns, so a plain sample
	// counted it on some runs and not others.
	rx1, tx1 := p.settledTotals()
	return rx1 - rx0, tx1 - tx0, got
}

// settledTotals returns the listener's byte totals once they have stopped
// changing for a quiet period (bounded, so a chatty link can't hang the test).
func (p *deflatePair) settledTotals() (rx, tx int64) {
	const quiet, maxWait = 50 * time.Millisecond, 2 * time.Second
	rx, tx = p.listener.totals()
	deadline := time.Now().Add(maxWait)
	stableSince := time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
		r, x := p.listener.totals()
		if r != rx || x != tx {
			rx, tx, stableSince = r, x, time.Now()
			continue
		}
		if time.Since(stableSince) >= quiet {
			break
		}
	}
	return rx, tx
}

// -------------------------------------------------------- payload classes ---

var deflateRandMu sync.Mutex                   // math/rand.Rand is not goroutine-safe
var deflateRand = rand.New(rand.NewSource(42)) // deterministic across runs

// compressibleJSON builds realistic repetitive part-ish JSON of EXACTLY n
// bytes (truncated mid-object if needed — these tests check byte transport,
// not JSON validity).
func compressibleJSON(n int) []byte {
	var b bytes.Buffer
	b.WriteByte('[')
	for i := 0; b.Len() < n; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"type":"part.append","sessionID":"mp0_s0","part":{"id":"mp0_s0_a1_p%d","type":"text","text":"assistant turn content streaming through the tunnel, iteration %d of a realistic repetitive payload","state":{}}}`, i, i)
	}
	b.WriteByte(']')
	return b.Bytes()[:n]
}

// partAppendSuffix mimics a small streaming part.append suffix fragment.
func partAppendSuffix(i int) []byte {
	return []byte(fmt.Sprintf(`{"type":"part.append","sessionID":"mp0_s0","part":{"id":"mp0_s0_a1_p%d","text":" token continuation %d"}}`, i, i))
}

// gzip64Snapshot mimics a z=1 snapshot envelope: gzip+base64 of a JSON
// snapshot. NOTE: deflate on top of this only recovers base64 envelope
// redundancy (~25% at best) — that is exactly what this class measures.
func gzip64Snapshot(raw int) []byte {
	inner := compressibleJSON(raw)
	var zb bytes.Buffer
	zw := gzip.NewWriter(&zb)
	zw.Write(inner)
	zw.Close()
	return []byte(`{"encoding":"gzip64","z":1,"data":"` + base64.StdEncoding.EncodeToString(zb.Bytes()) + `"}`)
}

// base64Bulk mimics the e2e bulk fixture class: base64 of pseudo-random
// bytes (incompressible content, but base64's 6-bit alphabet still yields
// ~20-25% deflate savings on the WIRE).
func base64Bulk(n int) []byte {
	raw := make([]byte, n*3/4)
	deflateRandMu.Lock()
	deflateRand.Read(raw)
	deflateRandMu.Unlock()
	return []byte(base64.StdEncoding.EncodeToString(raw))
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	deflateRandMu.Lock()
	defer deflateRandMu.Unlock()
	deflateRand.Read(b)
	return b
}

// ------------------------------------------------------------ wire tests ---

// TestTunnelDeflateNegotiationMatrix walks all four endpoint on/off
// combinations over a real socket with wire counters: compression activates
// only when BOTH sides offer it (the rolling-deploy guarantee), and when it
// does, the wire actually shrinks while payload integrity is preserved.
func TestTunnelDeflateNegotiationMatrix(t *testing.T) {
	payload := compressibleJSON(64 * 1024)
	for _, tc := range []struct {
		worker, ctrl DeflatePolicy
	}{
		{DeflateOff, DeflateOff},
		{DeflateAll, DeflateOff},
		{DeflateOff, DeflateAll},
		{DeflateAll, DeflateAll},
	} {
		name := fmt.Sprintf("worker=%s/ctrl=%s", tc.worker, tc.ctrl)
		t.Run(name, func(t *testing.T) {
			p := startDeflatePair(t, tc.worker, tc.ctrl)

			wantNegotiated := tc.worker.OfferCompression() && tc.ctrl.OfferCompression()
			if got := strings.Contains(p.negotiated, "permessage-deflate"); got != wantNegotiated {
				t.Fatalf("negotiated header=%q contains=%v want %v", p.negotiated, got, wantNegotiated)
			}

			rx, tx, got := p.wireDelta(t, payload)
			if !bytes.Equal(got, payload) {
				t.Fatalf("echo integrity broken: got %d bytes want %d", len(got), len(payload))
			}

			if wantNegotiated {
				// Worker→ctrl leg compressed under the worker policy, ctrl→worker
				// leg under the ctrl policy (both `all` here).
				if rx >= int64(len(payload)) {
					t.Errorf("worker→ctrl wire bytes %d ≥ payload %d — compression did not shrink the wire leg", rx, len(payload))
				}
				if tx >= int64(len(payload)) {
					t.Errorf("ctrl→worker wire bytes %d ≥ payload %d", tx, len(payload))
				}
			} else {
				// Uncompressed fallback: every byte of payload crosses plus
				// framing — the rolling-deploy (old↔new peer mix) behavior.
				if rx < int64(len(payload)) {
					t.Errorf("uncompressed worker→ctrl wire bytes %d < payload %d — expected full-size frames", rx, len(payload))
				}
			}
			t.Logf("%s: negotiated=%v payload=%d wireRx=%d wireTx=%d", name, wantNegotiated, len(payload), rx, tx)
		})
	}
}

// echoFramingAllowance bounds the fixed wire overhead of one tiny echo on the
// client→server direction: yamux SYN + data + FIN headers, their WS envelopes
// (with masking) and the per-message deflate block overhead. Measured between
// settled points it is a deterministic 124 B (a 40 B payload costs 164 B on the
// wire); the older +128 budget was calibrated on an unsettled sample that
// under-counted the stream shutdown, leaving 4 B of headroom. An actual
// "exploded" frame would cost hundreds of bytes more, so 160 keeps the intent.
const echoFramingAllowance = 160

// TestTunnelDeflatePayloadClasses runs each payload class from the brief
// through a negotiated all/all link and checks integrity + wire shrinkage
// per class.
func TestTunnelDeflatePayloadClasses(t *testing.T) {
	suffix := partAppendSuffix(7)
	gz := gzip64Snapshot(48 * 1024)
	bulk := base64Bulk(64 * 1024)
	classes := []struct {
		name    string
		payload []byte
		check   func(t *testing.T, rx, n int64)
	}{
		{"raw-json-64k", compressibleJSON(64 * 1024), func(t *testing.T, rx, n int64) {
			if rx >= n/2 {
				t.Errorf("raw JSON wire bytes %d ≥ half of %d — repetitive JSON must compress hard", rx, n)
			}
		}},
		{"part-append-suffix", suffix, func(t *testing.T, rx, n int64) {
			// Small frames carry fixed per-message framing (yamux SYN+FIN+data
			// headers, WS envelopes, masking) — the assertion is that deflate
			// doesn't EXPLODE a tiny message, not that it nets-positive saves.
			if rx > n+echoFramingAllowance {
				t.Errorf("suffix wire bytes %d > payload %d + %d framing — tiny compressed frame exploded", rx, n, echoFramingAllowance)
			}
		}},
		{"gzip64-snapshot", gz, func(t *testing.T, rx, n int64) {
			// Deflate composes on top of gzip64: expect modest envelope-only
			// savings, not a second compression pass.
			if rx >= n*9/10 {
				t.Errorf("gzip64 wire bytes %d ≥ 90%% of %d — expected ~base64-envelope savings", rx, n)
			}
			if rx < n/2 {
				t.Errorf("gzip64 wire bytes %d < half of %d — unexpectedly compressing raw gzip (double-compression gone wrong?)", rx, n)
			}
		}},
		{"incompressible-base64-bulk", bulk, func(t *testing.T, rx, n int64) {
			// Random content in base64: deflate recovers the 6-bit alphabet
			// redundancy only (~20-25%), bounded both ways.
			if rx >= n*95/100 {
				t.Errorf("base64 bulk wire bytes %d ≈ payload %d — expected envelope-level savings", rx, n)
			}
			if rx < n/2 {
				t.Errorf("base64 bulk wire bytes %d < half of %d — content is pseudo-random, savings must be bounded", rx, n)
			}
		}},
		{"small-frame-40b", randomBytes(40), func(t *testing.T, rx, n int64) {
			// Tiny random frame under `all`: compressed frame must not
			// EXPLODE (stored-block fallback keeps it near raw size); the
			// fixed per-message framing is covered by echoFramingAllowance.
			if rx > n+echoFramingAllowance {
				t.Errorf("40-byte frame wire bytes %d > %d + %d framing — compressed tiny random frame exploded", rx, n, echoFramingAllowance)
			}
		}},
	}

	p := startDeflatePair(t, DeflateAll, DeflateAll)
	if !strings.Contains(p.negotiated, "permessage-deflate") {
		t.Fatalf("all/all must negotiate: header=%q", p.negotiated)
	}
	for _, c := range classes {
		t.Run(c.name, func(t *testing.T) {
			rx, _, got := p.wireDelta(t, c.payload)
			if !bytes.Equal(got, c.payload) {
				t.Fatalf("integrity broken for %s", c.name)
			}
			t.Logf("%s: payload=%d wireRx=%d (%.1f%%)", c.name, len(c.payload), rx, 100*float64(rx)/float64(len(c.payload)))
			c.check(t, rx, int64(len(c.payload)))
		})
	}
}

// TestTunnelDeflateThresholdWire proves the 1k/4k policies discriminate on
// the WIRE: sub-threshold frames pass through uncompressed, super-threshold
// frames compress. Payload sizes are chosen clear of the +12 B yamux frame
// header so the stream payload's size class equals the WS message's.
func TestTunnelDeflateThresholdWire(t *testing.T) {
	below := compressibleJSON(900)  // yamux data frame = 912 B < 1024
	mid := compressibleJSON(2048)   // frame = 2060 B: ≥1k, <4k
	above := compressibleJSON(8192) // frame = 8204 B ≥ 4096

	t.Run("1k-passes-small", func(t *testing.T) {
		p := startDeflatePair(t, Deflate1KiB, Deflate1KiB)
		rx, _, got := p.wireDelta(t, below)
		if !bytes.Equal(got, below) {
			t.Fatal("integrity broken")
		}
		if rx < int64(len(below)) {
			t.Errorf("900 B sub-threshold frame wire bytes %d < payload %d — should pass through uncompressed", rx, len(below))
		}
	})
	t.Run("1k-compresses-2k", func(t *testing.T) {
		p := startDeflatePair(t, Deflate1KiB, Deflate1KiB)
		rx, _, got := p.wireDelta(t, mid)
		if !bytes.Equal(got, mid) {
			t.Fatal("integrity broken")
		}
		if rx >= int64(len(mid))/2 {
			t.Errorf("2 KiB super-threshold frame wire bytes %d — expected ≥2x shrinkage, got %.2fx", rx, float64(len(mid))/float64(rx))
		}
	})
	t.Run("4k-passes-2k", func(t *testing.T) {
		p := startDeflatePair(t, Deflate4KiB, Deflate4KiB)
		rx, _, got := p.wireDelta(t, mid)
		if !bytes.Equal(got, mid) {
			t.Fatal("integrity broken")
		}
		if rx < int64(len(mid)) {
			t.Errorf("2 KiB sub-4k frame wire bytes %d < payload %d — should pass through uncompressed", rx, len(mid))
		}
	})
	t.Run("4k-compresses-8k", func(t *testing.T) {
		p := startDeflatePair(t, Deflate4KiB, Deflate4KiB)
		rx, _, got := p.wireDelta(t, above)
		if !bytes.Equal(got, above) {
			t.Fatal("integrity broken")
		}
		if rx >= int64(len(above))/2 {
			t.Errorf("8 KiB super-threshold frame wire bytes %d — expected ≥2x shrinkage", rx)
		}
	})
	t.Run("1k-compresses-8k", func(t *testing.T) {
		p := startDeflatePair(t, Deflate1KiB, Deflate1KiB)
		rx, _, got := p.wireDelta(t, above)
		if !bytes.Equal(got, above) {
			t.Fatal("integrity broken")
		}
		if rx >= int64(len(above))/2 {
			t.Errorf("8 KiB frame under 1k policy wire bytes %d — expected ≥2x shrinkage", rx)
		}
	})
}

// TestTunnelDeflateConcurrentStreams hammers a negotiated link with
// concurrent stream round-trips of varying compressible sizes. Under -race
// this exercises EnableWriteCompression being strictly ordered before
// WriteMessage on the shared conn from many goroutines.
func TestTunnelDeflateConcurrentStreams(t *testing.T) {
	p := startDeflatePair(t, DeflateAll, DeflateAll)
	const writers = 8
	const perWriter = 16

	var wg sync.WaitGroup
	errCh := make(chan error, writers)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				payload := compressibleJSON(2*1024 + 97*w + 31*i)
				stream, err := p.worker.OpenStream()
				if err != nil {
					errCh <- fmt.Errorf("w%d open: %w", w, err)
					return
				}
				stream.Raw().SetDeadline(time.Now().Add(30 * time.Second))
				if err := writeFrame(stream.Raw(), payload); err != nil {
					errCh <- fmt.Errorf("w%d write: %w", w, err)
					stream.Close()
					return
				}
				got, err := readFrame(stream.Raw())
				stream.Close()
				if err != nil {
					errCh <- fmt.Errorf("w%d read: %w", w, err)
					return
				}
				if !bytes.Equal(got, payload) {
					errCh <- fmt.Errorf("w%d i%d integrity: got %d bytes want %d", w, i, len(got), len(payload))
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

// TestWSRWCConcurrentWriteDeflate drives the wsRWC adapter DIRECTLY with
// concurrent writers on a negotiated conn — the tightest -race surface for
// the per-message EnableWriteCompression call under the adapter write
// mutex. The peer drains everything and checks total bytes + checksum.
func TestWSRWCConcurrentWriteDeflate(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	up := websocket.Upgrader{EnableCompression: true}
	type drainResult struct {
		bytes   int64
		msgs    int64
		xorSum  uint64
		drainOK bool
	}
	drainCh := make(chan drainResult, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		conn, err := up.Upgrade(rw, req, nil)
		if err != nil {
			drainCh <- drainResult{}
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		var total, msgs int64
		var xor uint64
		for {
			mt, r, err := conn.NextReader()
			if err != nil {
				drainCh <- drainResult{bytes: total, msgs: msgs, xorSum: xor, drainOK: true}
				return
			}
			if mt != websocket.BinaryMessage {
				continue
			}
			// Per-message FNV, XOR-combined: order-independent, so the
			// sender can compute the identical combination over its own
			// payloads however the writers interleaved.
			mh := fnv.New64a()
			n, err := io.Copy(mh, r)
			if err != nil {
				drainCh <- drainResult{bytes: total, msgs: msgs, xorSum: xor, drainOK: true}
				return
			}
			total += n
			msgs++
			xor ^= mh.Sum64()
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	dial := websocket.Dialer{EnableCompression: true}
	conn, resp, err := dial.Dial("ws://"+ln.Addr().String()+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(resp.Header.Get("Sec-Websocket-Extensions"), "permessage-deflate") {
		t.Fatal("compression not negotiated")
	}
	w := newWSRWC(conn, diag.SideClient)
	w.deflate = DeflateAll

	const writers = 8
	const perWriter = 64
	var sentBytes, sentMsgs int64
	var sentXor uint64
	var mu sync.Mutex
	var wg sync.WaitGroup
	for g := 0; g < writers; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			var localXor uint64
			var localN, localM int64
			for i := 0; i < perWriter; i++ {
				var payload []byte
				if (g+i)%3 == 0 {
					payload = randomBytes(64 + 37*i) // small/incompressible mix
				} else {
					payload = compressibleJSON(1024 + 61*i)
				}
				if _, err := w.Write(payload); err != nil {
					t.Errorf("writer %d: %v", g, err)
					return
				}
				mh := fnv.New64a()
				mh.Write(payload)
				localN += int64(len(payload))
				localM++
				localXor ^= mh.Sum64()
			}
			mu.Lock()
			sentBytes += localN
			sentMsgs += localM
			sentXor ^= localXor
			mu.Unlock()
		}(g)
	}
	wg.Wait()
	w.Close()

	dr := <-drainCh
	if !dr.drainOK {
		t.Fatal("drain loop never completed")
	}
	if dr.bytes != sentBytes || dr.msgs != sentMsgs {
		t.Fatalf("drained %d bytes/%d msgs, sent %d bytes/%d msgs", dr.bytes, dr.msgs, sentBytes, sentMsgs)
	}
	if dr.xorSum != sentXor {
		t.Fatal("checksum mismatch — concurrent compressed writes corrupted/duplicated data")
	}
}
