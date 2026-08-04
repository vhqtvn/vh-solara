# syntax=docker/dockerfile:1

# 1) Build the SolidJS SPA. It is embedded into the Go binary, so it must exist
#    before `go build`. Output lands at /app/web/dist-build (vite outDir); the
#    stage below copies it into pkg/web/dist where //go:embed reads it.
FROM node:24-alpine AS webbuild
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# 2) Build the static Go binaries with the freshly built SPA embedded.
FROM golang:1.25-alpine AS gobuild
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=webbuild /app/web/dist-build ./pkg/web/dist
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

# 3) Minimal runtime image.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 vh
COPY --from=gobuild /out/vh-solara /usr/local/bin/vh-solara
COPY --from=gobuild /out/fixtureserver /usr/local/bin/fixtureserver
USER vh
ENTRYPOINT ["vh-solara"]
CMD ["--help"]
