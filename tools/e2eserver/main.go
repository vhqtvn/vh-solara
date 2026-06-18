// Command e2eserver runs the real vh-solara stack against a real `opencode
// serve` (no controller/tunnel): it spawns opencode serve in a workspace whose
// opencode.json points at a fake LLM, then runs the real aggregator + web
// server on -addr. Used by the docker e2e to exercise the whole flow with an
// actual opencode session.
//
//	e2eserver -addr 0.0.0.0:8099 -workdir /work -opencode-bin opencode
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

func main() {
	addr := flag.String("addr", "0.0.0.0:8099", "vh web server listen address")
	bin := flag.String("opencode-bin", "opencode", "path to the opencode binary")
	workdir := flag.String("workdir", ".", "workspace dir (contains opencode.json)")
	flag.Parse()

	ocPort := freePort()
	cmd := exec.Command(*bin, "serve", "--port", strconv.Itoa(ocPort), "--hostname", "127.0.0.1")
	cmd.Dir = *workdir
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("start opencode serve: %v", err)
	}
	log.Printf("started opencode serve (pid=%d) on port %d in %s", cmd.Process.Pid, ocPort, *workdir)

	if err := waitForPort(ocPort, 60*time.Second); err != nil {
		log.Fatalf("opencode serve not ready: %v", err)
	}
	ocURL := fmt.Sprintf("http://127.0.0.1:%d", ocPort)
	log.Printf("opencode serve ready at %s", ocURL)

	agg := aggregator.New(ocURL, 4096)
	go agg.Run(context.Background())

	srv, err := web.NewServer(agg, ocURL, 4096)
	if err != nil {
		log.Fatalf("web server: %v", err)
	}
	log.Printf("vh e2e server: http://%s", *addr)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 4096
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitForPort(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err == nil {
			c.Close()
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("port %d not ready after %v", port, timeout)
}
