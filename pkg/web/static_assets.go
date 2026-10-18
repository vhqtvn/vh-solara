package web

// Static-asset metadata + serving, moved verbatim from server.go (slice 4 of
// the server.go split): the embedded-FS walk that precomputes per-file serving
// metadata (staticAssetMeta + walkStaticAssets + the lazy distAssetMeta /
// hostAssetMeta probes), the S1 caching/gzip negotiation contract
// (staticCacheImmutable / staticCacheRevalidate / minGzipSize / gzipableExt /
// etagStrongMatches / acceptsGzip / serveStaticAsset), and the static route
// handlers (handleStatic, serveHostIndex, serveAppIndex, serveFavicon,
// newHTTPRequestPath). The `/` route is registered in server.go (Handler);
// the distFS/hostDistFS embeds, the staticFS/static + hostFS/hostStatic
// FileServer pairs, hostShellAtRoot, and the staticAssets/hostStaticAssets
// lazy caches are Server fields (see server.go) — this file only reads them.

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

// staticAssetMeta is the precomputed serving metadata for ONE embedded static
// file, captured during the one-time embed-FS walk. The embed FS is immutable
// (its files carry a zero modtime), so the content hash doubles as a strong
// ETag validator — there is no mtime to build a Last-Modified from, and no
// reason to re-hash per request.
type staticAssetMeta struct {
	etag  string // 32-hex-char SHA-256 prefix ("" if the file was unreadable at walk time)
	gz    []byte // precomputed gzip body for compressible text assets >= minGzipSize; nil otherwise
	ctype string // Content-Type exactly as the delegated FileServer would detect it
}

// staticCacheImmutable is the Cache-Control sent for content-hashed build
// assets: Vite emits every hashed bundle under assets/ (name-<hash>.ext), and
// the single-server service worker already treats /assets/ as immutable
// cache-first (web/public/sw.js), so a year-long immutable window matches the
// deploy contract: a new build produces new hashes, i.e. new URLs.
const staticCacheImmutable = "public, max-age=31536000, immutable"

// staticCacheRevalidate is the Cache-Control sent for every non-hashed static
// (sw.js, manifest.webmanifest, icons, screenshots, index.html, ...): always
// revalidate with the origin (via the strong ETag) so a deploy is picked up on
// the next request while unchanged bodies cost only a 304.
const staticCacheRevalidate = "no-cache"

// minGzipSize is the raw-size floor below which a static file is never gzipped
// (the gzip framing would rival or exceed the saved bytes on tiny bodies).
const minGzipSize = 1024

// gzipableExt is the set of text-ish file extensions eligible for server-side
// gzip on the static path. Binaries already ship in compressed containers
// (png/woff2/...) and would only burn CPU. Anything not listed is served
// identity, byte-for-byte as before this layer existed.
var gzipableExt = map[string]bool{
	".css": true, ".htm": true, ".html": true, ".js": true, ".json": true,
	".map": true, ".mjs": true, ".svg": true, ".txt": true,
	".webmanifest": true, ".xml": true,
}

// walkStaticAssets walks fsys once and returns per-file serving metadata: the
// existence probe distAssetMeta/hostAssetMeta is built on (path → non-nil),
// plus each file's content-hash ETag, FileServer-equivalent Content-Type, and
// a precomputed gzip body for eligible text assets. A file that cannot be read
// still gets a meta entry (etag "") so presence detection is unchanged and
// serving degrades to the plain FileServer path.
func walkStaticAssets(fsys fs.FS) map[string]*staticAssetMeta {
	assets := map[string]*staticAssetMeta{}
	_ = fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		m := &staticAssetMeta{}
		if data, rerr := fs.ReadFile(fsys, path); rerr == nil {
			sum := sha256.Sum256(data)
			m.etag = hex.EncodeToString(sum[:16])
			// Content-Type detection mirrors http.FileServer.serveContent:
			// extension table first, content sniffing as the fallback. Keeping
			// this identical means the gzip path emits the same Content-Type
			// the identity/FileServer path always did.
			m.ctype = mime.TypeByExtension(filepath.Ext(path))
			if m.ctype == "" && len(data) > 0 {
				sniff := data
				if len(sniff) > 512 {
					sniff = sniff[:512]
				}
				m.ctype = http.DetectContentType(sniff)
			}
			if gzipableExt[strings.ToLower(filepath.Ext(path))] && len(data) >= minGzipSize {
				var buf bytes.Buffer
				gw := gzip.NewWriter(&buf)
				_, _ = gw.Write(data)
				_ = gw.Close()
				if buf.Len() < len(data) { // never ship a "compressed" body that grew
					m.gz = buf.Bytes()
				}
			}
		}
		assets[path] = m
		return nil
	})
	return assets
}

// distAssetMeta returns the serving metadata for a single-server (dist) static
// file, or nil when p is not an embedded file. It guarantees the one-time walk
// has happened and doubles as handleStatic's real-asset-vs-route existence
// probe (non-nil = a real embedded file).
func (s *Server) distAssetMeta(p string) *staticAssetMeta {
	s.staticAssetsOnce.Do(func() { s.staticAssets = walkStaticAssets(s.staticFS) })
	return s.staticAssets[p]
}

// hostAssetMeta returns the serving metadata for a HOST shell static file
// (host-internal path), or nil when p is not an embedded file. Same walk-once
// contract as distAssetMeta.
func (s *Server) hostAssetMeta(p string) *staticAssetMeta {
	s.hostStaticAssetsOnce.Do(func() { s.hostStaticAssets = walkStaticAssets(s.hostFS) })
	return s.hostStaticAssets[p]
}

// etagStrongMatches reports whether an If-None-Match header value matches the
// strong etag (unquoted hex). If-None-Match uses weak comparison (RFC 9110
// §13.1.2), so a W/-prefixed or exact quote match — or the wildcard "*" — all
// count as a match; an absent header never matches.
func etagStrongMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" || etag == "" {
		return false
	}
	want := `"` + etag + `"`
	for _, part := range strings.Split(ifNoneMatch, ",") {
		part = strings.TrimSpace(part)
		if part == "*" {
			return true
		}
		if strings.TrimPrefix(part, "W/") == want {
			return true
		}
	}
	return false
}

// acceptsGzip reports whether the request's Accept-Encoding offers gzip with
// a non-zero quality value. Only gzip is negotiated: every browser that can
// send Accept-Encoding supports it, and keeping a single compression variant
// (plus identity) keeps intermediary caching with Vary trivially correct.
//
// Per RFC 9110 §12.5.3 the wildcard matches only codings NOT otherwise
// listed, so an explicit `gzip;q=0` refuses gzip even when `*` is offered
// alongside it (`gzip;q=0, *;q=1` → identity).
func acceptsGzip(acceptEncoding string) bool {
	gzipListed, gzipOK, wildcardOK := false, false, false
	for _, part := range strings.Split(acceptEncoding, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		coding := part
		q := 1.0
		if i := strings.IndexByte(part, ';'); i >= 0 {
			coding = strings.TrimSpace(part[:i])
			for param := range strings.SplitSeq(part[i+1:], ";") {
				param = strings.TrimSpace(param)
				if v, ok := strings.CutPrefix(param, "q="); ok {
					if f, err := strconv.ParseFloat(v, 64); err == nil {
						q = f
					}
				}
			}
		}
		switch coding {
		case "gzip":
			gzipListed = true
			if q > 0 {
				gzipOK = true
			}
		case "*":
			if q > 0 {
				wildcardOK = true
			}
		}
	}
	return gzipOK || (!gzipListed && wildcardOK)
}

// serveStaticAsset serves ONE known embedded static file under the S1 caching
// contract (page-load perf slice 1):
//
//   - content-hashed build assets (assets/ prefix in either embed) get
//     `Cache-Control: public, max-age=31536000, immutable`;
//   - every other static gets a strong content-hash ETag plus
//     `Cache-Control: no-cache`, and an If-None-Match hit short-circuits to a
//     304 with an empty body (the embed FS has a zero modtime, so ETag — not
//     Last-Modified — is the validator);
//   - text statics >= minGzipSize are served from the precomputed gzip body
//     when the request offers gzip (Vary: Accept-Encoding so intermediaries
//     key correctly); identity otherwise.
//
// Compression is scoped to THIS static path on purpose (BREACH): embedded
// asset bodies are build artifacts with no secret/reflected content, while
// dynamic handlers elsewhere reflect request data and must never be compressed
// here or anywhere by analogy. `serve` delegates the identity path to the
// owning FileServer, preserving its Content-Type detection, Range handling and
// HEAD semantics untouched; the gzip branch writes the precomputed bytes
// directly (a FileServer cannot emit them) with the same Content-Type the
// walk recorded.
func (s *Server) serveStaticAsset(w http.ResponseWriter, r *http.Request, m *staticAssetMeta, fsPath string, serve func(http.ResponseWriter, *http.Request)) {
	h := w.Header()
	if m.etag != "" {
		h.Set("ETag", `"`+m.etag+`"`)
	}
	if strings.HasPrefix(fsPath, "assets/") {
		h.Set("Cache-Control", staticCacheImmutable)
	} else {
		h.Set("Cache-Control", staticCacheRevalidate)
	}
	if m.gz != nil {
		// The representation depends on Accept-Encoding for this asset; Vary
		// must be present on BOTH variants (and the 304) for correct caching.
		h.Add("Vary", "Accept-Encoding")
	}
	// Conditional request: a matching validator means the cached body is
	// current — 304, no body, regardless of encoding eligibility.
	if etagStrongMatches(r.Header.Get("If-None-Match"), m.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	// Compressed path: precomputed gzip body. Range requests fall through to
	// the identity FileServer (range semantics over a re-encoded body would
	// need byte-range translation nobody asks of hashed SPA assets).
	if m.gz != nil && r.Header.Get("Range") == "" && acceptsGzip(r.Header.Get("Accept-Encoding")) {
		h.Set("Content-Type", m.ctype)
		h.Set("Content-Encoding", "gzip")
		h.Set("Content-Length", strconv.Itoa(len(m.gz)))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(m.gz)
		}
		return
	}
	serve(w, r)
}

// handleStatic serves the TWO embedded SPAs plus their static files:
//
//   - `/` and any unknown root path → the HOST shell (the default view). The host
//     is served at `/` so a solo operator who opens the binary immediately sees
//     the multi-server shell (which self-seeds the local server at `/app`).
//   - `/app` and `/app/*` → the SINGLE-SERVER SPA. Kept for direct access AND so
//     the host can embed the local server same-origin (the local self-seed points
//     its iframes at `/app`). The single-server SPA's own assets are root-level
//     (`/assets/`, `/sw.js`, `/manifest.webmanifest`, icons) — served below.
//   - `/host/*` → the host shell's namespaced assets (the folded host-web build
//     uses base `/host/` so its assets never collide with the single-server's
//     root-level `/assets/`).
//   - any other path that is a real single-server static file (`/assets/...`,
//     `/sw.js`, `/manifest.webmanifest`, `/icon.svg`, ...) → served from the
//     single-server dist FS.
//
// Both index pages prefer a real SPA shell (index.html, present only after an
// embed-producing target materialized a build) and fall back to the tracked
// placeholder.html so a cold `go build`/`go test` with NO frontend build serves a
// banner page instead of a directory listing. This does NOT rely on
// http.FileServer's directory-index/listing semantics (which would list the
// directory when index.html is absent).
//
// PWA/identity note: `/` is now the HOST (its title is "VHSolara · Host"); the
// single-server PWA identity moves to `/app`. The single-server service worker
// (`/sw.js`, scope `/`) is registered only by the single-server SPA but its
// scope covers the whole origin, so it EXCLUDES host routes (`/`, `/host/*`)
// from its fetch handler and precache — it caches only the single-server shell
// (at /app + /index.html) and never the online-only host shell. See
// web/public/sw.js (host-route exclusion) — the predicate mirrors isHostRoute.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Host shell's namespaced assets: `/host/<sub>` → host FS at <sub>. Only
	// mounted when the host shell is at root (production); in legacy/test mode
	// (hostShellAtRoot=false) `/host/*` falls through to the single-server.
	if s.hostShellAtRoot && strings.HasPrefix(path, "/host/") {
		sub := strings.TrimPrefix(path, "/host/")
		// `/host/` (the directory root) → host index; a known host asset →
		// served by the host FileServer; an unknown `/host/<x>` → host index
		// (SPA-history fallback; the host has no client router today, this is
		// defensive for any future host-side route).
		if sub == "" || sub == "index.html" {
			s.serveHostIndex(w, r)
			return
		}
		if m := s.hostAssetMeta(sub); m != nil {
			// Serve from the host FS at the stripped path. The host FileServer
			// was built over hostFS (rooted at "."), so rewrite r.URL.Path to
			// the stripped sub-path before delegating. The caching/compression
			// contract (immutable hashed assets, ETag+no-cache revalidation,
			// gzip for text statics) wraps the delegation — see
			// serveStaticAsset.
			r2 := newHTTPRequestPath(r, "/"+sub)
			s.serveStaticAsset(w, r, m, sub, func(w http.ResponseWriter, _ *http.Request) {
				s.hostStatic.ServeHTTP(w, r2)
			})
			return
		}
		s.serveHostIndex(w, r)
		return
	}

	// Single-server SPA entry: `/app` and any `/app/*` client route.
	// `/index.html` is the single-server shell too (the SW's documented shell
	// key — web/public/sw.js). It MUST NOT reach the dist FileServer below:
	// http.FileServer answers any `.../index.html` with `301 Location: ./`,
	// and `./` is `/` = the HOST shell under hostShellAtRoot — a fetch()
	// follows that redirect transparently (200), which is how the host shell
	// got cached as the /app pane document (host-in-host recursion).
	if path == "/app" || strings.HasPrefix(path, "/app/") || path == "/index.html" {
		s.serveAppIndex(w, r)
		return
	}

	// A real single-server static file at the root (`/assets/...`, `/sw.js`,
	// `/manifest.webmanifest`, `/icon.svg`, ...): serve it from the dist FS
	// under the static caching contract (see serveStaticAsset).
	if p := strings.TrimPrefix(path, "/"); p != "" {
		if m := s.distAssetMeta(p); m != nil {
			s.serveStaticAsset(w, r, m, p, func(w http.ResponseWriter, r *http.Request) {
				s.static.ServeHTTP(w, r)
			})
			return
		}
	}

	// `/favicon.ico`: browsers auto-request this at the origin root for ANY
	// page — a legacy fallback that runs EVEN when <link rel="icon"> is set.
	// Without a dedicated route it falls through to the SPA index (HTML),
	// which a browser cannot use as an icon. Serve the icon that matches `/`
	// ownership instead (see serveFavicon): the HOST icon in production
	// (hostShellAtRoot), the single-server icon in legacy/test. This does NOT
	// add a compile dependency on a built bundle — in cold-build/placeholder
	// mode the icon file is absent from the embed and the FileServer returns
	// 404 (acceptable; the placeholder banner renders with no icon).
	if path == "/favicon.ico" {
		s.serveFavicon(w, r)
		return
	}

	// `/` and any other unknown path:
	//   - production (hostShellAtRoot=true) → the HOST shell (the default view);
	//   - legacy/test (hostShellAtRoot=false) → the SINGLE-SERVER SPA (pre-fold).
	if s.hostShellAtRoot {
		s.serveHostIndex(w, r)
		return
	}
	s.serveAppIndex(w, r)
}

// serveHostIndex serves the HOST shell's index page: prefer a real host build
// (index.html, present after an embed-producing target materialized the host-web
// build), else the tracked placeholder.html cold-build banner. Both are served
// as text/html directly from the host embed FS.
//
// Shell routes are explicitly no-cache (S1): the shell HTML references the
// hashed bundles by URL, so it MUST be revalidated every load — an
// intermediary or heuristic cache serving a stale shell after a deploy would
// reference dead asset URLs. Static-asset caching lives on the asset routes,
// never here.
func (s *Server) serveHostIndex(w http.ResponseWriter, r *http.Request) {
	if data, err := fs.ReadFile(s.hostFS, "index.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", staticCacheRevalidate)
		_, _ = w.Write(data)
		return
	}
	if data, err := fs.ReadFile(s.hostFS, "placeholder.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", staticCacheRevalidate)
		_, _ = w.Write(data)
		return
	}
	http.NotFound(w, r)
}

// serveAppIndex serves the SINGLE-SERVER SPA's index page: prefer a real SPA
// build (index.html), else the tracked placeholder.html cold-build banner. Both
// are served as text/html directly from the single-server embed FS. Shell
// routes are explicitly no-cache for the same deploy-freshness reason as
// serveHostIndex (and the SW keeps its own network-first shell contract —
// web/public/sw.js).
func (s *Server) serveAppIndex(w http.ResponseWriter, r *http.Request) {
	if data, err := fs.ReadFile(s.staticFS, "index.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", staticCacheRevalidate)
		_, _ = w.Write(data)
		return
	}
	if data, err := fs.ReadFile(s.staticFS, "placeholder.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", staticCacheRevalidate)
		_, _ = w.Write(data)
		return
	}
	http.NotFound(w, r)
}

// serveFavicon serves `/favicon.ico` (the path browsers auto-request at the
// origin root for any page, a legacy fallback that bypasses <link rel="icon">).
// It serves the icon belonging to whichever shell owns `/`: the HOST icon.svg
// in production (hostShellAtRoot, served at `/`) via the host FileServer, or
// the single-server icon.svg in legacy/test mode via the single-server
// FileServer. The request path is rewritten to /icon.svg so the delegated
// FileServer serves the embedded icon with reused content-type detection
// (consistent with how the same FileServer serves /icon.svg for the
// single-server SPA). When the icon IS embedded it goes through the same
// static caching contract as every other static (ETag + no-cache + gzip when
// eligible). If the icon is absent from the embed (cold-build placeholder-only
// mode), the FileServer returns 404 — acceptable, and it adds no compile
// dependency on a built bundle. This mirrors `/` ownership, so the favicon is
// always consistent with the shell the operator actually sees.
func (s *Server) serveFavicon(w http.ResponseWriter, r *http.Request) {
	r2 := newHTTPRequestPath(r, "/icon.svg")
	if s.hostShellAtRoot {
		if m := s.hostAssetMeta("icon.svg"); m != nil {
			s.serveStaticAsset(w, r, m, "icon.svg", func(w http.ResponseWriter, _ *http.Request) {
				s.hostStatic.ServeHTTP(w, r2)
			})
			return
		}
		s.hostStatic.ServeHTTP(w, r2)
		return
	}
	if m := s.distAssetMeta("icon.svg"); m != nil {
		s.serveStaticAsset(w, r, m, "icon.svg", func(w http.ResponseWriter, _ *http.Request) {
			s.static.ServeHTTP(w, r2)
		})
		return
	}
	s.static.ServeHTTP(w, r2)
}

// newHTTPRequestPath clones r with the URL path rewritten to p (preserving
// RawQuery and the rest). Used so a delegated http.FileServer sees the
// prefix-stripped path it expects without mutating the caller's *http.Request.
func newHTTPRequestPath(r *http.Request, p string) *http.Request {
	r2 := r.Clone(r.Context())
	r2.URL = new(url.URL)
	*r2.URL = *r.URL
	r2.URL.Path = p
	return r2
}
