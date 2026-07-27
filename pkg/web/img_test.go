package web

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/http"
	"strings"
	"testing"
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
