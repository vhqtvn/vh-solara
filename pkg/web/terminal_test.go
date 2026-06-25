package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTerminalWSEcho(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no shell")
	}
	dir := t.TempDir()
	s := &Server{}
	srv := httptest.NewServer(http.HandlerFunc(s.handleTerminalWS))
	defer srv.Close()

	// No dir → 400 (the handler rejects before upgrading).
	res, err := http.Get(srv.URL)
	if err == nil {
		defer res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("want 400 without dir, got %d", res.StatusCode)
		}
	}

	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	u.RawQuery = "dir=" + url.QueryEscape(dir)
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	// Size the PTY, then run a command whose output we can recognize.
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"resize":{"cols":80,"rows":24}}`))
	_ = c.WriteMessage(websocket.BinaryMessage, []byte("echo vhterm_ok\n"))

	c.SetReadDeadline(time.Now().Add(8 * time.Second))
	var acc strings.Builder
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v (got %q)", err, acc.String())
		}
		acc.Write(data)
		if strings.Contains(acc.String(), "vhterm_ok") {
			return // PTY ran the command and echoed output back
		}
	}
}

func dialTerm(t *testing.T, srv *httptest.Server, dir string, cols, rows uint16) *websocket.Conn {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	u.RawQuery = "dir=" + url.QueryEscape(dir)
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"resize":{"cols":`+itoa(cols)+`,"rows":`+itoa(rows)+`}}`))
	return c
}
func itoa(n uint16) string { return strconv.Itoa(int(n)) }

func readUntil(t *testing.T, c *websocket.Conn, needle string, d time.Duration) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(d))
	var acc strings.Builder
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read (want %q): %v; got %q", needle, err, acc.String())
		}
		acc.Write(data)
		if strings.Contains(acc.String(), needle) {
			return acc.String()
		}
	}
}

func TestTerminalPersistsAndReattaches(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no shell")
	}
	dir := t.TempDir()
	s := &Server{}
	srv := httptest.NewServer(http.HandlerFunc(s.handleTerminalWS))
	defer srv.Close()

	a := dialTerm(t, srv, dir, 80, 24)
	_ = a.WriteMessage(websocket.BinaryMessage, []byte("echo persist_marker\n"))
	readUntil(t, a, "persist_marker", 8*time.Second)
	a.Close() // detach — session must survive

	// Reattach to the same dir → scrollback replay includes the earlier output.
	b := dialTerm(t, srv, dir, 80, 24)
	defer b.Close()
	readUntil(t, b, "persist_marker", 8*time.Second)
}

func dialTermID(t *testing.T, srv *httptest.Server, dir, id string) *websocket.Conn {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	q := url.Values{"dir": {dir}, "id": {id}}
	u.RawQuery = q.Encode()
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("dial id=%q: %v", id, err)
	}
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"resize":{"cols":80,"rows":24}}`))
	return c
}

// Two different ids on the same dir are independent shells; a third client with
// the same id shares the first's shell. killTermSession is id-scoped.
func TestTerminalMultipleIDsPerDir(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no shell")
	}
	dir := t.TempDir()
	s := &Server{}
	srv := httptest.NewServer(http.HandlerFunc(s.handleTerminalWS))
	defer srv.Close()

	a := dialTermID(t, srv, dir, "shared")
	defer a.Close()
	b := dialTermID(t, srv, dir, "session:abc")
	defer b.Close()

	// Each shell has its own scrollback — a marker written to one must NOT show
	// in the other.
	_ = a.WriteMessage(websocket.BinaryMessage, []byte("echo MARK_SHARED\n"))
	readUntil(t, a, "MARK_SHARED", 8*time.Second)
	_ = b.WriteMessage(websocket.BinaryMessage, []byte("echo MARK_SESSION\n"))
	readUntil(t, b, "MARK_SESSION", 8*time.Second)

	// dir-filtered list sees exactly the two terminals, with their ids.
	got := listTermSessions(dir)
	if len(got) != 2 {
		t.Fatalf("want 2 terminals for dir, got %d: %+v", len(got), got)
	}
	ids := map[string]bool{}
	for _, ti := range got {
		ids[ti.ID] = true
	}
	if !ids["shared"] || !ids["session:abc"] {
		t.Fatalf("missing expected ids, got %v", ids)
	}

	// Killing one id leaves the other alive.
	if !killTermSession(dir, "session:abc") {
		t.Fatalf("kill session:abc returned false")
	}
	time.Sleep(200 * time.Millisecond)
	if got := listTermSessions(dir); len(got) != 1 || got[0].ID != "shared" {
		t.Fatalf("after kill want only shared, got %+v", got)
	}
}

func TestTerminalMinSizeAcrossClients(t *testing.T) {
	if _, err := exec.LookPath("stty"); err != nil {
		t.Skip("no stty")
	}
	dir := t.TempDir()
	s := &Server{}
	srv := httptest.NewServer(http.HandlerFunc(s.handleTerminalWS))
	defer srv.Close()

	a := dialTerm(t, srv, dir, 100, 50) // big
	defer a.Close()
	b := dialTerm(t, srv, dir, 40, 20) // small → PTY should shrink to this
	defer b.Close()
	time.Sleep(300 * time.Millisecond) // let both resizes apply

	_ = a.WriteMessage(websocket.BinaryMessage, []byte("stty size\n"))
	out := readUntil(t, a, "20 40", 8*time.Second) // "rows cols" = min(50,20) min(100,40)
	if !strings.Contains(out, "20 40") {
		t.Fatalf("expected min size 20 40, got: %q", out)
	}
}
