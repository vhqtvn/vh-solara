package web

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// In-browser terminal: a real PTY (so vim/less and width-aware tools work)
// bridged to xterm.js over a WebSocket.
//
// Persistence: a PTY session lives PER PROJECT DIR and survives WebSocket
// disconnects, so a reload/dock-toggle reattaches the same shell. A capped
// scrollback buffer is replayed on attach to reconstruct the screen. An idle
// session (no clients) is reaped after a timeout; a session ends when its shell
// exits.
//
// Size across clients: a PTY has a single winsize, but several clients (reload
// races, a phone + a desktop, two tabs) can attach at once. We set the PTY to
// the MINIMUM cols/rows across attached clients (tmux's shared-session model) so
// content fits every viewer; detaching a client resizes back up.
//
// Wire protocol:
//   - client → server BINARY: raw keystroke bytes
//   - client → server TEXT (JSON): control, currently {"resize":{"cols","rows"}}
//   - server → client BINARY: raw PTY output

const (
	termScrollback = 256 * 1024      // replayed on attach
	termIdleTTL    = 30 * time.Minute // kill a session with no clients after this
)

var termUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Same-origin only. A WebSocket upgrade carries cookies but not the
	// X-VH-CSRF header, so csrfGuard can't cover it; with a shared auth cookie
	// across worker subdomains, allowing any Origin would let one (possibly
	// agent-controlled) worker page open an authenticated terminal to another.
	// Reject cross-origin upgrades; a missing Origin (non-browser client) passes.
	CheckOrigin: checkSameOriginWS,
}

// checkSameOriginWS allows an upgrade when there is no Origin (a non-browser
// client) or the Origin host equals the request Host. This mirrors gorilla's
// default and blocks cross-subdomain WebSocket riding.
func checkSameOriginWS(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

type termControl struct {
	Resize *struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	} `json:"resize"`
}

type termClient struct {
	send       chan []byte
	cols, rows uint16
}

type termSession struct {
	dir  string
	ptmx *os.File
	cmd  *exec.Cmd

	mu         sync.Mutex
	buf        []byte
	clients    map[*termClient]bool
	reaper     *time.Timer
	closed     bool
	lastActive time.Time
}

var (
	termReg   = map[string]*termSession{}
	termRegMu sync.Mutex
)

func defaultShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	for _, c := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "sh"
}

// getOrCreateTermSession returns the live session for dir, spawning a shell on
// first use.
func getOrCreateTermSession(dir string) (*termSession, error) {
	termRegMu.Lock()
	defer termRegMu.Unlock()
	if s := termReg[dir]; s != nil && !s.closed {
		return s, nil
	}
	cmd := exec.Command(defaultShell())
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	_ = pty.Setsize(ptmx, &pty.Winsize{Cols: 80, Rows: 24})
	s := &termSession{dir: dir, ptmx: ptmx, cmd: cmd, clients: map[*termClient]bool{}, lastActive: time.Now()}
	termReg[dir] = s
	go s.pump()
	go func() { _ = cmd.Wait(); s.shutdown() }()
	return s, nil
}

// pump reads PTY output into the scrollback buffer and fans it out to clients.
func (s *termSession) pump() {
	buf := make([]byte, 8192)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.lastActive = time.Now()
			s.buf = append(s.buf, chunk...)
			if len(s.buf) > termScrollback {
				s.buf = append([]byte(nil), s.buf[len(s.buf)-termScrollback:]...)
			}
			for c := range s.clients {
				select {
				case c.send <- chunk:
				default: // slow client: drop it rather than stall the session
					close(c.send)
					delete(s.clients, c)
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.shutdown()
			return
		}
	}
}

func (s *termSession) shutdown() {
	termRegMu.Lock()
	if termReg[s.dir] == s {
		delete(termReg, s.dir)
	}
	termRegMu.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	for c := range s.clients {
		close(c.send)
	}
	s.clients = map[*termClient]bool{}
	if s.reaper != nil {
		s.reaper.Stop()
	}
	s.mu.Unlock()
	_ = s.ptmx.Close()
	_ = s.cmd.Process.Kill()
}

// effectiveSizeLocked = the minimum cols/rows across sized clients (caller holds
// s.mu), so the PTY content fits the smallest attached viewport.
func (s *termSession) effectiveSizeLocked() (uint16, uint16) {
	var cols, rows uint16
	for c := range s.clients {
		if c.cols == 0 || c.rows == 0 {
			continue
		}
		if cols == 0 || c.cols < cols {
			cols = c.cols
		}
		if rows == 0 || c.rows < rows {
			rows = c.rows
		}
	}
	return cols, rows
}

func (s *termSession) applySizeLocked() {
	if cols, rows := s.effectiveSizeLocked(); cols > 0 && rows > 0 {
		_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
	}
}

// attach registers a client, cancels any idle reaper, and queues the scrollback
// replay (atomically, so no live chunk is lost or duplicated around it).
func (s *termSession) attach(c *termClient) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	if s.reaper != nil {
		s.reaper.Stop()
		s.reaper = nil
	}
	if len(s.buf) > 0 {
		c.send <- append([]byte(nil), s.buf...) // replay precedes any future live chunk
	}
	s.clients[c] = true
	return true
}

func (s *termSession) detach(c *termClient) {
	s.mu.Lock()
	if s.clients[c] {
		delete(s.clients, c)
		close(c.send)
	}
	s.applySizeLocked() // remaining clients may allow a larger size
	idle := len(s.clients) == 0
	if idle && !s.closed {
		s.reaper = time.AfterFunc(termIdleTTL, s.shutdown)
	}
	s.mu.Unlock()
}

func (s *termSession) resize(c *termClient, cols, rows uint16) {
	s.mu.Lock()
	c.cols, c.rows = cols, rows
	s.applySizeLocked()
	s.mu.Unlock()
}

// TermInfo summarizes a live session for the management UI.
type TermInfo struct {
	Dir     string `json:"dir"`
	Clients int    `json:"clients"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	IdleSec int    `json:"idleSec"`
	Preview string `json:"preview"`
}

// ansiRe strips CSI/OSC escape sequences for a readable preview of the
// scrollback tail.
var ansiRe = regexp.MustCompile(`\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_][0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)

func listTermSessions() []TermInfo {
	termRegMu.Lock()
	sessions := make([]*termSession, 0, len(termReg))
	for _, s := range termReg {
		sessions = append(sessions, s)
	}
	termRegMu.Unlock()

	out := make([]TermInfo, 0, len(sessions))
	for _, s := range sessions {
		s.mu.Lock()
		cols, rows := s.effectiveSizeLocked()
		info := TermInfo{
			Dir:     s.dir,
			Clients: len(s.clients),
			Cols:    cols,
			Rows:    rows,
			IdleSec: int(time.Since(s.lastActive).Seconds()),
			Preview: previewTail(s.buf),
		}
		s.mu.Unlock()
		out = append(out, info)
	}
	return out
}

func killTermSession(dir string) bool {
	termRegMu.Lock()
	s := termReg[dir]
	termRegMu.Unlock()
	if s == nil {
		return false
	}
	s.shutdown()
	return true
}

// previewTail returns the last few readable lines of the scrollback.
func previewTail(buf []byte) string {
	if len(buf) == 0 {
		return ""
	}
	tail := buf
	if len(tail) > 4096 {
		tail = tail[len(tail)-4096:]
	}
	clean := ansiRe.ReplaceAllString(string(tail), "")
	lines := []string{}
	for _, ln := range strings.Split(clean, "\n") {
		if t := strings.TrimRight(ln, " \r\t"); t != "" {
			lines = append(lines, t)
		}
	}
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	return strings.Join(lines, "\n")
}

// GET /vh/term/list — active terminal sessions (for the management tab).
func (s *Server) handleTermList(w http.ResponseWriter, r *http.Request) {
	writeJSONResp(w, listTermSessions())
}

// POST /vh/term/kill {dir} — end a terminal session.
func (s *Server) handleTermKill(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var b struct {
		Dir string `json:"dir"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	if json.NewDecoder(r.Body).Decode(&b) != nil || b.Dir == "" {
		http.Error(w, "dir required", http.StatusBadRequest)
		return
	}
	writeJSONResp(w, map[string]any{"ok": killTermSession(b.Dir)})
}

// GET /vh/term/ws — attach to (or create) the project's terminal session.
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	dir, ok := gitRepoDir(r) // a real, existing directory; require an explicit project
	if !ok {
		http.Error(w, "open a project directory to use the terminal", http.StatusBadRequest)
		return
	}
	sess, err := getOrCreateTermSession(dir)
	if err != nil {
		http.Error(w, "failed to start shell: "+err.Error(), http.StatusBadGateway)
		return
	}
	conn, err := termUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	c := &termClient{send: make(chan []byte, 512)}
	if !sess.attach(c) {
		return
	}
	defer sess.detach(c)

	// Keepalive: without periodic traffic an idle connection gets silently
	// dropped by intermediaries (reverse proxy / tunnel idle timeouts), leaving
	// the client unable to type with no error. Ping on a timer; a missing pong
	// within pongWait fails the read so the connection is torn down (the client
	// then reconnects). The browser auto-replies to pings, so no client work.
	const (
		writeWait  = 10 * time.Second
		pongWait   = 60 * time.Second
		pingPeriod = (pongWait * 9) / 10
	)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// Writer: drain this client's queue to the socket (preserves order) and emit
	// pings. Single goroutine so all writes are serialized (gorilla requires it).
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case b, ok := <-c.send:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if !ok {
					_ = conn.WriteControl(websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseNormalClosure, "exit"), time.Now().Add(writeWait))
					return
				}
				if conn.WriteMessage(websocket.BinaryMessage, b) != nil {
					return
				}
			case <-ticker.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)) != nil {
					return
				}
			}
		}
	}()

	// Reader: input + resize control.
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(pongWait)) // any client activity keeps it alive
		switch mt {
		case websocket.BinaryMessage:
			if _, err := sess.ptmx.Write(data); err != nil {
				return
			}
		case websocket.TextMessage:
			var ctl termControl
			if json.Unmarshal(data, &ctl) == nil && ctl.Resize != nil {
				sess.resize(c, ctl.Resize.Cols, ctl.Resize.Rows)
			}
		}
		select {
		case <-done:
			return
		default:
		}
	}
}
