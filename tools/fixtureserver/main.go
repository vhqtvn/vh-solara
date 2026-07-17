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
	"path/filepath"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
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

// demoProjectDir is the on-disk directory the consolidated demo project maps
// to. It MUST be writable: the attachment upload handler writes into
// <dir>/.vh-solara/sessions/<sid>/attachments, and several e2e specs load this
// dir via ?dir=. The fixtureserver creates it on startup so a non-root user
// (or a container without /work) still has a real writable project root.
// Overridable via VH_DEMO_DIR (the e2e webServer passes a repo-relative path so
// the Go fixture and the TS test harness share one source of truth).
const defaultDemoDir = "/work/demo"

func main() {
	addr := flag.String("addr", "127.0.0.1:8099", "address for the vh web server")
	flag.Parse()

	if os.Getenv("VH_QUOTA_FIXTURE") == "" {
		_ = os.Setenv("VH_QUOTA_FIXTURE", demoQuotaJSON)
	}
	// Resolve + create the consolidated demo project directory BEFORE seeding
	// the fixture (sessions report this directory). MkdirAll is idempotent and
	// tolerates concurrent runs. VH_DEMO_DIR lets the e2e lane pin a known
	// repo-relative path; the default /work/demo is used when unset (e.g. a
	// root-owned container that can create /work/demo).
	demoProjectDir := os.Getenv("VH_DEMO_DIR")
	if demoProjectDir == "" {
		demoProjectDir = defaultDemoDir
	}
	if err := os.MkdirAll(demoProjectDir, 0o755); err != nil {
		// Non-fatal: specs that don't write to the project tree still work with
		// a non-existent dir; only attachment-style tests need it on disk.
		log.Printf("fixture: could not create demo dir %q: %v (attach-style e2e may fail)", demoProjectDir, err)
	}
	fixtures.SetDemoDir(demoProjectDir)
	log.Printf("fixture: demo project dir = %s", demoProjectDir)
	// Isolate persisted notes/archive to a throwaway dir so fixture runs never
	// touch the real user config (and start clean each process).
	stateDir := os.Getenv("VH_STATE_DIR")
	if stateDir == "" {
		if d, err := os.MkdirTemp("", "vh-fixture-state-"); err == nil {
			stateDir = d
			_ = os.Setenv("VH_STATE_DIR", stateDir)
		}
	}
	// Seed a managed-project fixture so the trust gate + processes panel are
	// reachable from e2e without a real repo: create a project dir under the
	// throwaway state tree and make it the default project (projectRoot("") =
	// cwd). The config itself is written once the fake-opencode URL is known,
	// and the project is opened after managed projects are wired below.
	managedDir := filepath.Join(stateDir, "managed-project")
	_ = os.MkdirAll(filepath.Join(managedDir, ".vh-solara"), 0o755)
	_ = os.Chdir(managedDir)

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
	// Canned changelog so the dialog's "What's new (since 0.1.0)" panel is
	// demoable in dev/e2e without hitting opencode.ai. Uses the same
	// best-effort heuristic as the real fetcher.
	srv.SetOpencodeChangelog(fixtureChangelog)

	// Wire managed projects (repo-declared processes + views). The fixture
	// project dir (our cwd) carries a config pointing one view at the fake
	// opencode; it starts UNTRUSTED so e2e can exercise the trust-review card,
	// then grants it.
	procCtx, procCancel := context.WithCancel(context.Background())
	defer procCancel()
	procMgr := procmgr.NewManager(procCtx)
	if trust, err := web.NewTrustStore(); err != nil {
		log.Printf("managed projects disabled: %v", err)
	} else {
		seedManagedFixture(managedDir, "tcp:"+strings.TrimPrefix(ocURL, "http://"))
		orch := srv.InitManaged(procMgr, trust, "", false)
		orch.OpenProject("")
	}

	// Notifications/alerts engine, exactly as the daemon wires it — so the
	// Settings → Notifications page and the in-app notice flow are demoable.
	if _, err := srv.InitAlerts(context.Background()); err != nil {
		log.Printf("(fixture) alerts engine disabled: %v", err)
	}

	log.Printf("vh fixture server: http://%s  (fake opencode at %s)", *addr, ocURL)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("vh web server: %v", err)
	}
}

// seedManagedFixture writes a .vh-solara/project.jsonc declaring one long-lived
// process (ready via the default-settle heuristic) and one view bound to the
// given upstream, so the trust-review card + processes panel have something to
// show. cwd "." resolves against the project root (the fixture dir).
func seedManagedFixture(dir, upstream string) {
	cfg := `{
  "processes": [
    { "id": "demo", "command": ["/bin/sh", "-c", "sleep 999"], "cwd": ".", "restart": "no" }
  ],
  "views": [
    { "id": "demo", "title": "Demo", "path_prefix": "/managed-demo", "upstream": "` + upstream + `", "depends_on": "demo" }
  ]
}`
	_ = os.WriteFile(filepath.Join(dir, ".vh-solara", "project.jsonc"), []byte(cfg), 0o644)
}

// fixtureChangelog returns canned changelog releases spanning the fixture's
// installed→latest range (0.1.0 → 0.2.0), showcasing all three highlight
// behaviors: a Core item the heuristic flags (breaking token), a Core item it
// does NOT, and a de-emphasized Desktop section. Lets the dialog's "What's new"
// panel render meaningfully in dev/e2e without hitting opencode.ai.
func fixtureChangelog(_ context.Context, _, _ string) ([]web.ChangelogRelease, error) {
	return []web.ChangelogRelease{
		{
			Tag:        "v0.2.0",
			Name:       "v0.2.0",
			Date:       "2026-07-10T00:00:00Z",
			URL:        "https://example.invalid/opencode/releases/tag/v0.2.0",
			Highlights: []string{},
			Sections: []web.ChangelogSection{
				{
					Title: "Desktop",
					Items: []web.ChangelogItem{
						{Text: "Migration of the settings folder layout", MayAffectYou: false},
					},
				},
				{
					Title: "Core",
					Items: []web.ChangelogItem{
						{Text: "Removed the legacy --old-flag config switch", MayAffectYou: true},
						{Text: "Added a model-specific temperature override", MayAffectYou: false},
					},
				},
			},
		},
	}, nil
}
