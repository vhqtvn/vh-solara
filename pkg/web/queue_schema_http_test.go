package web

// Folded slice-1 defers (send-net-resilience slice 2a, item 7): HTTP-level
// proof of the queue-file conflict mappings through the REAL handler —
//
//   - a queue.json stamped with a NEWER schema version  → 409 +
//     code "queue_schema_newer" (this binary must not serve or reinterpret
//     a newer binary's file), and
//   - a corrupt/truncated queue.json                    → 500 +
//     code "queue_file_corrupt" (server-side data integrity; operator
//     investigates),
//
// both with BYTE-IDENTITY of the on-disk file across the request (no route
// may rewrite, "heal", or migrate the file it refused to understand — that
// is the AMEND-A4 valid-newer/partial-corrupt contract).
//
// These tests seed the file directly and drive the real Server handler via
// its HTTP routes (list GET + a mutation POST), because the store-level
// unit tests cannot prove the ROUTE wiring (writeQueueStoreErr mapping +
// status codes) — the FE feature-detects on exactly these codes.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// seedQueueFileRaw writes raw bytes as the session's queue.json (creating the
// session dir) and returns the path — the pre-existing-file seeder.
func seedQueueFileRaw(t *testing.T, root, sid string, content []byte) string {
	t.Helper()
	dir := filepath.Join(root, ".vh-solara", "sessions", sid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "queue.json")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// assertQueueFileUnchanged fails the test unless the file at path still
// holds exactly the want bytes (byte-identity across refused requests).
func assertQueueFileUnchanged(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("queue.json bytes changed across the refused request:\n got: %s\nwant: %s", got, want)
	}
}

// decodeQueueErr reads an error response body into ok/error/code.
func decodeQueueErr(t *testing.T, resp *http.Response) (ok bool, code string) {
	t.Helper()
	defer resp.Body.Close()
	var body struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return body.OK, body.Code
}

func TestQueueHTTPSchemaNewerMapping(t *testing.T) {
	web, root := newQueueTestServer(t)
	sid := "s_schema_newer"

	// A structurally valid queue.json whose version is NEWER than this
	// binary's queueSchemaVersion.
	newer, err := json.Marshal(queueFile{
		Version: queueSchemaVersion + 1,
		Order:   1,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := seedQueueFileRaw(t, root, sid, newer)

	// List: 409 + machine-readable code.
	resp, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusConflict {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("list status = %d (%s), want 409", resp.StatusCode, b)
	}
	okBody, code := decodeQueueErr(t, resp)
	if okBody {
		t.Fatal("ok=true on an error response")
	}
	if code != "queue_schema_newer" {
		t.Fatalf("code = %q, want queue_schema_newer", code)
	}
	assertQueueFileUnchanged(t, path, newer)

	// A mutation route must refuse identically (never reinterpret/rewrite).
	mut := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "must not land"})
	if mut.StatusCode != http.StatusConflict {
		b, _ := io.ReadAll(mut.Body)
		mut.Body.Close()
		t.Fatalf("enqueue status = %d (%s), want 409", mut.StatusCode, b)
	}
	_, code = decodeQueueErr(t, mut)
	if code != "queue_schema_newer" {
		t.Fatalf("enqueue code = %q, want queue_schema_newer", code)
	}
	assertQueueFileUnchanged(t, path, newer)
}

func TestQueueHTTPFileCorruptMapping(t *testing.T) {
	web, root := newQueueTestServer(t)
	sid := "s_file_corrupt"

	// A truncated/garbage queue.json (not valid JSON at all).
	corrupt := []byte(`{"version":1,"order":["q_a"],"items":{"q_a":{"id":"q_a","text":"tru`)
	path := seedQueueFileRaw(t, root, sid, corrupt)

	// List: 500 + machine-readable code (server-side integrity, NOT a client
	// conflict).
	resp, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusInternalServerError {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("list status = %d (%s), want 500", resp.StatusCode, b)
	}
	okBody, code := decodeQueueErr(t, resp)
	if okBody {
		t.Fatal("ok=true on an error response")
	}
	if code != "queue_file_corrupt" {
		t.Fatalf("code = %q, want queue_file_corrupt", code)
	}
	// The corrupt bytes are PRESERVED — the daemon never "heals" the file it
	// cannot parse (the operator's forensic evidence stays intact).
	assertQueueFileUnchanged(t, path, corrupt)

	// Mutation route: same refusal, same code, bytes still untouched.
	mut := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "must not land"})
	if mut.StatusCode != http.StatusInternalServerError {
		b, _ := io.ReadAll(mut.Body)
		mut.Body.Close()
		t.Fatalf("enqueue status = %d (%s), want 500", mut.StatusCode, b)
	}
	_, code = decodeQueueErr(t, mut)
	if code != "queue_file_corrupt" {
		t.Fatalf("enqueue code = %q, want queue_file_corrupt", code)
	}
	assertQueueFileUnchanged(t, path, corrupt)
}
