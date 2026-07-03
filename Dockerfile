# syntax=docker/dockerfile:1

# 1) Build the SolidJS SPA. It is embedded into the Go binary, so it must exist
#    before `go build`. Output lands at /app/web/dist-build (vite outDir); the
#    stage below copies it into pkg/web/dist where //go:embed reads it.
FROM node:20-alpine AS webbuild
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
