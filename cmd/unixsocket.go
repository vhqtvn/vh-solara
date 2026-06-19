package cmd

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

// serveUnixSocket serves handler on an AF_UNIX socket at path, in addition to
// whatever TCP listener the caller runs. It exists so a consumer that can't reach
// the worker's loopback TCP port — e.g. a container with no host networking, or
// to avoid auto-assigned-port discovery — can bind-mount the socket and call the
// same /vh/* (X-VH-CSRF + body verbs unchanged) with zero network.
//
// A stale socket file is removed first; the parent dir is created; the socket is
// chmod 0666 so a different-uid process (a bind-mounted dev container) can reach
// it — the exposure equals the worker's existing no-auth loopback TCP, but
// local-machine only (file-system reachable). Returns the http.Server (for
// Shutdown) so the caller can also remove the path on exit.
func serveUnixSocket(path string, handler http.Handler) (*http.Server, error) {
	if path == "" {
		return nil, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create socket dir: %w", err)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove stale socket %s: %w", path, err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen on unix socket %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o666); err != nil {
		log.Printf("warning: chmod unix socket %s: %v", path, err)
	}
	srv := &http.Server{Handler: handler}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("vh unix-socket server (%s) stopped: %v", path, err)
		}
	}()
	return srv, nil
}
