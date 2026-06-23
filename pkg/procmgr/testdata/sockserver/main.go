// sockserver is a tiny test fixture: it creates a unix socket at argv[1],
// accepts one connection to prove readiness, then idles until killed. Used by
// pkg/procmgr tests to exercise the unix readiness probe against a real child.
package main

import (
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: sockserver <socket-path>")
		os.Exit(2)
	}
	sock := os.Args[1]
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	defer ln.Close()
	// Accept connections so a readiness dial succeeds; keep serving.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	// Stay alive until SIGTERM/SIGINT.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
}
