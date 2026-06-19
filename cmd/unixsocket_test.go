package cmd

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func unixGet(t *testing.T, sock, path string) (int, string) {
	t.Helper()
	c := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	resp, err := c.Get("http://unix" + path)
	if err != nil {
		t.Fatalf("GET %s over unix socket: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestServeUnixSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "vh.sock")
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok:"+r.URL.Path)
	})
	srv, err := serveUnixSocket(sock, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })

	if st, body := unixGet(t, sock, "/vh/snapshot"); st != 200 || body != "ok:/vh/snapshot" {
		t.Fatalf("serve over socket: got %d %q", st, body)
	}
	// The socket is world-rw so a different-uid (bind-mounted container) process can reach it.
	if fi, err := os.Stat(sock); err != nil || fi.Mode().Perm() != 0o666 {
		t.Fatalf("socket perms: want 0666, got %v (err %v)", fiMode(fi), err)
	}
}

func TestServeUnixSocketRemovesStaleFile(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "vh.sock")
	// A stale regular file at the path must not block binding.
	if err := os.WriteFile(sock, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv, err := serveUnixSocket(sock, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "live")
	}))
	if err != nil {
		t.Fatalf("should remove stale file and bind, got: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	if st, body := unixGet(t, sock, "/"); st != 200 || body != "live" {
		t.Fatalf("after stale removal: got %d %q", st, body)
	}
}

func fiMode(fi os.FileInfo) string {
	if fi == nil {
		return "<nil>"
	}
	return fi.Mode().String()
}
