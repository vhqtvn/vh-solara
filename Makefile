# vh-solara developer tasks.
# The web UI is embedded into the Go binary. `make web` builds the SPA into a
# gitignored staging dir (web/dist-build); embed-producing targets materialize
# (copy) the staged bundle into pkg/web/dist right before `go build`.

.PHONY: web web-materialize build build-debug install test test-unit test-web fmt fmt-check vet typecheck e2e e2e-keep docker fixtures bench clean-web-embed

web: ## Build the SolidJS UI into the staging dir web/dist-build (gitignored, NOT pkg/web/dist)
	cd web && npm ci && npm run build

web-materialize: web ## Copy staged SPA (web/dist-build) into the Go embed dir pkg/web/dist
	bash web/scripts/materialize.sh

build: web-materialize ## Build the vh-solara binary (single file, UI embedded via go:embed)
	go build -o vh-solara .

build-debug: web-materialize ## Build a local debug binary: debug logging forced on (no VH_DEBUG=1 needed); mirrors the cmd.Version ldflags pattern
	go build -ldflags "-X github.com/vhqtvn/vh-solara/pkg/vhlog.debugForced=1" -o vh-solara .

install: web-materialize ## Build the UI then `go install` the single embedded binary into GOBIN
	go install .

test: ## Run all Go tests (mirrors CI's `go test ./...`)
	go test ./...

test-unit: ## Run Go co-located unit tests (fast lane: ./pkg/...)
	go test ./pkg/...

test-web: ## Run web unit tests + fixture-backed Playwright e2e (needs Node >= 24)
	cd web && npm run test:unit && npm run test:e2e

fmt: ## Format all Go source (mirrors CI's gofmt scope)
	gofmt -w pkg cmd main.go

fmt-check: ## Fail if any Go file is not gofmt-clean (mirrors CI's gofmt gate)
	@files="$$(gofmt -l pkg cmd main.go)"; if [ -n "$$files" ]; then echo "These files are not gofmt-clean:"; echo "$$files"; echo "Run: make fmt"; exit 1; fi

vet: ## Run go vet on all packages (mirrors CI's `go vet ./...`)
	go vet ./...

typecheck: ## Typecheck the web SPA (mirrors CI's `npm run typecheck`)
	cd web && npm run typecheck

fixtures: web-materialize ## Run the fixture-backed web stack locally on :8099 (no opencode needed)
	go run ./tools/fixtureserver -addr 127.0.0.1:8099

bench: ## Benchmark the chat view (VH_BENCH_MESSAGES=N complex messages, default 300)
	bash web/scripts/bench.sh

e2e: ## Full docker e2e: real opencode + fake LLM through the real vh stack
	bash tests/e2e-docker/run.sh

e2e-keep: ## Same as e2e but leave the container running for inspection
	bash tests/e2e-docker/run.sh --keep

docker: ## Build the production image
	docker build -t vh-solara .

clean-web-embed: ## Remove generated SPA artifacts from pkg/web/dist (preserve tracked placeholder.html → cold-fallback embed)
	rm -rf pkg/web/dist/assets pkg/web/dist/index.html pkg/web/dist/*.js pkg/web/dist/*.map pkg/web/dist/*.webmanifest pkg/web/dist/*.svg pkg/web/dist/*.png 2>/dev/null || true
