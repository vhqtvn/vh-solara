# vh-solara developer tasks.
# The web UI is embedded into the Go binary, so build the SPA before the binary.

.PHONY: web build install test test-web e2e e2e-keep docker fixtures bench

web: ## Build the SolidJS UI into pkg/web/dist (embedded by the binary)
	cd web && npm install && npm run build

build: web ## Build the vh-solara binary (single file, UI embedded via go:embed)
	go build -o vh-solara .

install: web ## Build the UI then `go install` the single embedded binary into GOBIN
	go install .

test: ## Run Go unit/integration tests
	go test ./pkg/...

test-web: ## Run web unit tests + fixture-backed Playwright e2e (needs Node >= 20)
	cd web && npm run test:unit && npm run test:e2e

fixtures: ## Run the fixture-backed web stack locally on :8099 (no opencode needed)
	cd web && npm run build && cd .. && go run ./tools/fixtureserver -addr 127.0.0.1:8099

bench: ## Benchmark the chat view (VH_BENCH_MESSAGES=N complex messages, default 300)
	bash web/scripts/bench.sh

e2e: ## Full docker e2e: real opencode + fake LLM through the real vh stack
	bash tests/e2e-docker/run.sh

e2e-keep: ## Same as e2e but leave the container running for inspection
	bash tests/e2e-docker/run.sh --keep

docker: ## Build the production image
	docker build -t vh-solara .
