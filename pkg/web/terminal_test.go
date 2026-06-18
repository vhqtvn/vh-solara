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
	b := dialTerm(t, srv, dir, 40, 20)  // small → PTY should shrink to this
	defer b.Close()
	time.Sleep(300 * time.Millisecond) // let both resizes apply

	_ = a.WriteMessage(websocket.BinaryMessage, []byte("stty size\n"))
	out := readUntil(t, a, "20 40", 8*time.Second) // "rows cols" = min(50,20) min(100,40)
	if !strings.Contains(out, "20 40") {
		t.Fatalf("expected min size 20 40, got: %q", out)
	}
}
