# syntax=docker/dockerfile:1

# 1) Build the SolidJS single-server SPA. It is embedded into the Go binary, so
#    it must exist before `go build`. Output lands at /app/web/dist-build (vite
#    outDir); the gobuild stage copies it into pkg/web/dist where //go:embed
#    reads it.
FROM node:24-alpine AS webbuild
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# 2) Build the SolidJS host shell (the multi-server SPA served at `/`). Mirrors
#    the webbuild stage above and the Makefile `host-web` target: VITE_HOST_FOLDED=1
#    namespaces the host assets under /host/ (vite base "/host/") so they do not
#    collide with the single-server SPA's root-level /assets/. Output lands at
#    /app/host-web/dist (vite outDir); the gobuild stage copies it into
#    pkg/web/host-dist where //go:embed reads it. The binary then serves
#    `/` -> host shell, `/app` -> single-server SPA, `/host/*` -> host assets
#    (the dual-SPA fold). Matches release.yml "Build host shell" + "Materialize
#    host shell into pkg/web/host-dist".
FROM node:24-alpine AS hostbuild
WORKDIR /app
COPY host-web/package.json host-web/package-lock.json ./host-web/
RUN cd host-web && npm ci
COPY host-web ./host-web
# host-web/src/theme.ts imports the shared pure-data theme catalog across
# trees (../../web/src/themeCatalog, introduced in 5d24f3f); web/ otherwise
# lives only in the webbuild stage. Copy JUST that one file so vite can
# resolve the import here, mirroring the Dockerfile.e2e hostbuild fix
# (e726b4e): themeCatalog.ts is deliberately import-free (see its header),
# so a single file is the complete dependency closure. Placed after the
# host-web COPY (npm ci layer untouched) so catalog edits only invalidate
# the final build layer.
COPY web/src/themeCatalog.ts ./web/src/
# The folded host build ALSO needs the staged single-server SPA shell: the
# spaEntryPreload plugin in host-web/vite.config.ts (page-load-perf P2)
# mirrors web/dist-build/index.html's content-hashed entry tags into the
# host shell as preload hints, and its P2b guard fails the build LOUDLY when
# that staging is missing. webbuild (stage 1 above) already produced it, so
# stage it into this stage too — without this COPY `make docker` hard-fails;
# with it the image ships a hint-carrying host shell (docker images had
# shipped hint-less shells since the fold landed in e954114 — the silent
# no-op that guard exists to catch). Placed with the themeCatalog COPY
# (after the host-web COPY so the npm ci layer stays untouched, before the
# build RUN).
COPY --from=webbuild /app/web/dist-build ./web/dist-build
RUN cd host-web && VITE_HOST_FOLDED=1 npm run build

# 3) Build the static Go binaries with BOTH freshly built SPAs embedded.
FROM golang:1.26-alpine AS gobuild
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=webbuild /app/web/dist-build ./pkg/web/dist
# Materialize the host shell, mirroring host-web/scripts/materialize.sh (and the
# release.yml "Materialize host shell" step): clean stale generated host
# artifacts FIRST, preserving the tracked placeholder.html, then copy the fresh
# build. The cleanup matters because pkg/web/host-dist is NOT in .dockerignore
# (unlike pkg/web/dist), so COPY . . above can carry gitignored host assets left
# in a local working dir by a prior `make build` -- without this rm those stale
# assets would ship in the image. serveHostIndex prefers index.html, so the
# placeholder is inert when a real build is present.
RUN rm -rf ./pkg/web/host-dist/assets ./pkg/web/host-dist/index.html \
    ./pkg/web/host-dist/*.js ./pkg/web/host-dist/*.map 2>/dev/null || true
COPY --from=hostbuild /app/host-web/dist ./pkg/web/host-dist
# GOTOOLCHAIN=local is deliberate (hermetic, reproducible builds) and means there is
# NO auto-download fallback inside this image. Invariant: the base image's Go (FROM
# golang:1.26-alpine above) MUST be >= the `go` directive in go.mod, or this stage
# hard-fails. Local dev and CI stay green via GOTOOLCHAIN=auto / go-version-file, so a
# go.mod directive bump that outruns the Docker official image is a SILENT TRAP here.
# Before bumping go.mod's `go` line, confirm the tag already carries that patch:
#   docker run --rm golang:1.26-alpine go version
# (As of go.mod 1.26.9 the margin is zero: the image supplies exactly go1.26.9.)
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN go build -trimpath -ldflags="-s -w" -o /out/vh-solara . \
 && go build -trimpath -ldflags="-s -w" -o /out/fixtureserver ./tools/fixtureserver

# 4) Minimal runtime image.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 vh
COPY --from=gobuild /out/vh-solara /usr/local/bin/vh-solara
COPY --from=gobuild /out/fixtureserver /usr/local/bin/fixtureserver
USER vh
ENTRYPOINT ["vh-solara"]
CMD ["--help"]
