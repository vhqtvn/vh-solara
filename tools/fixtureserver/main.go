// Command fixtureserver runs the real vh-solara aggregator + web server
// against a fake OpenCode (pkg/fixtures), serving the built SPA and live
// /vh + /oc endpoints with deterministic data. It is the fixture-backed lane
// for frontend dev and Playwright e2e — no real `opencode` binary required.
//
//	go run ./tools/fixtureserver -addr 127.0.0.1:8099
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// Canned multi-provider quota so the Settings → Usage panel is exercisable
// without real provider credentials (any launch path: make fixtures,
// fixture-web.sh, docker ui-demo). Overridable via VH_QUOTA_FIXTURE.
const demoQuotaJSON = `{"providers":[` +
	`{"providerId":"claude","providerName":"Claude","ok":true,"configured":true,"windows":[` +
	`{"label":"5h","usedPercent":42,"remainingPercent":58,"windowSeconds":18000,"resetAfterSeconds":5400,"resetAt":null},` +
	`{"label":"7d","usedPercent":88,"remainingPercent":12,"windowSeconds":604800,"resetAfterSeconds":120000,"resetAt":null}]},` +
	`{"providerId":"openrouter","providerName":"OpenRouter","ok":true,"configured":true,"windows":[` +
	`{"label":"credits","usedPercent":30,"remainingPercent":70,"windowSeconds":null,"resetAfterSeconds":null,"resetAt":null,"valueLabel":"$14.00 remaining"}]}]}`

func main() {
	addr := flag.String("addr", "127.0.0.1:8099", "address for the vh web server")
	flag.Parse()

	if os.Getenv("VH_QUOTA_FIXTURE") == "" {
		_ = os.Setenv("VH_QUOTA_FIXTURE", demoQuotaJSON)
	}
	// Isolate persisted notes/archive to a throwaway dir so fixture runs never
	// touch the real user config (and start clean each process).
	if os.Getenv("VH_STATE_DIR") == "" {
		if d, err := os.MkdirTemp("", "vh-fixture-state-"); err == nil {
			_ = os.Setenv("VH_STATE_DIR", d)
		}
	}

	// Fake OpenCode on a private loopback port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("listen (fake opencode): %v", err)
	}
	ocURL := "http://" + ln.Addr().String()
	go func() {
		if err := http.Serve(ln, fixtures.New().Handler()); err != nil {
			log.Fatalf("fake opencode serve: %v", err)
		}
	}()

	// Real aggregator + real web server, exactly as the daemon wires them.
	agg := aggregator.New(ocURL, 4096)
	go agg.Run(context.Background())

	srv, err := web.NewServer(agg, ocURL, 4096)
	if err != nil {
		log.Fatalf("build web server: %v", err)
	}
	// Fake OpenCode lifecycle hooks so the UI's version/update/restart controls
	// are demoable and testable without a real OpenCode process.
	srv.SetOpenCodeVersion(func(context.Context) (string, string, string, error) { return "0.1.0", "0.1.0", "0.2.0", nil })
	srv.SetUpdateOpenCode(func(_ context.Context, w io.Writer) error {
		_, _ = io.WriteString(w, "(fixture) pretending to upgrade…\n")
		return nil
	})
	srv.SetRestartOpenCode(func(context.Context) error { return nil })
	srv.SetRestartServer(func() { log.Printf("(fixture) restart-server requested — no-op") })

	log.Printf("vh fixture server: http://%s  (fake opencode at %s)", *addr, ocURL)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("vh web server: %v", err)
	}
}
