# vh-solara developer tasks.
# The web UI is embedded into the Go binary. `make web` builds the single-server
# SPA into a gitignored staging dir (web/dist-build); `make host-web` builds the
# multi-server host shell into host-web/dist. Embed-producing targets materialize
# (copy) BOTH staged bundles into pkg/web/dist + pkg/web/host-dist right before
# `go build`, so one binary carries both SPAs (`/` → host, `/app` → single-server).

.PHONY: web web-materialize host-web host-web-materialize embed-materialize build build-debug install install-local test test-unit test-web test-host-web test-host-web-docker test-host-web-preview test-host-web-real-embed verify fmt fmt-check vet typecheck e2e e2e-keep docker fixtures bench clean-web-embed clean-host-web-embed

# Version stamping: local builds set cmd.Version to "<latest v-tag>+dev" (e.g.
# v1.60.0+dev) so the self-update check never treats them as an already-released
# version: cmd/update.go compares by exact string equality against the release
# tag, and "v1.60.0+dev" does not exactly equal the bare tag "v1.60.0". That
# establishes inequality only — the check implements no version ordering or
# SemVer precedence (release.yml stamps the bare tag via its own ldflags and
# does not use these targets). Falls back to bare "dev" when git describe finds
# no v* tag (e.g. a tarball export). Caller-overridable:
# `make build VERSION=v9.9.9-custom`.
V_LATEST ?= $(shell git describe --tags --abbrev=0 --match 'v*' 2>/dev/null)
VERSION ?= $(if $(V_LATEST),$(V_LATEST)+dev,dev)
VERSION_LDFLAGS = -X github.com/vhqtvn/vh-solara/cmd.Version=$(VERSION)

web: ## Build the SolidJS single-server SPA into web/dist-build (gitignored, NOT pkg/web/dist)
	cd web && npm ci && npm run build

web-materialize: web ## Copy staged single-server SPA (web/dist-build) into pkg/web/dist
	bash web/scripts/materialize.sh

host-web: ## Build the host shell SPA into host-web/dist (gitignored, NOT pkg/web/host-dist). VITE_HOST_FOLDED=1 namespaces assets under /host/ so they do not collide with the single-server /assets/.
	cd host-web && npm ci && VITE_HOST_FOLDED=1 npm run build

host-web-materialize: host-web ## Copy staged host shell (host-web/dist) into pkg/web/host-dist
	bash host-web/scripts/materialize.sh

embed-materialize: web-materialize host-web-materialize ## Materialize BOTH SPA bundles (single-server + host) into their Go embed dirs

build: embed-materialize ## Build the vh-solara binary (single file, BOTH SPAs embedded via go:embed); stamps cmd.Version=$(VERSION)
	go build -ldflags "$(VERSION_LDFLAGS)" -o vh-solara .

build-debug: embed-materialize ## Build a local debug binary: debug logging forced on (no VH_DEBUG=1 needed) + cmd.Version=$(VERSION)
	go build -ldflags "$(VERSION_LDFLAGS) -X github.com/vhqtvn/vh-solara/pkg/vhlog.debugForced=1" -o vh-solara .

install: embed-materialize ## Build BOTH UIs then `go install` the single embedded binary (cmd.Version=$(VERSION)) into GOBIN
	go install -ldflags "$(VERSION_LDFLAGS)" .

install-local: build ## Build vh-solara and atomically install it over the existing binary on PATH (sudo/chown adapts to destination owner)
	@set -e; \
	ME=$$(id -u); \
	if DEST=$$(command -v vh-solara 2>/dev/null); then :; else DEST=/usr/local/bin/vh-solara; fi; \
	USE_SUDO=0; \
	CHOWN_ME=0; \
	if [ ! -e "$$DEST" ]; then \
		USE_SUDO=1; \
	else \
		DEST_OWNER=$$(stat -c %u "$$DEST" 2>/dev/null || echo ""); \
		if [ "$$DEST_OWNER" = "$$ME" ]; then :; \
		elif [ "$$DEST_OWNER" = "0" ]; then USE_SUDO=1; \
		else USE_SUDO=1; CHOWN_ME=1; \
		fi; \
	fi; \
	TMP=$$(mktemp -t vh-solara.XXXXXX); \
	trap 'rc=$$?; [ -n "$$TMP" ] && [ -e "$$TMP" ] && { if [ "$$USE_SUDO" = "1" ]; then sudo rm -f "$$TMP"; else rm -f "$$TMP"; fi; } 2>/dev/null || true; exit $$rc' EXIT; \
	if [ "$$USE_SUDO" = "1" ]; then \
		sudo install -m 0755 ./vh-solara "$$TMP"; \
		sudo mv -f "$$TMP" "$$DEST"; \
		if [ "$$CHOWN_ME" = "1" ]; then sudo chown "$$ME" "$$DEST"; fi; \
	else \
		install -m 0755 ./vh-solara "$$TMP"; \
		mv -f "$$TMP" "$$DEST"; \
	fi; \
	echo "installed vh-solara -> $$DEST"

test: ## Run all Go tests (mirrors CI's `go test ./...`)
	go test ./...

test-unit: ## Run Go co-located unit tests (fast lane: ./pkg/...)
	go test ./pkg/...

test-web: ## Run web unit tests + fixture-backed Playwright e2e (needs Node >= 24)
	cd web && npm run test:unit && npm run test:e2e

test-host-web: ## Run host-web Playwright e2e (iframe survival + shell, self-bootstrapped vite DEV servers; needs Node >= 24)
	cd host-web && npm run test:e2e

test-host-web-preview: ## Run host-web production-build shell proof (vite preview; needs Node >= 24)
	cd host-web && npm run test:e2e:preview

test-host-web-real-embed: ## Run host-web real-embedding e2e (real web/ SPA + real local-server, cross-origin host embed; LANE 8, nightly-grade, NOT PR-blocking). Full pipeline: builds web SPA, materializes into pkg/web/dist, builds the Go binary, runs Playwright. Needs go + Node >= 24 + Playwright browsers.
	bash host-web/scripts/real-embed-run.sh

# Docker-backed test routes (Phase 1: lane 7 only). See docs/ai/docker-test-routes.md.
# Official Playwright image, pinned to the exact @playwright/test version in
# host-web/package.json (browsers ship inside the image; PLAYWRIGHT_BROWSERS_PATH
# is preset). Host prerequisites: docker + repo checkout. Nothing else.
PLAYWRIGHT_IMAGE ?= mcr.microsoft.com/playwright:v1.60.0-noble
# Run as the invoking uid/gid with a writable HOME so artifacts under tmp/ and
# host-web/node_modules/.vite stay user-owned (never root-owned).
PW_DOCKER = docker run --rm --init --user "$$(id -u):$$(id -g)" -e HOME=/tmp/pw-home -v "$$(pwd)":/repo -w /repo $(PLAYWRIGHT_IMAGE)

test-host-web-docker: ## Run host-web Playwright e2e (LANE 7, all three engines) inside the pinned Playwright image — no host Node/browsers needed. Scope via ARGS, e.g. make test-host-web-docker ARGS='--project=webkit'. Installs host-web/node_modules in-container first if missing (fresh clone: works with docker only).
	@if [ ! -d host-web/node_modules ]; then \
		echo ">> host-web/node_modules missing — running npm ci inside $(PLAYWRIGHT_IMAGE)"; \
		$(PW_DOCKER) bash -c 'mkdir -p "$$HOME" && cd host-web && npm ci'; \
	fi
	$(PW_DOCKER) bash -c 'mkdir -p "$$HOME" && cd host-web && npx playwright test $(ARGS)'

fmt: ## Format all Go source (mirrors CI's gofmt scope)
	gofmt -w pkg cmd main.go

fmt-check: ## Fail if any Go file is not gofmt-clean (mirrors CI's gofmt gate)
	@files="$$(gofmt -l pkg cmd main.go)"; if [ -n "$$files" ]; then echo "These files are not gofmt-clean:"; echo "$$files"; echo "Run: make fmt"; exit 1; fi

vet: ## Run go vet on all packages (mirrors CI's `go vet ./...`)
	go vet ./...

typecheck: ## Typecheck the web SPA (mirrors CI's `npm run typecheck`)
	cd web && npm run typecheck

verify: fmt-check vet test typecheck ## Local end-of-impl/release verification gate (mirrors CI: gofmt -> vet -> test -> typecheck). Run before any release or declaring implementation done.

fixtures: embed-materialize ## Run the fixture-backed web stack locally on :8099 (no opencode needed)
	go run ./tools/fixtureserver -addr 127.0.0.1:8099

bench: ## Benchmark the chat view (VH_BENCH_MESSAGES=N complex messages, default 300)
	bash web/scripts/bench.sh

e2e: ## Full docker e2e: real opencode + fake LLM through the real vh stack
	bash tests/e2e-docker/run.sh

e2e-keep: ## Same as e2e but leave the container running for inspection
	bash tests/e2e-docker/run.sh --keep

docker: ## Build the production image
	docker build -t vh-solara .

clean-web-embed: ## Remove generated single-server SPA artifacts from pkg/web/dist (preserve tracked placeholder.html → cold-fallback embed)
	rm -rf pkg/web/dist/assets pkg/web/dist/index.html pkg/web/dist/*.js pkg/web/dist/*.map pkg/web/dist/*.webmanifest pkg/web/dist/*.svg pkg/web/dist/*.png 2>/dev/null || true

clean-host-web-embed: ## Remove generated host shell artifacts from pkg/web/host-dist (preserve tracked placeholder.html → cold-fallback embed)
	rm -rf pkg/web/host-dist/assets pkg/web/host-dist/index.html pkg/web/host-dist/*.js pkg/web/host-dist/*.map pkg/web/host-dist/*.webmanifest pkg/web/host-dist/*.svg pkg/web/host-dist/*.png 2>/dev/null || true
