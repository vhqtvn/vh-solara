package web

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// --- URL validation ------------------------------------------------------

func TestImgValidateURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		// Valid.
		{"http default port", "http://example.com/img.png", false},
		{"https default port", "https://example.com/img.png", false},
		{"http explicit 80", "http://example.com:80/img.png", false},
		{"https explicit 443", "https://example.com:443/img.png", false},
		{"with path and query", "https://example.com/path/img.png?w=100&h=200", false},

		// Missing / empty.
		{"empty", "", true},
		{"missing scheme", "example.com/img.png", true},

		// Wrong scheme.
		{"data scheme", "data:image/png;base64,iVBOR", true},
		{"file scheme", "file:///etc/passwd", true},
		{"blob scheme", "blob:https://example.com/abc", true},
		{"javascript scheme", "javascript:alert(1)", true},
		{"ftp scheme", "ftp://example.com/file", true},
		{"vh-attach scheme", "vh-attach:abc123", true},

		// Protocol-relative.
		{"protocol-relative", "//example.com/img.png", true},

		// Userinfo / credentials.
		{"with userinfo", "http://user:pass@example.com/img.png", true},
		{"with user only", "http://user@example.com/img.png", true},

		// Non-default ports.
		{"http port 8080", "http://example.com:8080/img.png", true},
		{"https port 8443", "https://example.com:8443/img.png", true},
		{"http port 443", "http://example.com:443/img.png", true},
		{"https port 80", "https://example.com:80/img.png", true},

		// Overlong.
		{"overlong url", "http://example.com/" + string(make([]byte, 9000)), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := imgValidateURL(tc.raw)
			if (err != nil) != tc.wantErr {
				t.Fatalf("imgValidateURL(%q) err=%v, wantErr=%v", tc.raw, err, tc.wantErr)
			}
		})
	}
}

// --- Address policy (SSRF gate) ------------------------------------------

func TestImgAddrForbidden(t *testing.T) {
	// Forbidden IPv4 ranges.
	forbidden := []string{
		"0.0.0.0", "0.0.0.1",
		"10.0.0.1", "10.255.255.255",
		"100.64.0.1", // CGNAT
		"127.0.0.1", "127.255.255.255",
		"169.254.0.1", "169.254.169.254", // link-local + cloud metadata
		"172.16.0.1", "172.31.255.255",
		"192.0.0.1",   // IETF assignments
		"192.0.2.1",   // TEST-NET-1
		"192.168.1.1", // RFC1918
		"198.18.0.1",  // benchmarking
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1", // multicast
		"240.0.0.1", // reserved
		"255.255.255.255",
	}
	for _, ip := range forbidden {
		t.Run("forbidden/"+ip, func(t *testing.T) {
			if !imgAddrForbidden(parseIP(ip)) {
				t.Fatalf("%s should be forbidden", ip)
			}
		})
	}

	// Allowed (public-global-unicast) IPv4.
	allowed := []string{
		"1.1.1.1",
		"8.8.8.8",
		"93.184.216.34", // example.com
		"172.15.0.1",    // just below RFC1918 172.16/12
		"172.32.0.1",    // just above RFC1918 172.16/12
		"11.0.0.1",      // just above 10/8
	}
	for _, ip := range allowed {
		t.Run("allowed/"+ip, func(t *testing.T) {
			if imgAddrForbidden(parseIP(ip)) {
				t.Fatalf("%s should be allowed", ip)
			}
		})
	}

	// Forbidden IPv6.
	forbiddenV6 := []string{
		"::",      // unspecified
		"::1",     // loopback
		"fe80::1", // link-local
		"fc00::1", // ULA
		"fd00::1", // ULA
		"ff00::1", // multicast
		"ff02::1", // link-local multicast
	}
	for _, ip := range forbiddenV6 {
		t.Run("forbidden/"+ip, func(t *testing.T) {
			if !imgAddrForbidden(parseIP(ip)) {
				t.Fatalf("%s should be forbidden", ip)
			}
		})
	}

	// IPv4-mapped IPv6 whose v4 is forbidden.
	mappedForbidden := []string{
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"::ffff:169.254.169.254",
	}
	for _, ip := range mappedForbidden {
		t.Run("forbidden_mapped/"+ip, func(t *testing.T) {
			if !imgAddrForbidden(parseIP(ip)) {
				t.Fatalf("%s should be forbidden (mapped v4)", ip)
			}
		})
	}
}

// --- MIME signature detection --------------------------------------------

func TestDetectImageMIME(t *testing.T) {
	tests := []struct {
		name     string
		body     []byte
		wantMIME string
		wantOK   bool
	}{
		{"PNG", append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, []byte("rest")...), "image/png", true},
		{"JPEG", []byte{0xFF, 0xD8, 0xFF, 0xE0}, "image/jpeg", true},
		{"GIF87a", []byte("GIF87a" + "\x00\x00"), "image/gif", true},
		{"GIF89a", []byte("GIF89a" + "\x00\x00"), "image/gif", true},
		{"WebP", []byte("RIFF\x00\x00\x00\x00WEBP"), "image/webp", true},
		{"AVIF major", makeAVIFBody("avif", nil), "image/avif", true},
		{"AVIF compat", makeAVIFBody("mif1", []string{"avif"}), "image/avif", true},

		// Rejected formats.
		{"SVG", []byte("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "", false},
		{"HTML", []byte("<html><body>hello</body></html>"), "", false},
		{"XML", []byte("<?xml version='1.0'?><foo/>"), "", false},
		{"empty", []byte{}, "", false},
		{"short garbage", []byte{0x00, 0x01}, "", false},
		{"random binary", []byte{0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03}, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mime, ok := detectImageMIME(tc.body)
			if ok != tc.wantOK || mime != tc.wantMIME {
				t.Fatalf("detectImageMIME() = (%q, %v), want (%q, %v)", mime, ok, tc.wantMIME, tc.wantOK)
			}
		})
	}
}

// makeAVIFBody constructs a minimal ISOBMFF ftyp box for AVIF detection.
func makeAVIFBody(major string, compat []string) []byte {
	var brands []byte
	brands = append(brands, []byte(major)...)
	brands = append(brands, 0, 0, 0, 0) // minor version
	for _, b := range compat {
		brands = append(brands, []byte(b)...)
	}
	boxBody := append([]byte("ftyp"), brands...)
	size := uint32(4 + len(boxBody)) // 4-byte size prefix + body
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, size)
	return append(append(buf, boxBody...), []byte("rest")...)
}

// --- Handler-level tests (error paths) -----------------------------------

func TestHandleImgErrorPaths(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	tests := []struct {
		name       string
		url        string
		wantStatus int
	}{
		{"missing url param", ws.URL + "/vh/img", 400},
		{"empty url", ws.URL + "/vh/img?url=", 400},
		{"relative url", ws.URL + "/vh/img?url=/foo.png", 400},
		{"data url", ws.URL + "/vh/img?url=data:image/png;base64,abc", 400},
		{"file url", ws.URL + "/vh/img?url=file:///etc/passwd", 400},
		{"javascript url", ws.URL + "/vh/img?url=javascript:alert(1)", 400},
		{"non-default port", ws.URL + "/vh/img?url=http://example.com:8080/x.png", 400},
		{"userinfo", ws.URL + "/vh/img?url=http://u:p@example.com/x.png", 400},
		{"loopback IP", ws.URL + "/vh/img?url=http://127.0.0.1/x.png", 403},
		{"RFC1918 IP", ws.URL + "/vh/img?url=http://10.0.0.1/x.png", 403},
		{"metadata IP", ws.URL + "/vh/img?url=http://169.254.169.254/x.png", 403},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Get(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("%s: got status %d, want %d", tc.name, resp.StatusCode, tc.wantStatus)
			}
			// Error responses must have Cache-Control: no-store.
			if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
				t.Fatalf("%s: Cache-Control=%q, want no-store", tc.name, cc)
			}
		})
	}
}

// --- Concurrency limit ---------------------------------------------------

func TestHandleImgConcurrencyExhausted(t *testing.T) {
	// Fill the semaphore so the next request gets 429.
	for i := 0; i < imgConcurrency; i++ {
		imgSem <- struct{}{}
	}
	defer func() {
		for i := 0; i < imgConcurrency; i++ {
			<-imgSem
		}
	}()

	ws := newWebServer(t)
	defer ws.Close()

	resp, err := http.Get(ws.URL + "/vh/img?url=https://example.com/img.png")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 429 {
		t.Fatalf("concurrency exhausted: got %d, want 429", resp.StatusCode)
	}
}

// --- Cache headers -------------------------------------------------------

func TestHandleImgErrorCacheHeaders(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// 403 response must have no-store and nosniff.
	resp, err := http.Get(ws.URL + "/vh/img?url=http://127.0.0.1/x.png")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", cc)
	}
	if xcto := resp.Header.Get("X-Content-Type-Options"); xcto != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q, want nosniff", xcto)
	}
}

// helper: parse IP without panicking on test setup.
func parseIP(s string) net.IP {
	ip := net.ParseIP(s)
	if ip == nil {
		panic("bad ip in test: " + s)
	}
	return ip
}

// detectImageMIME parity check: PNG signature must survive truncation at 8.
func TestDetectImageMIMETruncatedSignatures(t *testing.T) {
	// Truncated PNG (fewer than 8 bytes) must NOT match.
	short := []byte{0x89, 'P', 'N'}
	if _, ok := detectImageMIME(short); ok {
		t.Fatal("truncated PNG should not match")
	}
	// Truncated JPEG (fewer than 3 bytes).
	shortJ := []byte{0xFF, 0xD8}
	if _, ok := detectImageMIME(shortJ); ok {
		t.Fatal("truncated JPEG should not match")
	}
}

// Ensure the error body is generic and does not leak internal details.
func TestHandleImgErrorBodyGeneric(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	resp, err := http.Get(ws.URL + "/vh/img?url=http://10.0.0.1/x.png")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	body := buf.String()
	// Must NOT contain IP addresses, DNS info, or transport details.
	for _, secret := range []string{"10.0.0.1", "dns", "resolve", "dial"} {
		if strings.Contains(strings.ToLower(body), strings.ToLower(secret)) {
			t.Fatalf("error body leaks %q: %q", secret, body)
		}
	}
}

// ============================================================================
// CRUX 1 — dial-time IP pinning (imgDialContextWith seam).
//
// These tests inject a recording resolver + dial and assert the OUTCOME of the
// pinned-dial behavior: no public-sibling picking from a mixed list; the dialed
// address is the validated IP LITERAL (no rebind); the IP-literal fast path
// validates before dial; production defaults are wired. NO real network/DNS.
//
// NOTE on IP choice: the test plan named 203.0.113.1 as the "valid public"
// target, but 203.0.113.0/24 is TEST-NET-3 and is explicitly forbidden by
// imgForbiddenV4 (img.go). We use 93.184.216.34 (example.com — genuinely
// public-global-unicast, already in the allowed list above) instead.
// ============================================================================

// TestImgDialContext_RejectsMixedAddressList proves the policy "reject if ANY
// resolved address is forbidden" — a public sibling MUST NOT be dialed when a
// forbidden address shares the result list.
func TestImgDialContext_RejectsMixedAddressList(t *testing.T) {
	dialCalled := false
	cfg := imgDialConfig{
		resolver: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("93.184.216.34")}, // public-global-unicast
				{IP: net.ParseIP("10.0.0.1")},      // RFC1918 forbidden
			}, nil
		},
		dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialCalled = true
			return nil, errors.New("dial must not be reached")
		},
	}
	_, err := imgDialContextWith(cfg)(context.Background(), "tcp", "example.com:80")
	if !errors.Is(err, errForbiddenDest) {
		t.Fatalf("mixed address list: err=%v, want errForbiddenDest (reject if ANY addr forbidden)", err)
	}
	if dialCalled {
		t.Fatal("dial must NOT be called when any resolved address is forbidden — no public-sibling picking")
	}
}

// TestImgDialContext_PinsValidatedLiteral_NoRebind is THE crux: it proves the
// dialed address is the validated IP LITERAL and that no second DNS lookup
// happens at dial time (closing the rebind/TOCTOU window). A stateful resolver
// returns a valid public IP on call 1 and a forbidden IP on call 2 (simulated
// rebind); the recording dial captures the literal it was handed.
func TestImgDialContext_PinsValidatedLiteral_NoRebind(t *testing.T) {
	resolverCalls := 0
	var dialed []string
	cfg := imgDialConfig{
		resolver: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			resolverCalls++
			if resolverCalls == 1 {
				return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil // valid public
			}
			// Call 2 would only happen if dial re-resolved the hostname — a
			// rebind. It MUST NOT happen.
			return []net.IPAddr{{IP: net.ParseIP("10.0.0.1")}}, nil // forbidden (the rebind)
		},
		dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialed = append(dialed, addr)
			return nil, errors.New("sentinel: dial reached")
		},
	}
	_, err := imgDialContextWith(cfg)(context.Background(), "tcp", "example.com:80")
	// The sentinel error proves dial was actually reached (not short-circuited).
	if err == nil || !strings.Contains(err.Error(), "sentinel") {
		t.Fatalf("err=%v, want the sentinel error proving dial was actually reached", err)
	}
	if resolverCalls != 1 {
		t.Fatalf("resolver calls = %d, want exactly 1 (no second lookup at dial time → rebind impossible)", resolverCalls)
	}
	want := []string{"93.184.216.34:80"}
	if len(dialed) != 1 || dialed[0] != want[0] {
		t.Fatalf("dialed = %v, want %v (the validated IP LITERAL, NOT the hostname)", dialed, want)
	}
}

// TestImgDialContext_IPLiteralShortcut proves the IP-literal fast path validates
// BEFORE any resolution/dial: a forbidden IP literal is rejected without calling
// resolver or dial, and a valid IP literal is dialed by its literal directly.
func TestImgDialContext_IPLiteralShortcut(t *testing.T) {
	// Forbidden IP literal → errForbiddenDest, resolver/dial never called.
	resolverCalled := false
	dialCalled := false
	cfg := imgDialConfig{
		resolver: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			resolverCalled = true
			return nil, errors.New("resolver must not be reached")
		},
		dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialCalled = true
			return nil, errors.New("dial must not be reached")
		},
	}
	_, err := imgDialContextWith(cfg)(context.Background(), "tcp", "169.254.169.254:80")
	if !errors.Is(err, errForbiddenDest) {
		t.Fatalf("169.254.169.254:80 err=%v, want errForbiddenDest", err)
	}
	if resolverCalled || dialCalled {
		t.Fatal("resolver/dial must NOT be called for a forbidden IP literal (validate before dial)")
	}

	// Valid IP literal → dial called with that literal (no resolution).
	var dialed string
	cfg2 := imgDialConfig{
		resolver: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			t.Fatal("resolver must not be called for an IP literal")
			return nil, nil
		},
		dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialed = addr
			return nil, errors.New("sentinel")
		},
	}
	_, err = imgDialContextWith(cfg2)(context.Background(), "tcp", "93.184.216.34:80")
	if err == nil || !strings.Contains(err.Error(), "sentinel") {
		t.Fatalf("93.184.216.34:80 err=%v, want sentinel proving dial was reached", err)
	}
	if dialed != "93.184.216.34:80" {
		t.Fatalf("dialed = %q, want 93.184.216.34:80 (valid IP literal passed straight to dial)", dialed)
	}
}

// TestImgDialContext_ProductionDefaultsUnchanged is a regression guard against
// accidental default rewiring. It asserts imgDialDefaults is wired (non-nil
// resolver+dial) AND that the production resolver honors the parent ctx — a
// cancelled ctx must surface as a context error through the production path
// WITHOUT performing real DNS (the cancelled ctx short-circuits LookupIPAddr).
func TestImgDialContext_ProductionDefaultsUnchanged(t *testing.T) {
	if imgDialDefaults.resolver == nil {
		t.Fatal("imgDialDefaults.resolver must be wired (net.DefaultResolver path)")
	}
	if imgDialDefaults.dial == nil {
		t.Fatal("imgDialDefaults.dial must be wired (net.Dialer path)")
	}
	// Behavioral: the production resolver respects the parent ctx. A cancelled
	// ctx must short-circuit through the timeout wrap into LookupIPAddr and
	// return a context error. This proves the default resolver is wired to a
	// ctx-honoring path (not a stub that ignores ctx) — the same observation that
	// covers the E4 timeout-relocation preservation.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := imgDialDefaults.resolver(ctx, "example.com")
	if err == nil {
		t.Fatal("production resolver with cancelled ctx must return an error (ctx propagation through the timeout wrap)")
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("production resolver err with cancelled ctx = %v, want a context error", err)
	}
}

// TestImgDialContext_DNSTimeoutRelocationPreservesCtx is the focused E4
// preservation test. The DNS-timeout wrapping was relocated from inline in the
// dial body into imgDialDefaults.resolver. This observes the OUTCOME that the
// relocation preserved context propagation: a cancelled parent ctx surfaces as a
// context error PROMPTLY (the wrap neither swallows nor detaches the parent's
// cancellation, and it does not block for imgDNSTimeout). No real DNS: the
// cancelled ctx short-circuits LookupIPAddr before any network I/O.
func TestImgDialContext_DNSTimeoutRelocationPreservesCtx(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, err := imgDialDefaults.resolver(ctx, "example.com")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("production resolver must surface parent cancellation as an error (timeout wrap preserved ctx propagation)")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("resolver err = %v, want context.Canceled (parent cancellation propagated through the relocated wrap)", err)
	}
	// Outcome: cancellation propagated promptly — it did NOT wait imgDNSTimeout
	// (3s). A generous bound keeps the test robust on a loaded CI box while
	// still proving the ctx short-circuited rather than timing out.
	if elapsed > time.Second {
		t.Fatalf("resolver with cancelled ctx took %v; cancellation did not propagate promptly (expected sub-second)", elapsed)
	}
}

// ============================================================================
// CRUX 2 — redirect-hop re-validation (imgFetch with a stub RoundTripper).
//
// These tests build an http.Client whose Transport is a stub RoundTripper and
// whose CheckRedirect returns http.ErrUseLastResponse (mirroring the production
// handler at img.go), then drive imgFetch directly. ZERO production change:
// imgFetch already accepts *http.Client.
// ============================================================================

// imgStubRT is a function adapter implementing http.RoundTripper.
type imgStubRT func(*http.Request) (*http.Response, error)

func (f imgStubRT) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

// newStubFetchClient builds an http.Client that never auto-follows redirects
// (production's CheckRedirect contract) routed through rt.
func newStubFetchClient(rt http.RoundTripper) *http.Client {
	return &http.Client{
		Transport: rt,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// imgResp builds a minimal *http.Response for the stub RoundTripper.
func imgResp(status int, headers map[string]string, body []byte) *http.Response {
	r := &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewReader(body)),
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// imgPNG is a minimal valid PNG body (magic bytes + payload).
var imgPNG = append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, []byte("payload")...)

// TestImgFetch_RedirectToForbiddenIPLiteral_RejectedPerHop proves each redirect
// Location is re-validated through imgValidateURL (img.go) — a 302 to a
// forbidden IP literal is caught BEFORE any dial.
func TestImgFetch_RedirectToForbiddenIPLiteral_RejectedPerHop(t *testing.T) {
	for _, loc := range []string{
		"http://169.254.169.254/", // cloud metadata / link-local
		"http://10.0.0.1/",        // RFC1918
		"http://127.0.0.1/",       // loopback
	} {
		u := mustParseURL(t, "http://example.com/x")
		rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
			return imgResp(http.StatusFound, map[string]string{"Location": loc}, nil), nil
		})
		_, err := imgFetch(newStubFetchClient(rt), u)
		if !errors.Is(err, errForbiddenDest) {
			t.Fatalf("redirect to %s: err=%v, want errForbiddenDest (per-hop re-validation)", loc, err)
		}
	}
}

// TestImgFetch_HTTPStoHTTPDowngrade_Rejected proves an HTTPS→HTTP redirect is
// rejected (no protocol downgrade).
func TestImgFetch_HTTPStoHTTPDowngrade_Rejected(t *testing.T) {
	u := mustParseURL(t, "https://target/x")
	rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
		return imgResp(http.StatusFound, map[string]string{"Location": "http://target/y"}, nil), nil
	})
	_, err := imgFetch(newStubFetchClient(rt), u)
	if err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("err=%v, want an https-to-http downgrade rejection", err)
	}
}

// TestImgFetch_RedirectLoop_Rejected proves a self-referential redirect is
// detected as a loop.
func TestImgFetch_RedirectLoop_Rejected(t *testing.T) {
	u := mustParseURL(t, "http://example.com/x")
	rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
		// Always redirect to the same path → resolves to the same URL as the start.
		return imgResp(http.StatusFound, map[string]string{"Location": "/x"}, nil), nil
	})
	_, err := imgFetch(newStubFetchClient(rt), u)
	if err == nil || !strings.Contains(err.Error(), "loop") {
		t.Fatalf("err=%v, want a redirect-loop rejection", err)
	}
}

// TestImgFetch_TooManyRedirects_Rejected proves the ≤3-hop cap fires when the
// upstream keeps issuing fresh redirect Locations.
func TestImgFetch_TooManyRedirects_Rejected(t *testing.T) {
	u := mustParseURL(t, "http://example.com/start")
	calls := 0
	rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
		calls++
		return imgResp(http.StatusFound, map[string]string{"Location": fmt.Sprintf("http://example.com/hop%d", calls)}, nil), nil
	})
	_, err := imgFetch(newStubFetchClient(rt), u)
	if err == nil || !strings.Contains(err.Error(), "too many redirects") {
		t.Fatalf("err=%v, want a too-many-redirects rejection", err)
	}
}

// TestImgFetch_MultiHopLegit_Succeeds proves a legitimate multi-hop chain is
// followed and the final body is MIME-re-sniffed after the redirect.
func TestImgFetch_MultiHopLegit_Succeeds(t *testing.T) {
	u := mustParseURL(t, "http://example.com/x")
	calls := 0
	rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			// http → https upgrade (allowed) to a different host.
			return imgResp(http.StatusFound, map[string]string{"Location": "https://other/x"}, nil), nil
		}
		return imgResp(http.StatusOK, nil, imgPNG), nil
	})
	res, err := imgFetch(newStubFetchClient(rt), u)
	if err != nil {
		t.Fatalf("err=%v, want nil (legit multi-hop chain should succeed)", err)
	}
	if res.mime != "image/png" {
		t.Fatalf("mime=%q, want image/png (re-sniffed after redirect)", res.mime)
	}
	if !bytes.Equal(res.body, imgPNG) {
		t.Fatalf("body mismatch: got %d bytes, want the stub PNG payload", len(res.body))
	}
	if calls != 2 {
		t.Fatalf("stub calls = %d, want 2 (one redirect hop + one final)", calls)
	}
}

// TestImgFetch_NeverForwardsUpstreamCredentials proves imgFetch sends only its
// fixed minimal headers — no Cookie/Authorization/Range (which would forward
// operator credentials or ranges upstream).
func TestImgFetch_NeverForwardsUpstreamCredentials(t *testing.T) {
	u := mustParseURL(t, "http://example.com/x")
	var got http.Header
	rt := imgStubRT(func(req *http.Request) (*http.Response, error) {
		got = req.Header.Clone()
		return imgResp(http.StatusOK, nil, imgPNG), nil
	})
	if _, err := imgFetch(newStubFetchClient(rt), u); err != nil {
		t.Fatal(err)
	}
	for _, h := range []string{"Cookie", "Authorization", "Range"} {
		if v := got.Get(h); v != "" {
			t.Fatalf("request forwarded %s=%q; img proxy must NOT send upstream credentials/range", h, v)
		}
	}
}

// mustParseURL parses raw or fails the test.
func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("bad test URL %q: %v", raw, err)
	}
	return u
}
