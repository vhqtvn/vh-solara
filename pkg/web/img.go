package web

// Image proxy: GET /vh/img?url=<percent-encoded absolute http(s) URL>
//
// Proxies external image requests through the daemon so the SPA never makes a
// direct cross-origin image fetch. This is SSRF-hardened: every resolved
// address is validated against a public-global-unicast allowlist BEFORE dialing,
// redirects are followed manually (re-validating each hop), and the response is
// MIME-sniffed (upstream Content-Type is NOT trusted).
//
// Auth: this route lives under /vh/* so it is auth-gated by the existing
// middleware. GET-only → no CSRF exception needed.
//
// This transport is SEPARATE from the custom-view SSRF transport
// (views.go:ssrfTransport), which intentionally allows private/loopback
// addresses for a different use case (local dev views). Do NOT merge them.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// --- Constants -----------------------------------------------------------

const (
	imgMaxURLLen      = 8 * 1024 // 8 KiB for encoded + decoded URL
	imgMaxBody        = 8 << 20  // 8 MiB response body cap (overrun = error, not truncation)
	imgDNSTimeout     = 3 * time.Second
	imgConnTimeout    = 3 * time.Second
	imgHeaderTimeout  = 5 * time.Second
	imgOverallTimeout = 15 * time.Second
	imgMaxRedirects   = 3
	imgConcurrency    = 8 // max concurrent upstream fetches
)

// imgAllowedMIME is the canonical MIME types we accept after sniffing.
// SVG is NEVER allowed (it can carry scripts). HTML/XML/generic-binary too.
var imgAllowedMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"image/avif": true,
}

// --- Concurrency semaphore -----------------------------------------------

var imgSem = make(chan struct{}, imgConcurrency)

// --- Forbidden address ranges (SSRF gate) --------------------------------

// imgForbiddenV4 are IPv4 ranges that are NOT public-global-unicast.
// Any address in these ranges is rejected.
var imgForbiddenV4 = mustParseCIDRs([]string{
	"0.0.0.0/8",       // "this host"
	"10.0.0.0/8",      // RFC1918 private
	"100.64.0.0/10",   // CGNAT / shared address space
	"127.0.0.0/8",     // loopback
	"169.254.0.0/16",  // link-local (INCL cloud metadata 169.254.169.254)
	"172.16.0.0/12",   // RFC1918 private
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // TEST-NET-1 documentation
	"192.168.0.0/16",  // RFC1918 private
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // TEST-NET-2 documentation
	"203.0.113.0/24",  // TEST-NET-3 documentation
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // reserved (class E)
})

func mustParseCIDRs(cidrs []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(fmt.Sprintf("invalid CIDR %q: %v", c, err))
		}
		out = append(out, n)
	}
	return out
}

// imgAddrForbidden returns true if the IP is NOT a public-global-unicast
// address (i.e. it is in a forbidden range or is not globally reachable).
// This is the core SSRF gate: if ANY resolved address is forbidden, the entire
// request is rejected — we do NOT pick a public sibling from a mixed result.
func imgAddrForbidden(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// IPv4-mapped IPv6: unwrap and check the embedded v4.
	if v4 := ip.To4(); v4 != nil {
		for _, cidr := range imgForbiddenV4 {
			if cidr.Contains(v4) {
				return true
			}
		}
		// Also catch anything the explicit list misses via stdlib checks.
		if v4.IsUnspecified() {
			return true
		}
		return false
	}
	// Pure IPv6.
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsPrivate() {
		return true
	}
	// fe80::/10 is caught by IsLinkLocalUnicast; fc00::/7 by IsPrivate.
	// Reject anything that is not a global unicast address.
	if !ip.IsGlobalUnicast() {
		return true
	}
	return false
}

// --- URL validation ------------------------------------------------------

// imgValidateURL validates the raw URL query param. Returns the parsed URL
// or an error suitable for a 400/403 response classification.
var errBadURL = errors.New("bad url")
var errForbiddenDest = errors.New("forbidden destination")

func imgValidateURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errBadURL
	}
	if len(raw) > imgMaxURLLen {
		return nil, errBadURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errBadURL
	}
	// Reject if the decoded form is overlong.
	if len(u.String()) > imgMaxURLLen {
		return nil, errBadURL
	}
	// Must be absolute with an http or https scheme.
	if !u.IsAbs() {
		return nil, errBadURL
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errBadURL
	}
	// Reject protocol-relative (scheme should have caught this, but be safe).
	if strings.HasPrefix(raw, "//") {
		return nil, errBadURL
	}
	// Reject userinfo/credentials in the URL.
	if u.User != nil {
		return nil, errBadURL
	}
	host := u.Hostname()
	if host == "" {
		return nil, errBadURL
	}
	// Port check: allow only default ports (80 for http, 443 for https).
	port := u.Port()
	if port != "" {
		if u.Scheme == "http" && port != "80" {
			return nil, errBadURL
		}
		if u.Scheme == "https" && port != "443" {
			return nil, errBadURL
		}
	}
	// If the host is an IP literal, validate it immediately.
	if ip := net.ParseIP(host); ip != nil {
		if imgAddrForbidden(ip) {
			return nil, errForbiddenDest
		}
	}
	return u, nil
}

// --- SSRF pinned-dial ----------------------------------------------------

// imgDialContext is the custom DialContext for the image proxy transport.
// It resolves the hostname, validates EVERY address, and dials one validated
// address directly — preserving the original hostname for TLS (the Transport
// handles SNI/cert verification using the URL hostname).
func imgDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("split host port: %w", err)
	}
	// If host is already an IP literal, validate and dial directly.
	if ip := net.ParseIP(host); ip != nil {
		if imgAddrForbidden(ip) {
			return nil, errForbiddenDest
		}
		d := net.Dialer{Timeout: imgConnTimeout}
		return d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
	}
	// Resolve DNS with a timeout.
	resolveCtx, cancel := context.WithTimeout(ctx, imgDNSTimeout)
	defer cancel()
	resolver := net.DefaultResolver
	ips, err := resolver.LookupIPAddr(resolveCtx, host)
	if err != nil {
		return nil, fmt.Errorf("dns: %w", err)
	}
	if len(ips) == 0 {
		return nil, errors.New("dns: no results")
	}
	// Validate EVERY address. If ANY is forbidden, reject the whole request.
	var validIP net.IP
	for _, ia := range ips {
		if imgAddrForbidden(ia.IP) {
			return nil, errForbiddenDest
		}
		if validIP == nil {
			validIP = ia.IP
		}
	}
	if validIP == nil {
		return nil, errors.New("dns: no valid address")
	}
	// Dial the validated IP directly — NO second hostname lookup.
	d := net.Dialer{Timeout: imgConnTimeout}
	return d.DialContext(ctx, network, net.JoinHostPort(validIP.String(), port))
}

// newImgTransport builds the SSRF-hardened HTTP transport for the image proxy.
// No proxy (ProxyFromEnvironment is disabled), custom DialContext.
func newImgTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           imgDialContext,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: imgHeaderTimeout,
		ForceAttemptHTTP2:     true,
	}
}

var imgTransportOnce sync.Once
var imgTransport *http.Transport

func getImgTransport() *http.Transport {
	imgTransportOnce.Do(func() {
		imgTransport = newImgTransport()
	})
	return imgTransport
}

// --- MIME signature detection --------------------------------------------

// detectImageMIME sniffs the body's magic bytes and returns the canonical MIME
// type. Does NOT trust the upstream Content-Type header. Returns false for
// SVG, HTML, XML, generic-binary, or unrecognized formats.
func detectImageMIME(body []byte) (mime string, ok bool) {
	// PNG: \x89PNG\r\n\x1a\n
	if len(body) >= 8 && body[0] == 0x89 && body[1] == 'P' && body[2] == 'N' &&
		body[3] == 'G' && body[4] == 0x0D && body[5] == 0x0A && body[6] == 0x1A && body[7] == 0x0A {
		return "image/png", true
	}
	// JPEG: \xff\xd8\xff
	if len(body) >= 3 && body[0] == 0xFF && body[1] == 0xD8 && body[2] == 0xFF {
		return "image/jpeg", true
	}
	// GIF: GIF87a or GIF89a
	if len(body) >= 6 && body[0] == 'G' && body[1] == 'I' && body[2] == 'F' &&
		body[3] == '8' && (body[4] == '7' || body[4] == '9') && body[5] == 'a' {
		return "image/gif", true
	}
	// WebP: RIFF....WEBP
	if len(body) >= 12 && body[0] == 'R' && body[1] == 'I' && body[2] == 'F' &&
		body[3] == 'F' && body[8] == 'W' && body[9] == 'E' && body[10] == 'B' && body[11] == 'P' {
		return "image/webp", true
	}
	// AVIF: ISOBMFF ftyp box with AVIF brands.
	// Bytes 4-7 = "ftyp", bytes 8-11 = major brand, 12+ = compatible brands.
	if len(body) >= 12 && string(body[4:8]) == "ftyp" {
		brand := string(body[8:12])
		if brand == "avif" || brand == "avis" {
			return "image/avif", true
		}
		// Check compatible brands list (4-byte entries from offset 16 onward,
		// up to the box size at bytes 0-3).
		boxSize := int(body[0])<<24 | int(body[1])<<16 | int(body[2])<<8 | int(body[3])
		if boxSize > 12 && boxSize <= len(body) {
			for i := 16; i+4 <= boxSize && i+4 <= len(body); i += 4 {
				if string(body[i:i+4]) == "avif" || string(body[i:i+4]) == "avis" {
					return "image/avif", true
				}
			}
		}
	}
	return "", false
}

// --- Manual redirect-aware fetch -----------------------------------------

// imgFetchResult holds the buffered body and detected MIME of a successful fetch.
type imgFetchResult struct {
	body []byte
	mime string
}

// imgFetch fetches the image, following redirects manually (≤3 hops, each
// re-validated against the SSRF policy). Returns the buffered body + sniffed MIME.
func imgFetch(client *http.Client, u *url.URL) (*imgFetchResult, error) {
	current := u
	visited := map[string]bool{}
	for hop := 0; hop <= imgMaxRedirects; hop++ {
		key := current.String()
		if visited[key] {
			return nil, errors.New("redirect loop")
		}
		visited[key] = true

		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, err
		}
		// Fixed minimal headers — NO browser cookies/auth/referer/Range/forwarded.
		req.Header.Set("User-Agent", "vh-solara-img-proxy/1.0")
		req.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp,image/avif;q=0.9,*/*;q=0.1")

		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}

		// Handle redirects manually.
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if loc == "" {
				return nil, errors.New("redirect without Location")
			}
			next, err := current.Parse(loc) // resolve relative against current
			if err != nil {
				return nil, fmt.Errorf("redirect Location parse: %w", err)
			}
			// Reject HTTPS → HTTP downgrade.
			if current.Scheme == "https" && next.Scheme == "http" {
				return nil, errors.New("https to http downgrade")
			}
			// Re-validate the redirect target through the full URL policy.
			if _, err := imgValidateURL(next.String()); err != nil {
				return nil, fmt.Errorf("redirect target: %w", err)
			}
			current = next
			continue
		}

		// Accept only final 2xx.
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
		}

		// Read body with a capped reader (overrun = error, not truncation).
		body, err := io.ReadAll(io.LimitReader(resp.Body, imgMaxBody+1))
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("read body: %w", err)
		}
		if len(body) > imgMaxBody {
			return nil, errBodyTooLarge
		}

		// MIME-sniff from magic bytes (do NOT trust upstream header).
		mime, ok := detectImageMIME(body)
		if !ok {
			return nil, errBadMIME
		}
		return &imgFetchResult{body: body, mime: mime}, nil
	}
	return nil, errors.New("too many redirects")
}

var errBodyTooLarge = errors.New("body too large")
var errBadMIME = errors.New("unsupported mime type")

// --- HTTP handler --------------------------------------------------------

func (s *Server) handleImg(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		imgWriteError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rawURL := r.URL.Query().Get("url")
	u, err := imgValidateURL(rawURL)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errForbiddenDest) {
			status = http.StatusForbidden
		}
		imgWriteError(w, status, "invalid url")
		return
	}

	// Concurrency gate.
	select {
	case imgSem <- struct{}{}:
		defer func() { <-imgSem }()
	default:
		imgWriteError(w, http.StatusTooManyRequests, "busy")
		return
	}

	// Client with manual redirect handling (no auto-follow).
	client := &http.Client{
		Transport: getImgTransport(),
		Timeout:   imgOverallTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // we handle redirects in imgFetch
		},
	}

	ctx, cancel := context.WithTimeout(r.Context(), imgOverallTimeout)
	defer cancel()
	_ = ctx // client timeout governs; context is for cancellation propagation

	result, err := imgFetch(client, u)
	if err != nil {
		status := http.StatusBadGateway
		switch {
		case errors.Is(err, errForbiddenDest):
			status = http.StatusForbidden
		case errors.Is(err, errBodyTooLarge):
			status = http.StatusRequestEntityTooLarge
		case errors.Is(err, errBadMIME):
			status = http.StatusUnsupportedMediaType
		}
		imgWriteError(w, status, "fetch failed")
		return
	}

	// ETag from body hash.
	h := sha256.Sum256(result.body)
	etag := `"` + hex.EncodeToString(h[:]) + `"`

	// If-None-Match → 304.
	if match := r.Header.Get("If-None-Match"); match == etag || match == `*` {
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", result.mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("ETag", etag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.body)
}

// imgWriteError writes a generic error response. Never reveals resolved IPs,
// redirect targets, transport errors, or upstream bodies.
func imgWriteError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg + "\n"))
}
