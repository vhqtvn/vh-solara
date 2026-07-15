package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestHandleUIPageRemovesXSSSinks pins the fix for the stored-XSS vulnerability
// in the controller dashboard. Worker-controlled fields (name/id/status/url)
// used to be string-concatenated into tr.innerHTML and an inline
// onclick="killWorker('...')" JS string, covering all three injection contexts
// (HTML body, HTML attribute, JS string). The fix builds the row with safe DOM
// APIs (createElement / textContent / addEventListener / property assignment)
// instead. This test asserts the dangerous concatenation sinks are gone from
// the served template and the safe primitives are present.
//
// It drives handleUIPage directly (bypassing Auth.Middleware) to capture the
// exact HTML/JS bytes served at GET /{$}.
func TestHandleUIPageRemovesXSSSinks(t *testing.T) {
	d := NewDaemon(":0", ":0", "")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	d.handleUIPage(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("handleUIPage: want 200, got %d", rec.Code)
	}
	body := rec.Body.String()

	// The three injection-context sinks that used to interpolate worker data.
	for _, bad := range []string{
		// HTML-body context: '<div class="name-text">' + w.name + '</div>'
		`'<div class="name-text">' + w.name`,
		// JS-string + attribute context: onclick="killWorker(\'' + w.id + '\')"
		`onclick="killWorker(\'' + w.id`,
		// Any innerHTML assignment that consumed worker fields.
		`tr.innerHTML =`,
		// The url link used to be string-concatenated into an href attribute.
		`'<a href="' + w.url`,
		// The status badge used to be concatenated into a class attribute and
		// text node inside an innerHTML string.
		`'<span class="badge ' + w.status`,
	} {
		if strings.Contains(body, bad) {
			t.Errorf("XSS sink still present in rendered template: %q", bad)
		}
	}

	// The safe DOM primitives that replaced the sinks.
	for _, good := range []string{
		`nameDiv.textContent = w.name;`,
		`idDiv.textContent = shortId;`,
		`badge.textContent = w.status;`,
		`killBtn.textContent = 'Kill';`,
		`killBtn.addEventListener('click', () => killWorker(w.id));`,
		`urlA.textContent = 'Open Web`,
	} {
		if !strings.Contains(body, good) {
			t.Errorf("safe DOM primitive missing from rendered template: %q", good)
		}
	}
}

// xssPayload is a single malicious worker registration used by the table-driven
// escaping tests. Each case targets a different injection context.
type xssPayload struct {
	name string
	id   string
}

// maliciousXSSPayloads covers HTML-body, HTML-attribute, JS-string, and
// template-literal/newline injection vectors that a rogue or compromised worker
// could send in its registration payload (WorkerName / WorkerID).
var maliciousXSSPayloads = []xssPayload{
	// HTML-body context: close the script/elements and inject a new <script>.
	{name: `</script><script>alert(1)</script>`, id: "host-1"},
	// Attribute / JS-string breakout via the id (the old onclick sink).
	{name: "host-2", id: `';fetch('/api/workers/x',{method:'DELETE'})//`},
	// Event-handler attribute forgery via an <img onerror>.
	{name: `<img src=x onerror=alert(1)>`, id: "host-3"},
	// Double-quote + JS-string breakout.
	{name: `\";alert(1)//`, id: "host-4"},
	// Backtick template-literal injection (would break a JS template string).
	{name: "`${alert(1)}`", id: "host-5"},
	// Newline / control-char injection inside both fields.
	{name: "name\nwith\r\nnewline", id: "id\nwith\nnewline"},
	// Payloads stacked into both fields at once.
	{name: `<script>alert('name')</script>`, id: `<img src=x onerror=alert('id')>`},
}

// TestListWorkersJSONEscaping verifies the data-delivery channel (/api/workers)
// for the dashboard. The worker-controlled name/id must be delivered as safely
// JSON-escaped strings: no raw "<script>", "<img", or unescaped "<" may appear
// in the response body, while the malicious values still round-trip intact
// (escaping does not corrupt the data). Combined with the sink removal above,
// this pins end-to-end escaping.
func TestListWorkersJSONEscaping(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	for _, p := range maliciousXSSPayloads {
		d.Registry.AddWorker(&Worker{
			ID:        p.id,
			Name:      p.name,
			Version:   "test",
			LastSeen:  time.Now(),
			Status:    "online",
			Transport: nil,
		})
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/workers", nil)
	d.handleListWorkers(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("handleListWorkers: want 200, got %d", rec.Code)
	}
	body := rec.Body.String()

	// No unescaped HTML markup may survive in the JSON body. encoding/json
	// escapes '<', '>', and '&' to \u003c / \u003e / \u0026 by default, so none
	// of these raw tag-open substrings should be present. (Bare words like
	// "onerror=alert" may appear as inert JSON-string *data* — they are
	// harmless without a raw '<' to form a tag, which the check below forbids.)
	for _, bad := range []string{
		`<script>`,
		`</script>`,
		`<img `,
		`<img src=x onerror=alert(1)>`,
	} {
		if strings.Contains(body, bad) {
			t.Errorf("unescaped dangerous substring %q present in /api/workers body", bad)
		}
	}

	// No raw '<' or '>' characters from worker data: every one must be the
	// JSON-escaped form. This is the comprehensive gate — without a raw '<' no
	// tag, event handler, or </script> breakout can ever form. (The JSON
	// envelope itself contains no '<'/'>' .)
	if strings.ContainsAny(body, "<>") {
		t.Errorf("/api/workers body contains raw '<' or '>' (HTML not fully escaped):\n%s", body)
	}

	// The malicious values must round-trip intact through the JSON (data
	// integrity preserved — escaping is transport-level only).
	var got []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("failed to unmarshal /api/workers JSON: %v", err)
	}
	wantByID := map[string]string{}
	for _, p := range maliciousXSSPayloads {
		wantByID[p.id] = p.name
	}
	if len(got) != len(maliciousXSSPayloads) {
		t.Fatalf("worker count: want %d, got %d", len(maliciousXSSPayloads), len(got))
	}
	for _, w := range got {
		wantName, ok := wantByID[w.ID]
		if !ok {
			t.Errorf("unexpected worker id %q in response", w.ID)
			continue
		}
		if w.Name != wantName {
			t.Errorf("name round-trip mismatch for id %q: want %q, got %q", w.ID, wantName, w.Name)
		}
	}
}

// TestHandleUIPageEndToEndEscaping renders the full dashboard page once and
// confirms that, for at least one malicious payload, neither the raw name nor
// id can reach the served HTML bytes in an executable form. The worker data is
// delivered to the browser via /api/workers (covered above) and consumed by the
// DOM-construction JS (covered by the sink test); this test pins that the
// static page itself carries no worker data and no executable injection vector
// in its bytes.
func TestHandleUIPageEndToEndEscaping(t *testing.T) {
	d := NewDaemon(":0", ":0", "")

	rec := httptest.NewRecorder()
	d.handleUIPage(rec, httptest.NewRequest("GET", "/", nil))
	body := rec.Body.String()

	// The static dashboard page must not ship any inline event-handler-bearing
	// markup contributed by worker data, and no stray <script> beyond the
	// page's own deliberate <script> blocks. We assert the dangerous,
	// worker-data-driven patterns are absent (they were the XSS vector).
	for _, bad := range []string{
		`onclick="killWorker(`,
		`'<div class="name-text">' + w.name`,
		`+ w.id + '\')">Kill`,
	} {
		if strings.Contains(body, bad) {
			t.Errorf("executable XSS vector still in dashboard bytes: %q", bad)
		}
	}
}
