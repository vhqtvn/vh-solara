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
RUN cd host-web && VITE_HOST_FOLDED=1 npm run build

# 3) Build the static Go binaries with BOTH freshly built SPAs embedded.
FROM golang:1.25-alpine AS gobuild
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
# golang:1.25-alpine above) MUST be >= the `go` directive in go.mod, or this stage
# hard-fails. Local dev and CI stay green via GOTOOLCHAIN=auto / go-version-file, so a
# go.mod directive bump that outruns the Docker official image is a SILENT TRAP here.
# Before bumping go.mod's `go` line, confirm the tag already carries that patch:
#   docker run --rm golang:1.25-alpine go version
# (As of go.mod 1.25.12 the margin is zero: the image supplies exactly go1.25.12.)
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
