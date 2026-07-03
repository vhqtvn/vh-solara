# vh-solara developer tasks.
# The web UI is embedded into the Go binary. `make web` builds the SPA into a
# gitignored staging dir (web/dist-build); embed-producing targets materialize
# (copy) the staged bundle into pkg/web/dist right before `go build`.

.PHONY: web web-materialize build install test test-web e2e e2e-keep docker fixtures bench

web: ## Build the SolidJS UI into the staging dir web/dist-build (gitignored, NOT pkg/web/dist)
	cd web && npm install && npm run build

web-materialize: web ## Copy staged SPA (web/dist-build) into the Go embed dir pkg/web/dist
	bash web/scripts/materialize.sh

build: web-materialize ## Build the vh-solara binary (single file, UI embedded via go:embed)
	go build -o vh-solara .

install: web-materialize ## Build the UI then `go install` the single embedded binary into GOBIN
	go install .

test: ## Run Go unit/integration tests
	go test ./pkg/...

test-web: ## Run web unit tests + fixture-backed Playwright e2e (needs Node >= 20)
	cd web && npm run test:unit && npm run test:e2e

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
